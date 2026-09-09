/**
 * The deletion boundary.
 *
 * Reclaim indexes the whole volume but is only ever allowed to *remove* things
 * inside roots the user authorized. Every path that reaches a delete passes
 * `authorizePath` first, and it fails closed: anything it cannot prove is
 * inside a root is refused.
 *
 * The check resolves symlinks before comparing, because a string-prefix test
 * alone is escapable — a symlink at `~/Documents/tmp -> /` would otherwise
 * make `/` look authorized.
 */
import { realpath } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, normalize, resolve, sep } from "node:path";

/**
 * Paths never removed, whatever the roots say. These are either the roots
 * themselves, irreplaceable user data, or directories whose loss breaks the
 * machine rather than just costing a rebuild.
 */
export function neverDelete(): Set<string> {
  const home = homedir();
  return new Set(
    [
      "/",
      "/Applications",
      "/Library",
      "/System",
      "/Users",
      "/bin",
      "/etc",
      "/opt",
      "/private",
      "/sbin",
      "/usr",
      "/var",
      home,
      `${home}/Desktop`,
      `${home}/Documents`,
      `${home}/Downloads`,
      `${home}/Library`,
      `${home}/Movies`,
      `${home}/Music`,
      `${home}/Pictures`,
      `${home}/Applications`,
      `${home}/.ssh`,
      `${home}/.gnupg`,
      `${home}/.config`,
      `${home}/.bb`,
      `${home}/.claude`,
    ].map((path) => normalize(path)),
  );
}

/**
 * Directory names that are source or state, never build output — refused even
 * when a reclaimer's rule would otherwise match them.
 */
export const PROTECTED_NAMES = new Set([
  ".git",
  ".hg",
  ".svn",
  "src",
  "lib",
  "app",
  "assets",
  "public",
  "docs",
  ".env",
]);

export interface RootSet {
  roots: string[];
}

/** Expand `~`, resolve, and drop empties. Order and duplicates do not matter. */
export function parseRoots(raw: string, home = homedir()): string[] {
  const seen = new Set<string>();
  for (const line of raw.split(/[\n,]/)) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("#")) continue;
    const expanded =
      trimmed === "~"
        ? home
        : trimmed.startsWith("~/")
          ? resolve(home, trimmed.slice(2))
          : resolve(trimmed);
    seen.add(normalize(expanded));
  }
  return [...seen];
}

export type AuthorizeFailure =
  | "not-absolute"
  | "traversal"
  | "outside-roots"
  | "protected-path"
  | "is-root"
  | "missing";

export interface AuthorizeResult {
  ok: boolean;
  /** The resolved real path that would actually be removed. */
  resolvedPath: string | null;
  reason: AuthorizeFailure | null;
  message: string | null;
}

const MESSAGES: Record<AuthorizeFailure, string> = {
  "not-absolute": "Path is not absolute.",
  traversal: "Path contains a traversal segment.",
  "outside-roots": "Path is outside every authorized root.",
  "protected-path": "Path is on the never-delete list.",
  "is-root": "Path is an authorized root itself, not something inside one.",
  missing: "Path does not exist.",
};

function fail(reason: AuthorizeFailure, resolvedPath: string | null = null): AuthorizeResult {
  return { ok: false, resolvedPath, reason, message: MESSAGES[reason] };
}

/** True when `child` is strictly beneath `parent` (never equal). */
export function isStrictlyInside(child: string, parent: string): boolean {
  if (child === parent) return false;
  const base = parent.endsWith(sep) ? parent : `${parent}${sep}`;
  return child.startsWith(base);
}

/**
 * Decide whether `candidate` may be deleted.
 *
 * @param resolveSymlinks injected so tests can run without touching the disk;
 * production always passes the real `realpath`.
 */
export async function authorizePath(
  candidate: string,
  roots: string[],
  options: {
    protectedPaths?: Set<string>;
    resolveSymlinks?: (path: string) => Promise<string>;
  } = {},
): Promise<AuthorizeResult> {
  if (!isAbsolute(candidate)) return fail("not-absolute");
  if (candidate.split(sep).includes("..")) return fail("traversal");

  const protectedPaths = options.protectedPaths ?? neverDelete();
  const resolveSymlinks = options.resolveSymlinks ?? realpath;

  let resolved: string;
  try {
    resolved = normalize(await resolveSymlinks(candidate));
  } catch {
    return fail("missing", null);
  }

  if (protectedPaths.has(resolved) || protectedPaths.has(normalize(candidate))) {
    return fail("protected-path", resolved);
  }

  // Roots are resolved too: a root given as a symlink must still match the
  // resolved candidate.
  const resolvedRoots: string[] = [];
  for (const root of roots) {
    try {
      resolvedRoots.push(normalize(await resolveSymlinks(root)));
    } catch {
      resolvedRoots.push(normalize(root));
    }
  }

  if (resolvedRoots.some((root) => root === resolved)) return fail("is-root", resolved);
  if (!resolvedRoots.some((root) => isStrictlyInside(resolved, root))) {
    return fail("outside-roots", resolved);
  }

  return { ok: true, resolvedPath: resolved, reason: null, message: null };
}
