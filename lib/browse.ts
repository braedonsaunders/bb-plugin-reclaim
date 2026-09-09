/**
 * The file browser's data source.
 *
 * Directory sizes come from the index (a subtree total is expensive and cannot
 * be recomputed per click); file sizes and the entry list come from a live
 * `readdir` (cheap, and always current). That split is why the browser stays
 * instant on a 460GB volume while still showing a file you created a second
 * ago.
 */
import { lstat, opendir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Entry, EntryKind, Listing } from "./contract";
import type { IndexStore } from "./index-store";

/** Above this, one directory is not something a human browses; we cap and say so. */
export const MAX_ENTRIES = 2000;
const STAT_CONCURRENCY = 32;

export interface BrowseOptions {
  store: IndexStore;
  path: string;
  /** Directory names to badge as reclaimable, e.g. `node_modules`. */
  reclaimableNames?: ReadonlyMap<string, string>;
}

interface Pending {
  name: string;
  path: string;
  kind: EntryKind;
}

export async function listDirectory(options: BrowseOptions): Promise<Listing> {
  const { store, path } = options;
  const reclaimableNames = options.reclaimableNames ?? new Map<string, string>();
  const parentPath = dirname(path) === path ? null : dirname(path);

  const pending: Pending[] = [];
  let truncated = false;
  try {
    const handle = await opendir(path, { bufferSize: 256 });
    for await (const dirent of handle) {
      if (pending.length >= MAX_ENTRIES) {
        truncated = true;
        break;
      }
      const kind: EntryKind = dirent.isDirectory()
        ? "dir"
        : dirent.isFile()
          ? "file"
          : dirent.isSymbolicLink()
            ? "symlink"
            : "other";
      pending.push({ name: dirent.name, path: join(path, dirent.name), kind });
    }
  } catch (cause) {
    return {
      path,
      parentPath,
      exists: false,
      totalBytes: 0,
      indexedBytes: null,
      entries: [],
      truncated: false,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // Indexed children, keyed by name, so a directory's subtree total is one
  // in-memory lookup rather than a query per row.
  const indexed = new Map(store.getChildren(path).map((row) => [row.name, row]));

  const entries: Entry[] = new Array(pending.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(STAT_CONCURRENCY, pending.length) }, async () => {
    for (;;) {
      const slot = cursor++;
      if (slot >= pending.length) return;
      const item = pending[slot]!;
      if (item.kind === "dir") {
        const row = indexed.get(item.name);
        entries[slot] = {
          path: item.path,
          name: item.name,
          kind: "dir",
          bytes: row?.treeBytes ?? 0,
          sized: row !== undefined,
          fileCount: row?.treeFiles ?? null,
          mtimeMs: row?.newestMtimeMs ?? null,
          share: 0,
          opaque: row?.opaque ?? false,
          reclaimableAs: reclaimableNames.get(item.name) ?? null,
        };
        continue;
      }
      let bytes = 0;
      let mtimeMs: number | null = null;
      try {
        const stats = await lstat(item.path);
        bytes = stats.blocks > 0 ? stats.blocks * 512 : stats.size;
        mtimeMs = stats.mtimeMs;
      } catch {
        // A file that vanished between readdir and lstat is a zero-size row,
        // not an error for the whole listing.
      }
      entries[slot] = {
        path: item.path,
        name: item.name,
        kind: item.kind,
        bytes: item.kind === "symlink" ? 0 : bytes,
        sized: true,
        fileCount: null,
        mtimeMs,
        share: 0,
        opaque: false,
        reclaimableAs: null,
      };
    }
  });
  await Promise.all(workers);

  const totalBytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
  for (const entry of entries) {
    entry.share = totalBytes > 0 ? entry.bytes / totalBytes : 0;
  }
  entries.sort((a, b) => b.bytes - a.bytes || a.name.localeCompare(b.name));

  return {
    path,
    parentPath,
    exists: true,
    totalBytes,
    indexedBytes: store.getSize(path),
    entries,
    truncated,
    error: null,
  };
}
