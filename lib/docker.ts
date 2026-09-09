/**
 * Docker integration.
 *
 * The thing that makes Docker different from every other reclaimer: on macOS
 * and Windows the daemon lives inside a VM whose disk is one enormous **sparse
 * file** on your real disk. `docker system df` describes space *inside* that
 * VM, and pruning frees space *inside* that VM — but the host file does not
 * shrink, because nothing told the host those blocks were released.
 *
 * So a user can prune 40GB of images, watch `docker system df` go to almost
 * zero, and see no change whatsoever in their free space. Reclaim measures the
 * host file's allocated blocks directly, reports the gap, and can close it by
 * running `fstrim` inside the VM.
 */
import { execFile } from "node:child_process";
import { access, stat } from "node:fs/promises";
import { homedir, platform } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const IS_DARWIN = platform() === "darwin";

/** Docker Desktop is often installed outside the daemon's own PATH. */
const CLI_CANDIDATES = [
  "docker",
  "/usr/local/bin/docker",
  "/opt/homebrew/bin/docker",
  "/Applications/Docker.app/Contents/Resources/bin/docker",
];

/** VM disk images, newest Docker Desktop layout first. */
function diskImageCandidates(home: string): string[] {
  if (!IS_DARWIN) return [];
  const base = join(home, "Library", "Containers", "com.docker.docker", "Data");
  return [
    join(base, "vms", "0", "data", "Docker.raw"),
    join(base, "vms", "0", "Docker.raw"),
    join(base, "vms", "0", "data", "Docker.qcow2"),
    join(base, "vms", "0", "Docker.qcow2"),
  ];
}

export interface DockerUsage {
  buildCacheBytes: number;
  danglingImageBytes: number;
  stoppedContainerBytes: number;
  unusedVolumeBytes: number;
  /** Everything Docker reports holding, reclaimable or not. */
  totalBytes: number;
}

export interface DockerDiskImage {
  path: string;
  /** What `ls -l` shows — meaningless, the file is sparse. */
  apparentBytes: number;
  /** Blocks actually on your disk. This is the number that matters. */
  allocatedBytes: number;
}

export interface DockerState {
  cli: string | null;
  daemonRunning: boolean;
  /** Why Docker cannot be acted on, or null when it can. */
  reason: string | null;
  usage: DockerUsage | null;
  diskImage: DockerDiskImage | null;
}

async function runDocker(
  cli: string,
  args: string[],
  timeoutMs = 15_000,
): Promise<string | null> {
  try {
    const { stdout } = await exec(cli, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return stdout;
  } catch {
    return null;
  }
}

export async function findDockerCli(): Promise<string | null> {
  for (const candidate of CLI_CANDIDATES) {
    if (candidate.startsWith("/")) {
      try {
        await access(candidate);
        return candidate;
      } catch {
        continue;
      }
    }
    // Bare name: let the OS resolve it against PATH.
    const found = await runDocker(candidate, ["--version"], 5_000);
    if (found !== null) return candidate;
  }
  return null;
}

/** Docker prints `1.234GB (45%)`; the percentage is noise here. */
export function parseDockerSize(text: string): number {
  const match = /([\d.]+)\s*([KMGTP]?i?B)/i.exec(text);
  if (match === null) return 0;
  const value = Number(match[1]);
  if (!Number.isFinite(value)) return 0;
  const unit = match[2]!.toUpperCase().replace("I", "");
  const scale: Record<string, number> = { B: 1, KB: 1e3, MB: 1e6, GB: 1e9, TB: 1e12, PB: 1e15 };
  return Math.round(value * (scale[unit] ?? 1));
}

/** `docker system df --format {{json .}}` emits one JSON object per section. */
export function parseDockerDf(stdout: string): DockerUsage {
  const usage: DockerUsage = {
    buildCacheBytes: 0,
    danglingImageBytes: 0,
    stoppedContainerBytes: 0,
    unusedVolumeBytes: 0,
    totalBytes: 0,
  };
  for (const line of stdout.split("\n")) {
    const trimmed = line.trim();
    if (trimmed === "") continue;
    let row: Record<string, unknown>;
    try {
      row = JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      continue;
    }
    const type = String(row["Type"] ?? "");
    const reclaimable = parseDockerSize(String(row["Reclaimable"] ?? ""));
    usage.totalBytes += parseDockerSize(String(row["Size"] ?? ""));
    if (type === "Build Cache") usage.buildCacheBytes = reclaimable;
    else if (type === "Images") usage.danglingImageBytes = reclaimable;
    else if (type === "Containers") usage.stoppedContainerBytes = reclaimable;
    else if (type === "Local Volumes") usage.unusedVolumeBytes = reclaimable;
  }
  return usage;
}

/** `docker ... prune` ends with `Total reclaimed space: 4.2GB`. */
export function parseDockerReclaimed(stdout: string): number {
  const match = /Total reclaimed space:\s*(.+)/i.exec(stdout);
  return match === null ? 0 : parseDockerSize(match[1]!.trim());
}

export async function readDiskImage(home = homedir()): Promise<DockerDiskImage | null> {
  for (const path of diskImageCandidates(home)) {
    try {
      const stats = await stat(path);
      return {
        path,
        apparentBytes: stats.size,
        // `blocks * 512` is what the file actually costs. A Docker.raw can
        // report 460GB apparent while occupying 66GB.
        allocatedBytes: stats.blocks > 0 ? stats.blocks * 512 : stats.size,
      };
    } catch {
      continue;
    }
  }
  return null;
}

export async function readDockerState(home = homedir()): Promise<DockerState> {
  const diskImage = await readDiskImage(home);
  const cli = await findDockerCli();
  if (cli === null) {
    return {
      cli: null,
      daemonRunning: false,
      reason: "Docker is not installed.",
      usage: null,
      diskImage,
    };
  }

  const info = await runDocker(cli, ["info", "--format", "{{.ServerVersion}}"], 10_000);
  if (info === null) {
    return {
      cli,
      daemonRunning: false,
      // Say what it is costing even while stopped — a stopped daemon still
      // holds every byte of its disk image.
      reason:
        diskImage === null
          ? "Docker is installed but not running."
          : "Docker is not running. Start Docker Desktop to reclaim its space.",
      usage: null,
      diskImage,
    };
  }

  const df = await runDocker(cli, ["system", "df", "--format", "{{json .}}"], 20_000);
  return {
    cli,
    daemonRunning: true,
    reason: null,
    usage: df === null ? null : parseDockerDf(df),
    diskImage,
  };
}

/**
 * Space the host could get back by compacting the VM image.
 *
 * The host file only ever grows: blocks freed inside the VM stay allocated on
 * your disk until something issues a TRIM. The gap between what the file costs
 * and what Docker says is inside it is that dead space.
 */
export function trimmableBytes(state: DockerState): number {
  if (state.diskImage === null || state.usage === null) return 0;
  const slack = state.diskImage.allocatedBytes - state.usage.totalBytes;
  // Below a gigabyte this is filesystem overhead, not something worth doing.
  return slack > 1e9 ? slack : 0;
}

/**
 * Issue a TRIM inside the Docker VM so the host's sparse file shrinks.
 *
 * `--pid=host` plus `nsenter` puts us in the VM's own mount namespace, which is
 * where the filesystem holding `/var/lib/docker` actually lives. A ~4MB busybox
 * is used rather than a heavier base image, and only pulled when the host has
 * nothing suitable already — pulling a large image to save space would be
 * self-defeating.
 */
export async function compactDiskImage(
  state: DockerState,
  log: (message: string) => void,
): Promise<{ ok: boolean; bytesFreed: number; error: string | null }> {
  if (state.cli === null || !state.daemonRunning) {
    return { ok: false, bytesFreed: 0, error: "Docker is not running." };
  }
  const before = await readDiskImage();
  if (before === null) {
    return { ok: false, bytesFreed: 0, error: "No Docker disk image on this machine." };
  }

  const image = (await pickLocalHelperImage(state.cli)) ?? "busybox:latest";
  log(`compacting Docker disk image using ${image}`);
  try {
    const { stdout } = await exec(
      state.cli,
      [
        "run",
        "--rm",
        "--privileged",
        "--pid=host",
        image,
        "nsenter",
        "-t",
        "1",
        "-m",
        "-u",
        "-i",
        "-n",
        "--",
        "fstrim",
        "-av",
      ],
      { timeout: 15 * 60_000, maxBuffer: 4 * 1024 * 1024 },
    );
    log(`fstrim: ${stdout.trim().slice(0, 400)}`);
  } catch (cause) {
    return {
      ok: false,
      bytesFreed: 0,
      error: cause instanceof Error ? cause.message : String(cause),
    };
  }

  // The host releases blocks asynchronously; give it a moment before measuring.
  await new Promise((done) => setTimeout(done, 3_000));
  const after = await readDiskImage();
  const bytesFreed =
    after === null ? 0 : Math.max(0, before.allocatedBytes - after.allocatedBytes);
  return { ok: true, bytesFreed, error: null };
}

/** Prefer an image already on disk over pulling one. */
async function pickLocalHelperImage(cli: string): Promise<string | null> {
  const stdout = await runDocker(cli, ["image", "ls", "--format", "{{.Repository}}:{{.Tag}}"], 10_000);
  if (stdout === null) return null;
  const local = stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line !== "" && !line.endsWith(":<none>"));
  for (const preferred of ["busybox", "alpine", "debian", "ubuntu"]) {
    const match = local.find((row) => row.startsWith(`${preferred}:`));
    if (match !== undefined) return match;
  }
  return null;
}
