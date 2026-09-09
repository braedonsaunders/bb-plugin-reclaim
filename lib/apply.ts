/**
 * Execution.
 *
 * The one rule that makes this safe: **`apply` never accepts a path.** It takes
 * candidate ids that Reclaim itself minted while building a plan, looks up the
 * executor it stored alongside them, and re-authorizes the path immediately
 * before removal. A caller — the UI, the CLI, or an agent — cannot name an
 * arbitrary target, and a stale plan cannot delete something that has since
 * moved outside the authorized roots.
 */
import { rm } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { ApplyResult } from "./contract";
import type { DetectedCandidate } from "./reclaimers";
import { authorizePath } from "./roots";
import {
  compactDiskImage,
  findDockerCli,
  parseDockerReclaimed,
  readDockerState,
} from "./docker";

const exec = promisify(execFile);

export interface ApplyOptions {
  candidates: DetectedCandidate[];
  roots: string[];
  dryRun: boolean;
  log: (message: string) => void;
  /** Aborts between items; an in-flight removal always finishes. */
  signal?: AbortSignal;
}

// `parseDockerReclaimed` lives beside the rest of the Docker output parsing.
export { parseDockerReclaimed } from "./docker";

export async function applyCandidates(options: ApplyOptions): Promise<ApplyResult> {
  const { candidates, roots, dryRun, log, signal } = options;
  const items: ApplyResult["items"] = [];
  let bytesFreed = 0;
  let succeeded = 0;
  let failed = 0;

  for (const candidate of candidates) {
    if (signal?.aborted) break;

    if (candidate.executor.kind === "docker-compact") {
      if (dryRun) {
        items.push({ id: candidate.id, path: candidate.path, bytes: candidate.bytes, ok: true, error: null });
        bytesFreed += candidate.bytes;
        succeeded += 1;
        continue;
      }
      const state = await readDockerState();
      const outcome = await compactDiskImage(state, log);
      if (outcome.ok) {
        succeeded += 1;
        // Measured from the host file's allocated blocks before and after, not
        // estimated — this is the one number the user came for.
        bytesFreed += outcome.bytesFreed;
        items.push({
          id: candidate.id,
          path: candidate.path,
          bytes: outcome.bytesFreed,
          ok: true,
          error: null,
        });
      } else {
        failed += 1;
        items.push({
          id: candidate.id,
          path: candidate.path,
          bytes: 0,
          ok: false,
          error: outcome.error,
        });
      }
      continue;
    }

    if (candidate.executor.kind === "docker") {
      const { args, label } = candidate.executor;
      if (dryRun) {
        items.push({ id: candidate.id, path: candidate.path, bytes: candidate.bytes, ok: true, error: null });
        bytesFreed += candidate.bytes;
        succeeded += 1;
        continue;
      }
      try {
        // Resolve the CLI rather than trusting PATH: the BB daemon does not
        // inherit a login shell, and Docker Desktop installs outside it.
        const cli = (await findDockerCli()) ?? "docker";
        const { stdout } = await exec(cli, args, {
          timeout: 10 * 60_000,
          maxBuffer: 8 * 1024 * 1024,
        });
        // Docker reports what it actually removed, which is more honest than
        // the estimate we showed in the plan.
        const actual = parseDockerReclaimed(stdout) || candidate.bytes;
        bytesFreed += actual;
        succeeded += 1;
        items.push({ id: candidate.id, path: candidate.path, bytes: actual, ok: true, error: null });
        log(`docker ${label}: reclaimed ${actual} bytes`);
      } catch (cause) {
        failed += 1;
        const error = cause instanceof Error ? cause.message : String(cause);
        items.push({ id: candidate.id, path: candidate.path, bytes: 0, ok: false, error });
      }
      continue;
    }

    const target = candidate.executor.path;
    const verdict = await authorizePath(target, roots);
    if (!verdict.ok) {
      failed += 1;
      items.push({
        id: candidate.id,
        path: target,
        bytes: 0,
        ok: false,
        error: verdict.message ?? "Refused.",
      });
      log(`refused ${target}: ${verdict.reason}`);
      continue;
    }

    if (dryRun) {
      succeeded += 1;
      bytesFreed += candidate.bytes;
      items.push({ id: candidate.id, path: target, bytes: candidate.bytes, ok: true, error: null });
      continue;
    }

    try {
      // Delete the resolved path, not the requested one, so the authorization
      // and the removal cannot disagree about what the symlink pointed at.
      await rm(verdict.resolvedPath!, { recursive: true, force: true });
      succeeded += 1;
      bytesFreed += candidate.bytes;
      items.push({ id: candidate.id, path: target, bytes: candidate.bytes, ok: true, error: null });
      log(`removed ${target} (${candidate.bytes} bytes)`);
    } catch (cause) {
      failed += 1;
      const error = cause instanceof Error ? cause.message : String(cause);
      items.push({ id: candidate.id, path: target, bytes: 0, ok: false, error });
      log(`failed ${target}: ${error}`);
    }
  }

  return {
    dryRun,
    attempted: items.length,
    succeeded,
    failed,
    bytesFreed,
    items,
  };
}
