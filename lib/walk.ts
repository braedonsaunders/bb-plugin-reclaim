/**
 * The filesystem walker.
 *
 * Design notes, because this is the part the previous plugin got wrong:
 *
 * - **No entry budget.** The old plugin stopped after 500k entries and flagged
 *   the result `truncated`, which silently under-reported every total. This
 *   walker visits the whole tree; on a 460GB APFS volume that is ~6.7M entries
 *   in ~75s, which is a background job, not a per-click cost.
 * - **Exact aggregation without recursion.** Frames carry a `pending` child
 *   count; a directory rolls into its parent the moment its own read finished
 *   AND every child completed. Memory stays proportional to the in-flight
 *   frontier, not to the tree, and rows stream out post-order.
 * - **Hardlinks count once.** `/System` and Homebrew are full of them; without
 *   dev:ino dedup a full-volume scan over-reports by several GB (measured: 494.1GB
 *   against a 487.1GB container).
 * - **Opaque directories.** `node_modules` and `.git` hold most of the
 *   directories on a dev machine and none of the interesting structure. They
 *   are still walked for exact bytes, but stored as one row.
 */
import { opendir, lstat } from "node:fs/promises";
import { join } from "node:path";

/**
 * Directories measured exactly but stored as a single row.
 *
 * Every name here is either something you would never browse into or something
 * Reclaim only ever offers as a whole unit. Note what is deliberately absent:
 * `.cargo`, `.gradle` and `.rustup` hold reclaimable *sub*directories, so they
 * stay transparent even though they are large.
 */
export const DEFAULT_OPAQUE_NAMES = new Set([
  "node_modules",
  ".git",
  ".venv",
  "venv",
  "__pycache__",
  "Pods",
  "DerivedData",
  ".terraform",
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".pytest_cache",
  ".mypy_cache",
]);

/**
 * Paths never descended into. `/System/Volumes/Data` is the firmlink twin of
 * `/` — walking both double-counts the entire user volume. The rest are
 * synthetic, autofs, or per-boot mounts with nothing reclaimable in them.
 */
export const DEFAULT_SKIP_PATHS = new Set([
  "/System/Volumes/Data",
  "/System/Volumes/Update",
  "/System/Volumes/Preboot",
  "/System/Volumes/xarts",
  "/System/Volumes/iSCPreboot",
  "/System/Volumes/Hardware",
  "/Volumes",
  "/dev",
  "/net",
  "/home",
  "/proc",
  "/sys",
  "/.vol",
  "/.Spotlight-V100",
  "/.fseventsd",
]);

export const DEFAULT_CONCURRENCY = 48;
/** How many of the biggest files to remember across the whole walk. */
export const DEFAULT_TOP_FILES = 500;
const PROGRESS_INTERVAL_MS = 250;

export interface DirRecord {
  id: number;
  parentId: number | null;
  path: string;
  name: string;
  depth: number;
  /** Bytes of files directly inside this directory. */
  selfBytes: number;
  /** Bytes of the whole subtree, hardlinks counted once. */
  treeBytes: number;
  /**
   * Files counted toward `treeBytes`. A hardlink already seen elsewhere is
   * excluded from both, so the count and the size always describe the same set.
   */
  treeFiles: number;
  treeDirs: number;
  /** Newest mtime anywhere in the subtree — the staleness signal. */
  newestMtimeMs: number;
  opaque: boolean;
}

export interface FileRecord {
  path: string;
  bytes: number;
  mtimeMs: number;
}

export interface WalkProgress {
  currentPath: string;
  entriesSeen: number;
  filesSeen: number;
  dirsSeen: number;
  bytesSeen: number;
  unreadable: number;
  elapsedMs: number;
  entriesPerSecond: number;
}

export interface WalkOptions {
  root: string;
  concurrency?: number;
  opaqueNames?: ReadonlySet<string>;
  skipPaths?: ReadonlySet<string>;
  topFiles?: number;
  signal?: AbortSignal;
  onProgress?: (progress: WalkProgress) => void;
  /** Called post-order with completed directories. Batch your writes here. */
  onDirectory: (record: DirRecord) => void;
}

export interface WalkResult {
  root: string;
  rootId: number | null;
  totalBytes: number;
  filesSeen: number;
  dirsSeen: number;
  dirsStored: number;
  unreadable: number;
  durationMs: number;
  aborted: boolean;
  /** Biggest individual files, descending. */
  topFiles: FileRecord[];
}

interface Frame {
  id: number;
  path: string;
  name: string;
  depth: number;
  parent: Frame | null;
  /** Nearest stored ancestor's id; null at the root. */
  parentId: number | null;
  /** Inside an opaque subtree, so this frame is measured but not stored. */
  hidden: boolean;
  opaque: boolean;
  selfBytes: number;
  treeBytes: number;
  treeFiles: number;
  treeDirs: number;
  newestMtimeMs: number;
  pending: number;
  read: boolean;
}

/** Bounded collection of the largest files, without sorting on every insert. */
class TopFiles {
  private items: FileRecord[] = [];
  private floor = 0;
  // Written as an explicit field rather than a constructor parameter property:
  // BB loads a path-installed plugin as TypeScript directly, and Node's
  // strip-only mode rejects parameter properties.
  private readonly limit: number;

  constructor(limit: number) {
    this.limit = limit;
  }

  offer(record: FileRecord): void {
    if (this.limit === 0) return;
    if (this.items.length >= this.limit && record.bytes <= this.floor) return;
    this.items.push(record);
    if (this.items.length >= this.limit * 2) this.compact();
  }

  private compact(): void {
    this.items.sort((a, b) => b.bytes - a.bytes);
    this.items.length = Math.min(this.items.length, this.limit);
    this.floor = this.items[this.items.length - 1]?.bytes ?? 0;
  }

  drain(): FileRecord[] {
    this.compact();
    return this.items;
  }
}

export async function walk(options: WalkOptions): Promise<WalkResult> {
  const {
    root,
    concurrency = DEFAULT_CONCURRENCY,
    opaqueNames = DEFAULT_OPAQUE_NAMES,
    skipPaths = DEFAULT_SKIP_PATHS,
    topFiles: topFileLimit = DEFAULT_TOP_FILES,
    signal,
    onProgress,
    onDirectory,
  } = options;

  const startedAt = Date.now();
  const stack: Frame[] = [];
  const top = new TopFiles(topFileLimit);
  /** dev:ino of every multiply-linked file already counted. */
  const seenLinks = new Set<string>();

  let nextId = 1;
  let active = 0;
  let filesSeen = 0;
  let dirsSeen = 0;
  let dirsStored = 0;
  let unreadable = 0;
  let bytesSeen = 0;
  let lastProgressAt = 0;
  let currentPath = root;
  /** Set when the root settles; null means the walk never completed. */
  let rootBytes: number | null = null;
  let rootId: number | null = null;
  let aborted = false;

  const makeFrame = (
    path: string,
    name: string,
    depth: number,
    parent: Frame | null,
    hidden: boolean,
    opaque: boolean,
  ): Frame => {
    const stored = !hidden;
    if (stored) dirsStored += 1;
    return {
      id: stored ? nextId++ : -1,
      path,
      name,
      depth,
      parent,
      parentId: parent === null ? null : parent.hidden ? parent.parentId : parent.id,
      hidden,
      opaque,
      selfBytes: 0,
      treeBytes: 0,
      treeFiles: 0,
      treeDirs: 0,
      newestMtimeMs: 0,
      pending: 0,
      read: false,
    };
  };

  const report = (force = false): void => {
    if (!onProgress) return;
    const now = Date.now();
    if (!force && now - lastProgressAt < PROGRESS_INTERVAL_MS) return;
    lastProgressAt = now;
    const elapsedMs = now - startedAt;
    const entriesSeen = filesSeen + dirsSeen;
    onProgress({
      currentPath,
      entriesSeen,
      filesSeen,
      dirsSeen,
      bytesSeen,
      unreadable,
      elapsedMs,
      entriesPerSecond: elapsedMs > 0 ? Math.round((entriesSeen / elapsedMs) * 1000) : 0,
    });
  };

  /**
   * Roll a finished directory into its parent and keep cascading while that
   * completes the parent too. Emitting here is what keeps memory flat: the
   * frame is released as soon as its numbers reach the parent.
   */
  const settle = (start: Frame): void => {
    let frame: Frame | null = start;
    while (frame !== null) {
      if (!frame.hidden) {
        onDirectory({
          id: frame.id,
          parentId: frame.parentId,
          path: frame.path,
          name: frame.name,
          depth: frame.depth,
          selfBytes: frame.selfBytes,
          treeBytes: frame.treeBytes,
          treeFiles: frame.treeFiles,
          treeDirs: frame.treeDirs,
          newestMtimeMs: frame.newestMtimeMs,
          opaque: frame.opaque,
        });
      }
      const parent: Frame | null = frame.parent;
      if (parent === null) {
        rootBytes = frame.treeBytes;
        rootId = frame.hidden ? null : frame.id;
        return;
      }
      parent.treeBytes += frame.treeBytes;
      parent.treeFiles += frame.treeFiles;
      parent.treeDirs += frame.treeDirs + 1;
      if (frame.newestMtimeMs > parent.newestMtimeMs) {
        parent.newestMtimeMs = frame.newestMtimeMs;
      }
      parent.pending -= 1;
      frame.parent = null;
      frame = parent.read && parent.pending === 0 ? parent : null;
    }
  };

  const readDirectory = async (frame: Frame): Promise<void> => {
    currentPath = frame.path;
    const children: Frame[] = [];
    try {
      const handle = await opendir(frame.path, { bufferSize: 256 });
      for await (const dirent of handle) {
        if (signal?.aborted) break;
        const childPath = join(frame.path, dirent.name);
        if (dirent.isDirectory()) {
          if (skipPaths.has(childPath)) continue;
          dirsSeen += 1;
          const childOpaque = frame.opaque || opaqueNames.has(dirent.name);
          // The opaque ROOT is stored; everything beneath it is hidden.
          children.push(
            makeFrame(
              childPath,
              dirent.name,
              frame.depth + 1,
              frame,
              frame.opaque,
              childOpaque,
            ),
          );
          continue;
        }
        if (!dirent.isFile()) continue;
        filesSeen += 1;
        try {
          const stats = await lstat(childPath);
          if (stats.nlink > 1) {
            const key = `${stats.dev}:${stats.ino}`;
            if (seenLinks.has(key)) continue;
            seenLinks.add(key);
          }
          // Allocated blocks are the real cost on disk; sparse files and APFS
          // clones report far less than their apparent size. Fall back to
          // apparent size where blocks are not reported.
          const bytes = stats.blocks > 0 ? stats.blocks * 512 : stats.size;
          frame.selfBytes += bytes;
          frame.treeBytes += bytes;
          frame.treeFiles += 1;
          bytesSeen += bytes;
          const mtimeMs = stats.mtimeMs;
          if (mtimeMs > frame.newestMtimeMs) frame.newestMtimeMs = mtimeMs;
          top.offer({ path: childPath, bytes, mtimeMs });
        } catch {
          unreadable += 1;
        }
      }
    } catch {
      unreadable += 1;
    }

    frame.read = true;
    frame.pending = children.length;
    report();
    if (children.length === 0) {
      settle(frame);
      return;
    }
    for (const child of children) stack.push(child);
  };

  await new Promise<void>((resolve) => {
    const pump = (): void => {
      if (signal?.aborted && !aborted) {
        aborted = true;
        stack.length = 0;
      }
      while (active < concurrency && stack.length > 0) {
        const frame = stack.pop()!;
        active += 1;
        void readDirectory(frame).then(
          () => {
            active -= 1;
            pump();
          },
          () => {
            unreadable += 1;
            active -= 1;
            pump();
          },
        );
      }
      if (active === 0 && stack.length === 0) resolve();
    };
    stack.push(makeFrame(root, root, 0, null, false, opaqueNames.has(root)));
    pump();
  });

  report(true);

  return {
    root,
    rootId,
    // An aborted walk never settles the root, so fall back to the running total.
    totalBytes: rootBytes ?? bytesSeen,
    filesSeen,
    dirsSeen,
    dirsStored,
    unreadable,
    durationMs: Date.now() - startedAt,
    aborted,
    topFiles: top.drain(),
  };
}
