/**
 * Formatting shared by the server (CLI + agent tools) and the app bundle.
 * Everything here is pure so it can be unit-tested without a plugin host.
 */

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;

/**
 * Disk vendors, Finder, and `df -h` on macOS all count in powers of 1000.
 * Reclaim reports the same numbers the user sees in About This Mac, because a
 * dashboard that disagrees with the OS reads as broken rather than precise.
 */
export function formatBytes(bytes: number, options?: { precise?: boolean }): string {
  if (!Number.isFinite(bytes)) return "—";
  const negative = bytes < 0;
  let value = Math.abs(bytes);
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit += 1;
  }
  const digits = options?.precise
    ? value >= 100
      ? 1
      : 2
    : unit === 0 || value >= 100
      ? 0
      : value >= 10
        ? 1
        : 2;
  return `${negative ? "-" : ""}${value.toFixed(digits)} ${UNITS[unit]}`;
}

/** Fixed-width byte column for CLI tables, so sizes line up under each other. */
export function padBytes(bytes: number, width = 9): string {
  return formatBytes(bytes).padStart(width);
}

export function formatPercent(fraction: number, digits = 0): string {
  if (!Number.isFinite(fraction)) return "—";
  return `${(fraction * 100).toFixed(digits)}%`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "—";
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const seconds = ms / 1000;
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)}s`;
  const minutes = Math.floor(seconds / 60);
  const rest = Math.round(seconds - minutes * 60);
  if (minutes < 60) return rest === 0 ? `${minutes}m` : `${minutes}m ${rest}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes - hours * 60}m`;
}

/** Relative age, for "last scanned" and "untouched for" labels. */
export function formatAgo(atMs: number | null, nowMs = Date.now()): string {
  if (atMs === null || !Number.isFinite(atMs)) return "never";
  const delta = Math.max(0, nowMs - atMs);
  if (delta < 45_000) return "just now";
  const minutes = Math.round(delta / 60_000);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

export function daysBetween(fromMs: number, toMs: number): number {
  return Math.max(0, Math.floor((toMs - fromMs) / 86_400_000));
}

/**
 * Shorten a path for display without losing the tail, which is the part that
 * identifies what the row actually is.
 */
export function shortenPath(path: string, homeDir: string | null): string {
  if (homeDir && path === homeDir) return "~";
  if (homeDir && path.startsWith(`${homeDir}/`)) {
    return `~/${path.slice(homeDir.length + 1)}`;
  }
  return path;
}

/** Left-truncate to a budget: `…/deep/tail/segment`. */
export function ellipsizePath(path: string, maxChars: number): string {
  if (path.length <= maxChars) return path;
  return `…${path.slice(path.length - (maxChars - 1))}`;
}
