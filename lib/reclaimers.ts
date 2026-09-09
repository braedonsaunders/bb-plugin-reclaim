/**
 * Reclaimers: the deterministic rules that turn "the disk is full" into a list
 * of specific things worth deleting, each with an exact byte count.
 *
 * Two invariants hold across every rule:
 *
 * 1. **Nothing here deletes.** `detect` only proposes. Execution happens in
 *    `apply.ts`, behind `authorizePath`.
 * 2. **Rebuildable, not recoverable.** A candidate is only proposed if losing
 *    it costs time (a reinstall, a rebuild) rather than data. Anything whose
 *    loss is permanent is either absent or marked `careful` and never
 *    preselected.
 */
import { access, lstat, readdir } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { basename, dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { Candidate, Group, Risk } from "./contract";
import type { IndexStore } from "./index-store";
import { PROTECTED_NAMES } from "./roots";
import { daysBetween, formatAgo, formatBytes, shortenPath } from "./format";
import { walk } from "./walk";
import {
  compactDiskImage,
  parseDockerDf,
  parseDockerSize,
  readDockerState,
  trimmableBytes,
} from "./docker";

// Re-exported so tests and callers have one import site for Docker parsing.
export { parseDockerDf, parseDockerSize } from "./docker";

const exec = promisify(execFile);
const IS_DARWIN = platform() === "darwin";

export interface ReclaimContext {
  store: IndexStore;
  roots: string[];
  home: string;
  nowMs: number;
  staleDays: number;
  dockerEnabled: boolean;
  /** Worktree paths BB still has a live thread for; those are left alone. */
  liveWorktrees: Set<string>;
  log: (message: string) => void;
}

/** How a candidate is actually freed. The frontend never sees or sends this. */
export type Executor =
  | { kind: "remove-path"; path: string }
  | { kind: "docker"; args: string[]; label: string }
  /** TRIM inside the VM so the host's sparse disk image actually shrinks. */
  | { kind: "docker-compact"; label: string };

export interface DetectedCandidate extends Candidate {
  executor: Executor;
}

export interface DetectedGroup extends Omit<Group, "candidates"> {
  candidates: DetectedCandidate[];
}

export interface Reclaimer {
  id: string;
  title: string;
  description: string;
  risk: Risk;
  caution: string | null;
  detect: (context: ReclaimContext) => Promise<DetectedGroup>;
}

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

function insideRoots(path: string, roots: string[]): boolean {
  return roots.some((root) => path === root || path.startsWith(`${root}/`));
}

/** macOS bundle extensions. Everything inside one is application payload. */
const BUNDLE_SUFFIXES = [".app", ".framework", ".bundle", ".appex", ".plugin", ".kext", ".xpc"];

/**
 * A shipped application is a directory tree that happens to contain folders
 * named `dist`, `out` and `node_modules` — VS Code's own `.app` has an `out/`
 * beside a `package.json`, which is exactly the evidence the build-output rule
 * looks for. Deleting it does not free a rebuildable artifact; it corrupts an
 * installed application. Nothing inside a bundle is ever a candidate.
 */
export function insideBundle(path: string): boolean {
  for (const segment of path.split("/")) {
    if (BUNDLE_SUFFIXES.some((suffix) => segment.endsWith(suffix))) return true;
  }
  return false;
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

/** Live subtree size, for paths the index does not have a row for. */
async function measure(path: string): Promise<number> {
  try {
    const result = await walk({ root: path, concurrency: 16, topFiles: 0, onDirectory: () => {} });
    return result.totalBytes;
  } catch {
    return 0;
  }
}

/** Indexed size when available, otherwise measured live. */
async function sizeOf(store: IndexStore, path: string): Promise<number> {
  return store.getSize(path) ?? (await measure(path));
}

function candidateId(groupId: string, path: string): string {
  // Deterministic so re-planning keeps selections stable across refreshes.
  let hash = 5381;
  for (let index = 0; index < path.length; index += 1) {
    hash = ((hash << 5) + hash + path.charCodeAt(index)) >>> 0;
  }
  return `${groupId}:${hash.toString(36)}`;
}

function emptyGroup(
  reclaimer: Pick<Reclaimer, "id" | "title" | "description" | "risk" | "caution">,
  unavailableReason: string | null = null,
): DetectedGroup {
  return {
    id: reclaimer.id,
    title: reclaimer.title,
    description: reclaimer.description,
    risk: reclaimer.risk,
    caution: reclaimer.caution,
    bytes: 0,
    count: 0,
    available: unavailableReason === null,
    unavailableReason,
    candidates: [],
  };
}

/**
 * Drop candidates whose path has vanished since the last scan.
 *
 * The index is a snapshot, and a dev machine moves underneath it — a
 * `node_modules` proposed from a ten-minute-old scan may already be gone.
 * Deleting one is harmless (re-authorization catches it), but *counting* it
 * inflates the total Reclaim promises to free, which is the number the user
 * makes a decision on. One `access` per candidate is far cheaper than being
 * wrong about it.
 */
async function prunePresent(candidates: DetectedCandidate[]): Promise<DetectedCandidate[]> {
  const present = await Promise.all(
    candidates.map(async (candidate) =>
      candidate.executor.kind === "remove-path" ? exists(candidate.executor.path) : true,
    ),
  );
  return candidates.filter((_candidate, index) => present[index] === true);
}

function finishGroup(
  reclaimer: Pick<Reclaimer, "id" | "title" | "description" | "risk" | "caution">,
  candidates: DetectedCandidate[],
): DetectedGroup {
  candidates.sort((a, b) => b.bytes - a.bytes);
  return {
    id: reclaimer.id,
    title: reclaimer.title,
    description: reclaimer.description,
    risk: reclaimer.risk,
    caution: reclaimer.caution,
    bytes: candidates.reduce((sum, candidate) => sum + candidate.bytes, 0),
    count: candidates.length,
    available: true,
    unavailableReason: null,
    candidates,
  };
}

function makeCandidate(
  groupId: string,
  risk: Risk,
  home: string,
  input: {
    path: string;
    bytes: number;
    detail: string;
    lastUsedMs: number | null;
    defaultSelected: boolean;
    executor?: Executor;
  },
): DetectedCandidate {
  return {
    id: candidateId(groupId, input.path),
    groupId,
    path: input.path,
    displayPath: shortenPath(input.path, home),
    bytes: input.bytes,
    detail: input.detail,
    lastUsedMs: input.lastUsedMs,
    risk,
    defaultSelected: input.defaultSelected,
    executor: input.executor ?? { kind: "remove-path", path: input.path },
  };
}

/* ------------------------------------------------------------------ */
/* 1. node_modules in BB worktrees                                     */
/* ------------------------------------------------------------------ */

/**
 * Agent worktrees each install their own `node_modules`. A few hundred of them
 * is routinely a three-figure number of gigabytes, and every byte is a
 * reinstall away — which makes this the highest-yield, lowest-risk rule
 * Reclaim has. Worktrees with a live thread are skipped so a running agent
 * never has its dependencies pulled out from under it.
 */
const worktreeModules: Reclaimer = {
  id: "worktree-modules",
  title: "Dependencies in agent worktrees",
  description:
    "node_modules inside BB worktrees. Reinstallable, and worktrees for live threads are skipped.",
  risk: "rebuildable",
  caution: null,
  async detect(context) {
    const worktreeRoot = join(context.home, ".bb", "worktrees");
    if (!insideRoots(worktreeRoot, context.roots)) {
      return emptyGroup(worktreeModules, "~/.bb/worktrees is not an authorized root.");
    }
    if (!(await exists(worktreeRoot))) {
      return emptyGroup(worktreeModules, "No BB worktree directory on this machine.");
    }

    const rows = context.store.findByNames(["node_modules"], { roots: [worktreeRoot], minBytes: 1 });
    const candidates: DetectedCandidate[] = [];
    for (const row of rows) {
      const owner = dirname(row.path);
      if ([...context.liveWorktrees].some((live) => owner === live || owner.startsWith(`${live}/`))) {
        continue;
      }
      candidates.push(
        makeCandidate(worktreeModules.id, worktreeModules.risk, context.home, {
          path: row.path,
          bytes: row.treeBytes,
          detail: `Worktree ${basename(owner)} · last touched ${formatAgo(row.newestMtimeMs, context.nowMs)}`,
          lastUsedMs: row.newestMtimeMs,
          defaultSelected: true,
        }),
      );
    }
    return finishGroup(worktreeModules, await prunePresent(candidates));
  },
};

/* ------------------------------------------------------------------ */
/* 2. node_modules in stale projects                                   */
/* ------------------------------------------------------------------ */

/**
 * Staleness is read from the project's `.git` directory rather than from
 * `node_modules` itself: npm preserves publish timestamps from tarballs, so
 * files inside `node_modules` can carry mtimes decades old and would make every
 * project look abandoned.
 */
const staleModules: Reclaimer = {
  id: "stale-modules",
  title: "Dependencies in untouched projects",
  description: "node_modules for projects with no activity for a while. Reinstall with one command.",
  risk: "rebuildable",
  caution: null,
  async detect(context) {
    const worktreeRoot = join(context.home, ".bb", "worktrees");
    const rows = context.store.findByNames(["node_modules"], {
      roots: context.roots,
      minBytes: 10 * 1024 * 1024,
    });
    const candidates: DetectedCandidate[] = [];

    for (const row of rows) {
      // Worktrees have their own, more aggressive rule above.
      if (row.path.startsWith(`${worktreeRoot}/`)) continue;
      // Dependencies bundled inside a shipped app are that app's payload.
      if (insideBundle(row.path)) continue;
      const project = dirname(row.path);

      // Last real activity: git metadata first, then the project directory.
      const gitRow = context.store.getDir(join(project, ".git"));
      let lastActivityMs = gitRow?.newestMtimeMs ?? 0;
      if (lastActivityMs === 0) {
        try {
          lastActivityMs = (await lstat(project)).mtimeMs;
        } catch {
          continue;
        }
      }

      const idleDays = daysBetween(lastActivityMs, context.nowMs);
      if (idleDays < context.staleDays) continue;
      candidates.push(
        makeCandidate(staleModules.id, staleModules.risk, context.home, {
          path: row.path,
          bytes: row.treeBytes,
          detail: `${basename(project)} · idle ${idleDays} days`,
          lastUsedMs: lastActivityMs,
          defaultSelected: idleDays >= context.staleDays * 2,
        }),
      );
    }
    return finishGroup(staleModules, await prunePresent(candidates));
  },
};

/* ------------------------------------------------------------------ */
/* 3. Build output                                                     */
/* ------------------------------------------------------------------ */

/** Unambiguous build directories — the name alone is proof enough. */
const UNAMBIGUOUS_BUILD_DIRS = [
  ".next",
  ".nuxt",
  ".svelte-kit",
  ".turbo",
  ".parcel-cache",
  ".vite",
  ".angular",
  ".docusaurus",
  "__pycache__",
  ".pytest_cache",
  ".mypy_cache",
  ".ruff_cache",
  ".gradle",
  "DerivedData",
];

/**
 * Names that are build output in a JS/Rust project and hand-written source
 * anywhere else. These are only proposed when a build manifest sits beside
 * them.
 */
const AMBIGUOUS_BUILD_DIRS: Record<string, string[]> = {
  dist: ["package.json", "pyproject.toml", "setup.py"],
  build: ["package.json", "CMakeLists.txt", "pom.xml", "build.gradle"],
  out: ["package.json"],
  target: ["Cargo.toml", "pom.xml"],
  coverage: ["package.json"],
};

const buildOutput: Reclaimer = {
  id: "build-output",
  title: "Build output",
  description: "Compiled and generated directories that a rebuild recreates exactly.",
  risk: "rebuildable",
  caution: null,
  async detect(context) {
    const names = [...UNAMBIGUOUS_BUILD_DIRS, ...Object.keys(AMBIGUOUS_BUILD_DIRS)];
    const rows = context.store.findByNames(names, {
      roots: context.roots,
      minBytes: 5 * 1024 * 1024,
    });
    const candidates: DetectedCandidate[] = [];

    for (const row of rows) {
      if (PROTECTED_NAMES.has(row.name) && !UNAMBIGUOUS_BUILD_DIRS.includes(row.name)) continue;
      // Never reclaim build output that lives inside dependencies; removing the
      // whole node_modules is the cheaper, safer move.
      if (row.path.includes("/node_modules/")) continue;
      if (insideBundle(row.path)) continue;

      const markers = AMBIGUOUS_BUILD_DIRS[row.name];
      if (markers !== undefined) {
        const project = dirname(row.path);
        const found = await Promise.all(markers.map((marker) => exists(join(project, marker))));
        if (!found.some(Boolean)) continue;
      }

      const idleDays = daysBetween(row.newestMtimeMs, context.nowMs);
      candidates.push(
        makeCandidate(buildOutput.id, buildOutput.risk, context.home, {
          path: row.path,
          bytes: row.treeBytes,
          detail: `${basename(dirname(row.path))}/${row.name} · built ${formatAgo(row.newestMtimeMs, context.nowMs)}`,
          lastUsedMs: row.newestMtimeMs,
          defaultSelected: idleDays >= 14,
        }),
      );
    }
    return finishGroup(buildOutput, await prunePresent(candidates));
  },
};

/* ------------------------------------------------------------------ */
/* 4. Package-manager caches                                           */
/* ------------------------------------------------------------------ */

interface CacheTarget {
  relative: string;
  label: string;
  /** Darwin-only paths are skipped elsewhere rather than reported missing. */
  darwinOnly?: boolean;
}

const CACHE_TARGETS: CacheTarget[] = [
  { relative: ".npm/_cacache", label: "npm" },
  { relative: "Library/pnpm/store", label: "pnpm", darwinOnly: true },
  { relative: ".local/share/pnpm/store", label: "pnpm" },
  { relative: ".yarn/cache", label: "Yarn" },
  { relative: "Library/Caches/Yarn", label: "Yarn", darwinOnly: true },
  { relative: ".bun/install/cache", label: "Bun" },
  { relative: ".deno", label: "Deno" },
  { relative: ".cargo/registry/cache", label: "Cargo registry" },
  { relative: ".cargo/registry/src", label: "Cargo sources" },
  { relative: ".gradle/caches", label: "Gradle" },
  { relative: ".m2/repository", label: "Maven" },
  { relative: "go/pkg/mod/cache/download", label: "Go modules" },
  { relative: "Library/Caches/Homebrew", label: "Homebrew", darwinOnly: true },
  { relative: "Library/Caches/pip", label: "pip", darwinOnly: true },
  { relative: ".cache/pip", label: "pip" },
  { relative: "Library/Caches/uv", label: "uv", darwinOnly: true },
  { relative: ".cache/uv", label: "uv" },
  { relative: "Library/Caches/go-build", label: "Go build", darwinOnly: true },
  { relative: ".cache/go-build", label: "Go build" },
  { relative: "Library/Caches/ms-playwright", label: "Playwright browsers", darwinOnly: true },
  { relative: ".cache/ms-playwright", label: "Playwright browsers" },
  { relative: "Library/Caches/typescript", label: "TypeScript", darwinOnly: true },
  { relative: ".cache/puppeteer", label: "Puppeteer" },
  { relative: ".electron-gyp", label: "electron-gyp" },
  { relative: ".node-gyp", label: "node-gyp" },
];

const packageCaches: Reclaimer = {
  id: "package-caches",
  title: "Package manager caches",
  description: "Download caches for npm, pnpm, Cargo, Go and friends. Refilled on next install.",
  risk: "safe",
  caution: "Your next install re-downloads what it needs, so it will be slower once.",
  async detect(context) {
    const candidates: DetectedCandidate[] = [];
    for (const target of CACHE_TARGETS) {
      if (target.darwinOnly === true && !IS_DARWIN) continue;
      const path = join(context.home, target.relative);
      if (!insideRoots(path, context.roots)) continue;
      if (!(await exists(path))) continue;
      const bytes = await sizeOf(context.store, path);
      if (bytes < 1024 * 1024) continue;
      candidates.push(
        makeCandidate(packageCaches.id, packageCaches.risk, context.home, {
          path,
          bytes,
          detail: `${target.label} cache`,
          lastUsedMs: null,
          defaultSelected: true,
        }),
      );
    }
    return finishGroup(packageCaches, candidates);
  },
};

/* ------------------------------------------------------------------ */
/* 5. Xcode                                                            */
/* ------------------------------------------------------------------ */

const xcode: Reclaimer = {
  id: "xcode",
  title: "Xcode derived data and simulators",
  description: "Intermediate build products and per-OS device support Xcode regenerates on demand.",
  risk: "rebuildable",
  caution: "Removing iOS DeviceSupport means the next device attach re-copies its symbols.",
  async detect(context) {
    if (!IS_DARWIN) return emptyGroup(xcode, "Xcode only exists on macOS.");
    const targets = [
      { relative: "Library/Developer/Xcode/DerivedData", label: "Derived data", preselect: true },
      { relative: "Library/Developer/Xcode/iOS DeviceSupport", label: "iOS device support", preselect: false },
      { relative: "Library/Developer/Xcode/watchOS DeviceSupport", label: "watchOS device support", preselect: false },
      { relative: "Library/Developer/CoreSimulator/Caches", label: "Simulator caches", preselect: true },
      { relative: "Library/Developer/Xcode/Products", label: "Build products", preselect: true },
    ];
    const candidates: DetectedCandidate[] = [];
    for (const target of targets) {
      const path = join(context.home, target.relative);
      if (!insideRoots(path, context.roots)) continue;
      if (!(await exists(path))) continue;
      const bytes = await sizeOf(context.store, path);
      if (bytes < 1024 * 1024) continue;
      candidates.push(
        makeCandidate(xcode.id, xcode.risk, context.home, {
          path,
          bytes,
          detail: target.label,
          lastUsedMs: null,
          defaultSelected: target.preselect,
        }),
      );
    }
    return finishGroup(xcode, candidates);
  },
};

/* ------------------------------------------------------------------ */
/* 6. Docker                                                           */
/* ------------------------------------------------------------------ */

const docker: Reclaimer = {
  id: "docker",
  title: "Docker",
  description:
    "Build cache, dangling images, stopped containers, and the VM disk image Docker never shrinks on its own.",
  risk: "rebuildable",
  caution:
    "Unused volumes can hold database state — they are listed separately and never preselected.",
  async detect(context) {
    if (!context.dockerEnabled) return emptyGroup(docker, "Docker reclaim is switched off.");

    const state = await readDockerState(context.home);
    if (!state.daemonRunning || state.usage === null) {
      // A stopped daemon still holds every byte of its disk image, so say how
      // much rather than reporting a bare "not running".
      const parked =
        state.diskImage === null
          ? ""
          : ` Its disk image is holding ${formatBytes(state.diskImage.allocatedBytes)}.`;
      return emptyGroup(docker, `${state.reason ?? "Docker is unavailable."}${parked}`);
    }

    const usage = state.usage;
    const candidates: DetectedCandidate[] = [];
    const add = (
      key: string,
      label: string,
      bytes: number,
      executor: Executor,
      defaultSelected: boolean,
      detail?: string,
    ) => {
      if (bytes <= 0) return;
      candidates.push({
        id: candidateId(docker.id, key),
        groupId: docker.id,
        path: `docker://${key}`,
        displayPath: `docker ${label}`,
        bytes,
        detail: detail ?? `${label} · ${formatBytes(bytes)} reclaimable`,
        lastUsedMs: null,
        risk: docker.risk,
        defaultSelected,
        executor,
      });
    };

    add("build-cache", "build cache", usage.buildCacheBytes, {
      kind: "docker",
      args: ["builder", "prune", "-af"],
      label: "build cache",
    }, true);
    add("images", "dangling images", usage.danglingImageBytes, {
      kind: "docker",
      args: ["image", "prune", "-af"],
      label: "dangling images",
    }, true);
    add("containers", "stopped containers", usage.stoppedContainerBytes, {
      kind: "docker",
      args: ["container", "prune", "-f"],
      label: "stopped containers",
    }, true);
    add("volumes", "unused volumes", usage.unusedVolumeBytes, {
      kind: "docker",
      args: ["volume", "prune", "-f"],
      label: "unused volumes",
    }, false);

    /**
     * The one that actually moves free space on macOS. Pruning frees blocks
     * *inside* the VM; until something TRIMs, the host's sparse image keeps
     * every one of them. Listed last and not preselected, because it should
     * run after the prunes — it can only release what they freed.
     */
    const trimmable = trimmableBytes(state);
    if (trimmable > 0 && state.diskImage !== null) {
      add(
        "compact",
        "disk image",
        trimmable,
        { kind: "docker-compact", label: "disk image" },
        false,
        `Docker's disk image occupies ${formatBytes(state.diskImage.allocatedBytes)} but holds ` +
          `${formatBytes(usage.totalBytes)}. Compacting returns the difference to the disk. ` +
          `Run this after pruning.`,
      );
    }

    const group = finishGroup(docker, candidates);
    if (state.diskImage !== null) {
      // Live facts beat the static blurb here: "your VM image costs 37.6GB and
      // holds 39.9GB" is the context that makes the rest of the group legible,
      // and it explains why compaction is or is not on offer.
      group.description =
        `Docker's disk image occupies ${formatBytes(state.diskImage.allocatedBytes)} on your disk ` +
        `and holds ${formatBytes(usage.totalBytes)}. ` +
        (trimmable > 0
          ? `Pruning frees space inside it; compacting returns that space to the disk.`
          : `There is no dead space in it to compact right now — prune first, then re-plan.`);
    }
    return group;
  },
};

/* ------------------------------------------------------------------ */
/* 7. Trash                                                            */
/* ------------------------------------------------------------------ */

const trash: Reclaimer = {
  id: "trash",
  title: "Trash",
  description: "Items already in the Trash. Emptying them is the last step of a delete you made.",
  risk: "careful",
  caution: "Emptied items are gone for good — nothing here can be undone.",
  async detect(context) {
    const trashPath = join(context.home, IS_DARWIN ? ".Trash" : ".local/share/Trash/files");
    if (!insideRoots(trashPath, context.roots)) {
      return emptyGroup(trash, "The Trash directory is not an authorized root.");
    }
    if (!(await exists(trashPath))) return emptyGroup(trash, "Nothing in the Trash.");

    let entries: string[];
    try {
      entries = await readdir(trashPath);
    } catch {
      return emptyGroup(trash, "The Trash could not be read.");
    }

    const candidates: DetectedCandidate[] = [];
    for (const name of entries) {
      const path = join(trashPath, name);
      let stats;
      try {
        stats = await lstat(path);
      } catch {
        continue;
      }
      const bytes = stats.isDirectory() ? await sizeOf(context.store, path) : stats.size;
      if (bytes < 1024 * 1024) continue;
      candidates.push(
        makeCandidate(trash.id, trash.risk, context.home, {
          path,
          bytes,
          detail: `Trashed ${formatAgo(stats.mtimeMs, context.nowMs)}`,
          lastUsedMs: stats.mtimeMs,
          // Never preselected: emptying the Trash is the user's call, always.
          defaultSelected: false,
        }),
      );
    }
    return finishGroup(trash, candidates);
  },
};

export const RECLAIMERS: Reclaimer[] = [
  worktreeModules,
  staleModules,
  buildOutput,
  packageCaches,
  xcode,
  docker,
  trash,
];

export function defaultRoots(home = homedir()): string[] {
  return [
    join(home, "Documents"),
    join(home, "Developer"),
    join(home, "Projects"),
    join(home, "code"),
    join(home, ".bb", "worktrees"),
    join(home, "Library", "Caches"),
    join(home, "Library", "Developer"),
    join(home, ".npm"),
    join(home, ".cache"),
    join(home, ".cargo"),
    join(home, ".gradle"),
    join(home, ".m2"),
    join(home, ".yarn"),
    join(home, ".bun"),
    join(home, ".Trash"),
  ];
}
