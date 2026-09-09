/**
 * Volume capacity.
 *
 * `fs.statfs` is the portable spine and always works. Everything platform
 * specific — APFS per-volume usage, local snapshots — is *enrichment* layered
 * on top and is allowed to fail silently, so Reclaim still reports honest
 * numbers on Linux, in a container, or under a sandbox that blocks
 * DiskArbitration.
 *
 * One APFS subtlety drives the whole shape of this file: sibling volumes in a
 * container share one free-space pool, so `statfs` on `/` and on
 * `/System/Volumes/Data` report the *same* free bytes. Percent-full is
 * therefore a property of the container, while "used" is per volume and has to
 * come from `diskutil`.
 */
import { statfs } from "node:fs/promises";
import { readFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { platform } from "node:os";
import { promisify } from "node:util";
import type { Thresholds, Volume, VolumeSnapshotRow, PressureLevel } from "./contract";

const exec = promisify(execFile);
const IS_DARWIN = platform() === "darwin";
const COMMAND_TIMEOUT_MS = 5_000;

async function run(file: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await exec(file, args, {
      timeout: COMMAND_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
    });
    return stdout;
  } catch {
    return null;
  }
}

export interface MountPoint {
  mountPoint: string;
  device: string | null;
  fsType: string | null;
}

/** `/sbin/mount` line: `/dev/disk3s5 on /System/Volumes/Data (apfs, local, ...)`. */
const DARWIN_MOUNT = /^(\S+) on (.+?) \(([^,)]+)/;

export async function listMounts(): Promise<MountPoint[]> {
  if (IS_DARWIN) {
    const stdout = await run("/sbin/mount", []);
    if (stdout === null) return [{ mountPoint: "/", device: null, fsType: null }];
    const mounts: MountPoint[] = [];
    for (const line of stdout.split("\n")) {
      const match = DARWIN_MOUNT.exec(line.trim());
      if (match === null) continue;
      const [, device, mountPoint, fsType] = match;
      if (fsType === "devfs" || fsType === "autofs") continue;
      mounts.push({ mountPoint: mountPoint!, device: device!, fsType: fsType! });
    }
    return mounts.length > 0 ? mounts : [{ mountPoint: "/", device: null, fsType: null }];
  }

  try {
    const text = await readFile("/proc/mounts", "utf8");
    const mounts: MountPoint[] = [];
    const virtual = new Set([
      "proc",
      "sysfs",
      "devtmpfs",
      "devpts",
      "tmpfs",
      "cgroup",
      "cgroup2",
      "securityfs",
      "pstore",
      "bpf",
      "debugfs",
      "tracefs",
      "mqueue",
      "hugetlbfs",
      "fusectl",
      "configfs",
      "ramfs",
      "binfmt_misc",
      "autofs",
      "squashfs",
      "overlay",
      "nsfs",
    ]);
    for (const line of text.split("\n")) {
      const [device, mountPoint, fsType] = line.split(" ");
      if (!mountPoint || !fsType || virtual.has(fsType)) continue;
      // /proc/mounts octal-escapes spaces and friends.
      mounts.push({
        mountPoint: mountPoint.replace(/\\040/g, " "),
        device: device ?? null,
        fsType,
      });
    }
    return mounts.length > 0 ? mounts : [{ mountPoint: "/", device: null, fsType: null }];
  } catch {
    return [{ mountPoint: "/", device: null, fsType: null }];
  }
}

interface DiskutilInfo {
  capacityInUseBytes: number | null;
  containerSizeBytes: number | null;
  containerFreeBytes: number | null;
  volumeName: string | null;
}

/**
 * `diskutil` + `plutil` is two subprocesses per mount, and the guard polls
 * every minute across ~9 mounts. Volume names and layout barely change, so the
 * enrichment is cached while `statfs` — the number that actually moves — is
 * always read fresh.
 */
const ENRICHMENT_TTL_MS = 5 * 60_000;
const enrichmentCache = new Map<string, { at: number; info: DiskutilInfo | null }>();
let mountCache: { at: number; mounts: MountPoint[] } | null = null;
let snapshotCache: { at: number; rows: VolumeSnapshotRow[] } | null = null;

async function cachedDiskutilInfo(mountPoint: string): Promise<DiskutilInfo | null> {
  const cached = enrichmentCache.get(mountPoint);
  if (cached !== undefined && Date.now() - cached.at < ENRICHMENT_TTL_MS) return cached.info;
  const info = await readDiskutilInfo(mountPoint);
  enrichmentCache.set(mountPoint, { at: Date.now(), info });
  return info;
}

/** Parse `diskutil info -plist` via `plutil`, which can emit JSON directly. */
async function readDiskutilInfo(mountPoint: string): Promise<DiskutilInfo | null> {
  if (!IS_DARWIN) return null;
  const plist = await run("/usr/sbin/diskutil", ["info", "-plist", mountPoint]);
  if (plist === null || plist.trim() === "") return null;
  const json = await runWithInput("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], plist);
  if (json === null) return null;
  try {
    const parsed = JSON.parse(json) as Record<string, unknown>;
    const num = (key: string): number | null => {
      const value = parsed[key];
      return typeof value === "number" && Number.isFinite(value) ? value : null;
    };
    const name = parsed["VolumeName"];
    return {
      capacityInUseBytes: num("CapacityInUse"),
      containerSizeBytes: num("APFSContainerSize") ?? num("TotalSize"),
      containerFreeBytes: num("APFSContainerFree"),
      volumeName: typeof name === "string" && name !== "" ? name : null,
    };
  } catch {
    return null;
  }
}

function runWithInput(file: string, args: string[], input: string): Promise<string | null> {
  return new Promise((resolve) => {
    const child = execFile(
      file,
      args,
      { timeout: COMMAND_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024 },
      (error, stdout) => resolve(error ? null : stdout),
    );
    child.stdin?.end(input);
  });
}

/**
 * Local Time Machine snapshots. They are invisible in Finder, can hold tens of
 * gigabytes, and are the single most common reason a Mac reports far less free
 * space than its files account for — so Reclaim always surfaces them, even
 * though it never deletes one itself.
 */
export async function readSnapshots(mountPoints: string[]): Promise<VolumeSnapshotRow[]> {
  if (!IS_DARWIN) return [];
  const rows: VolumeSnapshotRow[] = [];
  for (const mountPoint of mountPoints) {
    const stdout = await run("/usr/bin/tmutil", ["listlocalsnapshots", mountPoint]);
    if (stdout === null) continue;
    for (const line of stdout.split("\n")) {
      const name = line.trim();
      if (name === "" || name.startsWith("Snapshots for")) continue;
      // com.apple.TimeMachine.2026-09-08-120000.local
      const stamp = /(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})/.exec(name);
      const createdAtMs =
        stamp === null
          ? null
          : new Date(
              Number(stamp[1]),
              Number(stamp[2]) - 1,
              Number(stamp[3]),
              Number(stamp[4]),
              Number(stamp[5]),
              Number(stamp[6]),
            ).getTime();
      rows.push({
        name,
        mountPoint,
        bytes: null,
        createdAtMs,
        sealed: !name.startsWith("com.apple.TimeMachine"),
      });
    }
  }
  return rows;
}

export interface CapacityReading {
  primary: Volume;
  volumes: Volume[];
  snapshots: VolumeSnapshotRow[];
  purgeableBytes: number | null;
}

/**
 * @param primaryMount the mount whose pressure drives alerts — the volume the
 * scan root lives on.
 */
export async function readCapacity(primaryMount = "/"): Promise<CapacityReading> {
  const mounts =
    mountCache !== null && Date.now() - mountCache.at < ENRICHMENT_TTL_MS
      ? mountCache.mounts
      : await listMounts();
  mountCache = { at: Date.now(), mounts };
  const volumes: Volume[] = [];

  for (const mount of mounts) {
    let stats: Awaited<ReturnType<typeof statfs>>;
    try {
      stats = await statfs(mount.mountPoint);
    } catch {
      continue;
    }
    const blockSize = Number(stats.bsize) || 4096;
    const totalBytes = Number(stats.blocks) * blockSize;
    const freeBytes = Number(stats.bavail) * blockSize;
    if (totalBytes <= 0) continue;

    const info = await cachedDiskutilInfo(mount.mountPoint);
    // On APFS `blocks - bfree` is the whole container, so prefer diskutil's
    // per-volume figure and only fall back to the container arithmetic.
    const usedBytes =
      info?.capacityInUseBytes ?? Number(stats.blocks - stats.bfree) * blockSize;

    volumes.push({
      mountPoint: mount.mountPoint,
      device: mount.device,
      fsType: mount.fsType,
      label: info?.volumeName ?? null,
      totalBytes: info?.containerSizeBytes ?? totalBytes,
      // ALWAYS live `statfs`, never the cached `diskutil` figure. The
      // enrichment cache exists to avoid forking two processes per mount every
      // minute, but free space is the one number that must move the instant a
      // delete lands — caching it made the header freeze after a cleanup.
      freeBytes,
      usedBytes,
      // Percent-full describes the shared pool, which is what actually runs out.
      usedFraction: totalBytes > 0 ? (totalBytes - freeBytes) / totalBytes : 0,
      isPrimary: mount.mountPoint === primaryMount,
      sharesPool: mount.fsType === "apfs",
    });
  }

  volumes.sort((a, b) => b.usedBytes - a.usedBytes);
  const primaryRow =
    volumes.find((volume) => volume.isPrimary) ??
    volumes[0] ?? {
      mountPoint: primaryMount,
      device: null,
      fsType: null,
      label: null,
      totalBytes: 0,
      freeBytes: 0,
      usedBytes: 0,
      usedFraction: 0,
      isPrimary: true,
      sharesPool: false,
    };

  /**
   * The headline row reports the *pool's* used bytes, not the mount's own.
   *
   * On APFS `/` is the sealed system volume and its `CapacityInUse` is ~12GB —
   * true, and completely misleading as an answer to "how full is my disk",
   * because the 460GB that actually filled the container lives on the Data
   * volume beside it. Per-volume figures stay in `volumes` for the breakdown;
   * the headline uses total − free so it agrees with its own percentage and the
   * capacity bar's segments sum to the whole.
   */
  const primary: Volume = {
    ...primaryRow,
    usedBytes: Math.max(0, primaryRow.totalBytes - primaryRow.freeBytes),
  };

  const snapshotMounts = [
    ...new Set(volumes.filter((volume) => volume.sharesPool).map((v) => v.mountPoint)),
  ].slice(0, 8);
  // Snapshots are created hourly at most; another `tmutil` fork per minute buys
  // nothing.
  if (snapshotCache === null || Date.now() - snapshotCache.at >= ENRICHMENT_TTL_MS) {
    snapshotCache = { at: Date.now(), rows: await readSnapshots(snapshotMounts) };
  }
  const snapshots = snapshotCache.rows;
  const snapshotBytes = snapshots.reduce((sum, row) => sum + (row.bytes ?? 0), 0);

  return {
    primary,
    volumes,
    snapshots,
    purgeableBytes: snapshotBytes > 0 ? snapshotBytes : null,
  };
}

/* ------------------------------------------------------------------ */
/* Pressure                                                            */
/* ------------------------------------------------------------------ */

export const DEFAULT_THRESHOLDS: Thresholds = {
  watchPercent: 80,
  warnPercent: 90,
  criticalPercent: 95,
  minFreeGb: 10,
};

export interface PressureVerdict {
  level: PressureLevel;
  reason: string;
}

/**
 * Percent-full alone misleads at both ends: 90% of a 250GB disk still leaves
 * 25GB, while 90% of a 4TB array leaves 400GB. An absolute floor catches the
 * case that actually breaks builds — so whichever signal is angrier wins.
 */
export function evaluatePressure(volume: Volume, thresholds: Thresholds): PressureVerdict {
  const percent = volume.usedFraction * 100;
  const freeGb = volume.freeBytes / 1e9;
  const byPercent: PressureLevel =
    percent >= thresholds.criticalPercent
      ? "critical"
      : percent >= thresholds.warnPercent
        ? "warn"
        : percent >= thresholds.watchPercent
          ? "watch"
          : "ok";
  const byFree: PressureLevel =
    freeGb <= thresholds.minFreeGb / 4
      ? "critical"
      : freeGb <= thresholds.minFreeGb / 2
        ? "warn"
        : freeGb <= thresholds.minFreeGb
          ? "watch"
          : "ok";

  const rank: Record<PressureLevel, number> = { ok: 0, watch: 1, warn: 2, critical: 3 };
  const level = rank[byFree] > rank[byPercent] ? byFree : byPercent;
  const percentText = `${percent.toFixed(1)}% full`;
  const freeText = `${freeGb.toFixed(1)} GB free`;

  if (level === "ok") return { level, reason: `${percentText}, ${freeText}.` };
  const driver = rank[byFree] > rank[byPercent] ? "free space" : "percent used";
  return {
    level,
    reason:
      driver === "free space"
        ? `Only ${freeText} left (floor is ${thresholds.minFreeGb} GB) — ${percentText}.`
        : `${percentText} (threshold ${thresholds.warnPercent}%) — ${freeText}.`,
  };
}
