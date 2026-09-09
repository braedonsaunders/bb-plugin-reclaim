/**
 * Reclaim — disk pressure watchdog, index, browser and cleanup engine.
 *
 * Four moving parts:
 *
 *   scanner  a full-volume walk that streams directory totals into SQLite
 *   planner  reclaimer rules over that index, producing a costed plan
 *   guard    a capacity poll that escalates: observe → auto-clean → agent
 *   surfaces RPC for the app, `bb reclaim` for humans, tools for agents
 *
 * The scanner is deliberately slow and thorough (~75s for 6.7M entries) and
 * everything else reads its output, so no user-facing action ever waits on a
 * filesystem walk.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  CHANNEL_CAPACITY,
  CHANNEL_INDEX,
  CHANNEL_PLAN,
  rpcShape,
  type ApplyResult,
  type Capacity,
  type Config,
  type Consumer,
  type Group,
  type IndexState,
  type Overview,
  type Plan,
  type PressureLevel,
  type Risk,
  type ScanProgress,
  type Thresholds,
} from "./lib/contract";
import { IndexStore, MIGRATIONS } from "./lib/index-store";
import { walk, type DirRecord } from "./lib/walk";
import { DEFAULT_THRESHOLDS, evaluatePressure, readCapacity } from "./lib/volumes";
import { listDirectory } from "./lib/browse";
import {
  RECLAIMERS,
  defaultRoots,
  type DetectedCandidate,
  type DetectedGroup,
} from "./lib/reclaimers";
import { applyCandidates } from "./lib/apply";
import { parseRoots } from "./lib/roots";
import { formatAgo, formatBytes, formatCount, formatDuration, padBytes, shortenPath } from "./lib/format";

export const rpcContract = defineRpcContract(rpcShape);

const HOME = homedir();
const CAPACITY_POLL_MS = 60_000;
/** Never escalate to an agent more than once in this window. */
const ESCALATION_COOLDOWN_MS = 6 * 60 * 60_000;
/** Directory names the browser badges as reclaimable. */
const RECLAIMABLE_BADGES = new Map<string, string>([
  ["node_modules", "Dependencies"],
  ["DerivedData", "Xcode"],
  [".next", "Build output"],
  [".turbo", "Build output"],
  ["dist", "Build output"],
  ["build", "Build output"],
  ["target", "Build output"],
  ["__pycache__", "Build output"],
  [".gradle", "Build output"],
]);

/* ------------------------------------------------------------------ */
/* Scanner                                                             */
/* ------------------------------------------------------------------ */

function createScanner(bb: BbPluginApi, store: IndexStore) {
  let state: IndexState = restore();
  let controller: AbortController | null = null;
  let running: Promise<IndexState> | null = null;

  function restore(): IndexState {
    const saved = store.getMeta<IndexState>("index-state");
    if (saved === null) {
      return {
        status: "never",
        rootPath: "/",
        generation: 0,
        startedAtMs: null,
        finishedAtMs: null,
        durationMs: null,
        filesSeen: 0,
        dirsSeen: 0,
        dirsStored: 0,
        bytesIndexed: 0,
        unreadable: 0,
        error: null,
        progress: null,
      };
    }
    // A scan interrupted by a reload or crash is not "scanning" any more.
    return saved.status === "scanning"
      ? { ...saved, status: store.currentGeneration > 0 ? "ready" : "never", progress: null }
      : { ...saved, progress: null };
  }

  function publish(persist = false): void {
    if (persist) store.setMeta("index-state", { ...state, progress: null });
    bb.realtime.publish(CHANNEL_INDEX, { at: Date.now(), status: state.status });
  }

  async function run(rootPath: string): Promise<IndexState> {
    const generation = store.currentGeneration + 1;
    controller = new AbortController();
    const startedAtMs = Date.now();
    state = {
      ...state,
      status: "scanning",
      rootPath,
      startedAtMs,
      finishedAtMs: null,
      durationMs: null,
      error: null,
      progress: null,
    };
    publish();
    bb.log.info(`scan started: ${rootPath} (generation ${generation})`);

    try {
      const result = await walk({
        root: rootPath,
        signal: controller.signal,
        onDirectory: (record: DirRecord) => store.stageDir(generation, record),
        onProgress: (progress: ScanProgress) => {
          state = { ...state, progress };
          bb.realtime.publish(CHANNEL_INDEX, { at: Date.now(), status: "scanning" });
        },
      });
      store.flush(generation);

      if (result.aborted) {
        store.discardGeneration(generation);
        state = {
          ...state,
          status: store.currentGeneration > 0 ? "ready" : "never",
          progress: null,
          error: "Scan cancelled.",
        };
        publish(true);
        bb.log.info("scan cancelled");
        return state;
      }

      store.writeTopFiles(generation, result.topFiles);
      store.commitGeneration(generation);
      state = {
        status: "ready",
        rootPath,
        generation,
        startedAtMs,
        finishedAtMs: Date.now(),
        durationMs: result.durationMs,
        filesSeen: result.filesSeen,
        dirsSeen: result.dirsSeen,
        dirsStored: result.dirsStored,
        bytesIndexed: result.totalBytes,
        unreadable: result.unreadable,
        error: null,
        progress: null,
      };
      publish(true);
      bb.realtime.publish(CHANNEL_PLAN, { at: Date.now(), reason: "scan" });
      bb.log.info(
        `scan finished in ${formatDuration(result.durationMs)}: ` +
          `${formatCount(result.filesSeen)} files, ${formatCount(result.dirsStored)} indexed dirs, ` +
          `${formatBytes(result.totalBytes)}, ${result.unreadable} unreadable`,
      );
      return state;
    } catch (cause) {
      store.discardGeneration(generation);
      const error = cause instanceof Error ? cause.message : String(cause);
      state = { ...state, status: "failed", error, progress: null };
      publish(true);
      bb.log.error(`scan failed: ${error}`);
      return state;
    } finally {
      controller = null;
      running = null;
    }
  }

  return {
    get state(): IndexState {
      return state;
    },
    isRunning(): boolean {
      return running !== null;
    },
    start(rootPath: string, force = false): Promise<IndexState> {
      if (running !== null) return running;
      if (!force && state.status === "ready" && state.rootPath === rootPath) {
        return Promise.resolve(state);
      }
      running = run(rootPath);
      return running;
    },
    cancel(): IndexState {
      controller?.abort();
      return state;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Planner                                                             */
/* ------------------------------------------------------------------ */

/** How long a built plan is served before it is considered stale. */
const PLAN_TTL_MS = 10 * 60_000;

function createPlanner(bb: BbPluginApi, store: IndexStore) {
  let plan: Plan | null = null;
  let executors = new Map<string, DetectedCandidate>();
  let builtAtMs = 0;
  let inflight: Promise<Plan> | null = null;

  /**
   * Worktrees whose thread is still around. Their dependencies are left alone
   * even when they look stale, because pulling node_modules out from under a
   * running agent turns a cleanup into an outage.
   */
  async function liveWorktrees(): Promise<Set<string>> {
    const live = new Set<string>();
    try {
      const threads = await bb.sdk.threads.list({ includeHidden: true });
      const environmentIds = new Set<string>();
      for (const thread of threads) {
        if (thread.archivedAt || thread.deletedAt) continue;
        if (thread.environmentId) environmentIds.add(thread.environmentId);
      }
      for (const environmentId of environmentIds) {
        try {
          const environment = await bb.sdk.environments.get({ environmentId });
          const path = (environment as { workspacePath?: string }).workspacePath;
          if (typeof path === "string" && path !== "") live.add(path);
        } catch {
          // An environment we cannot read is treated as live: skipping a
          // candidate costs disk, deleting a live one costs work.
        }
      }
    } catch (cause) {
      bb.log.warn(
        `worktree liveness unavailable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }
    return live;
  }

  async function build(config: Config): Promise<Plan> {
    const nowMs = Date.now();
    const context = {
      store,
      roots: config.roots,
      home: HOME,
      nowMs,
      staleDays: config.staleDays,
      dockerEnabled: config.dockerEnabled,
      liveWorktrees: await liveWorktrees(),
      log: (message: string) => bb.log.info(`reclaimer: ${message}`),
    };

    const detected: DetectedGroup[] = [];
    const warnings: string[] = [];
    for (const reclaimer of RECLAIMERS) {
      try {
        detected.push(await reclaimer.detect(context));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        warnings.push(`${reclaimer.title} could not be checked: ${message}`);
        bb.log.warn(`reclaimer ${reclaimer.id} failed: ${message}`);
      }
    }

    const nextExecutors = new Map<string, DetectedCandidate>();
    const groups: Group[] = detected.map((group) => {
      for (const candidate of group.candidates) nextExecutors.set(candidate.id, candidate);
      return {
        ...group,
        // The executor is server-only state; it must never cross the wire.
        candidates: group.candidates.map(({ executor: _executor, ...rest }) => rest),
      };
    });
    groups.sort((a, b) => b.bytes - a.bytes);

    if (store.currentGeneration === 0) {
      warnings.push("No index yet — sizes come from live measurement and the plan may be incomplete.");
    }

    executors = nextExecutors;
    builtAtMs = nowMs;
    plan = {
      builtAtMs: nowMs,
      totalBytes: groups.reduce((sum, group) => sum + group.bytes, 0),
      defaultBytes: groups.reduce(
        (sum, group) =>
          sum +
          group.candidates.reduce(
            (inner, candidate) => inner + (candidate.defaultSelected ? candidate.bytes : 0),
            0,
          ),
        0,
      ),
      groups,
      roots: config.roots,
      warnings,
      stale: false,
    };
    bb.realtime.publish(CHANNEL_PLAN, { at: nowMs, reason: "rebuilt" });
    return plan;
  }

  return {
    async get(config: Config, force = false): Promise<Plan> {
      const fresh = plan !== null && Date.now() - builtAtMs < PLAN_TTL_MS;
      if (!force && fresh) return { ...plan!, stale: false };
      if (inflight !== null) return inflight;
      inflight = build(config).finally(() => {
        inflight = null;
      });
      return inflight;
    },
    peek(): Plan | null {
      return plan === null ? null : { ...plan, stale: Date.now() - builtAtMs >= PLAN_TTL_MS };
    },
    lookup(ids: string[]): { found: DetectedCandidate[]; missing: string[] } {
      const found: DetectedCandidate[] = [];
      const missing: string[] = [];
      for (const id of ids) {
        const candidate = executors.get(id);
        if (candidate === undefined) missing.push(id);
        else found.push(candidate);
      }
      return { found, missing };
    },
    invalidate(): void {
      builtAtMs = 0;
    },
  };
}

/* ------------------------------------------------------------------ */
/* Text rendering (CLI + agent tools)                                  */
/* ------------------------------------------------------------------ */

function renderCapacity(capacity: Capacity): string {
  const primary = capacity.primary;
  const lines = [
    `${primary.label ?? primary.mountPoint}  ${formatBytes(primary.usedBytes)} used · ` +
      `${formatBytes(primary.freeBytes)} free of ${formatBytes(primary.totalBytes)} ` +
      `(${(primary.usedFraction * 100).toFixed(1)}% full)`,
    `Pressure: ${capacity.level.toUpperCase()} — ${capacity.reason}`,
  ];
  if (capacity.snapshots.length > 0) {
    lines.push(`Local snapshots: ${capacity.snapshots.length} (macOS may release these under pressure)`);
  }
  return lines.join("\n");
}

function renderIndex(state: IndexState): string {
  if (state.status === "never") return "Index: never scanned. Run `bb reclaim scan`.";
  if (state.status === "scanning") {
    const progress = state.progress;
    return progress === null
      ? "Index: scanning…"
      : `Index: scanning — ${formatCount(progress.entriesSeen)} entries, ` +
          `${formatBytes(progress.bytesSeen)}, ${formatCount(progress.entriesPerSecond)}/s`;
  }
  if (state.status === "failed") return `Index: failed — ${state.error ?? "unknown error"}`;
  return (
    `Index: ${formatCount(state.filesSeen)} files in ${formatCount(state.dirsStored)} directories, ` +
    `${formatBytes(state.bytesIndexed)}, scanned ${formatAgo(state.finishedAtMs)} ` +
    `in ${formatDuration(state.durationMs ?? 0)}` +
    (state.unreadable > 0 ? ` (${formatCount(state.unreadable)} unreadable)` : "")
  );
}

function renderConsumers(title: string, rows: Consumer[]): string {
  if (rows.length === 0) return `${title}: none.`;
  const lines = [`${title}:`];
  for (const row of rows) {
    lines.push(`  ${padBytes(row.bytes)}  ${row.displayPath}`);
  }
  return lines.join("\n");
}

function renderPlan(plan: Plan, options: { verbose?: boolean } = {}): string {
  const lines = [
    `Reclaimable: ${formatBytes(plan.totalBytes)} total, ` +
      `${formatBytes(plan.defaultBytes)} preselected`,
  ];
  for (const group of plan.groups) {
    if (!group.available) {
      lines.push(`  —  ${group.title}: ${group.unavailableReason ?? "unavailable"}`);
      continue;
    }
    if (group.count === 0) continue;
    lines.push(`  ${padBytes(group.bytes)}  ${group.title} (${group.count}, ${group.risk})`);
    if (options.verbose === true) {
      for (const candidate of group.candidates.slice(0, 20)) {
        lines.push(
          `      ${padBytes(candidate.bytes)}  ${candidate.id}  ${candidate.displayPath}` +
            `${candidate.defaultSelected ? "  *" : ""}`,
        );
      }
      if (group.candidates.length > 20) {
        lines.push(`      … ${group.candidates.length - 20} more`);
      }
    }
  }
  for (const warning of plan.warnings) lines.push(`  ! ${warning}`);
  if (options.verbose === true) lines.push("  * = preselected");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* Plugin                                                              */
/* ------------------------------------------------------------------ */

export default async function plugin(bb: BbPluginApi) {
  bb.log.info("loaded");

  const db = bb.storage.database();
  bb.storage.migrate(db, MIGRATIONS);
  const store = new IndexStore(db);

  const settings = bb.settings.define({
    scanRoot: {
      type: "string",
      label: "Scan root",
      default: "/",
    },
    authorizedRoots: {
      type: "string",
      label: "Authorized cleanup roots",
      experimental_multiline: true,
      default: defaultRoots(HOME).join("\n"),
    },
    watchPercent: { type: "number", label: "Watch at (% full)", default: 80 },
    warnPercent: { type: "number", label: "Warn at (% full)", default: 90 },
    criticalPercent: { type: "number", label: "Critical at (% full)", default: 95 },
    minFreeGb: { type: "number", label: "Minimum free space (GB)", default: 10 },
    staleDays: { type: "number", label: "Treat a project as idle after (days)", default: 45 },
    scanIntervalHours: { type: "number", label: "Rescan every (hours)", default: 12 },
    autoClean: {
      type: "boolean",
      label: "Auto-clean under pressure",
      default: false,
    },
    autoCleanEveryHours: {
      type: "number",
      label: "Also auto-clean every (hours, 0 = off)",
      default: 0,
    },
    autoCleanMaxRisk: {
      type: "select",
      label: "Auto-clean may remove",
      options: ["safe", "rebuildable"],
      default: "safe",
    },
    agentEscalation: {
      type: "boolean",
      label: "Ask an agent for help when critical",
      default: false,
    },
    escalationProject: { type: "project", label: "Project for escalation threads" },
    dockerEnabled: { type: "boolean", label: "Include Docker", default: true },
  });

  async function readConfig(): Promise<Config> {
    const values = await settings.get();
    const roots = parseRoots(values.authorizedRoots, HOME);
    const thresholds: Thresholds = {
      watchPercent: values.watchPercent,
      warnPercent: values.warnPercent,
      criticalPercent: values.criticalPercent,
      minFreeGb: values.minFreeGb,
    };
    return {
      roots,
      scanRoot: resolve(values.scanRoot.trim() === "" ? "/" : values.scanRoot.trim()),
      thresholds,
      autoCleanEnabled: values.autoClean,
      autoCleanEveryHours: Math.max(0, values.autoCleanEveryHours),
      autoCleanMaxRisk: values.autoCleanMaxRisk === "rebuildable" ? "rebuildable" : "safe",
      lastAutoCleanMs: store.getMeta<number>("last-auto-clean"),
      agentEscalationEnabled: values.agentEscalation,
      escalationProjectId:
        typeof values.escalationProject === "string" && values.escalationProject !== ""
          ? values.escalationProject
          : null,
      staleDays: Math.max(1, values.staleDays),
      scanIntervalHours: Math.max(1, values.scanIntervalHours),
      dockerEnabled: values.dockerEnabled,
    };
  }

  const scanner = createScanner(bb, store);
  const planner = createPlanner(bb, store);

  /**
   * Last capacity reading, kept in memory for `contributeInstructions`.
   *
   * That callback is synchronous and runs on every thread start and turn
   * submit, so it cannot do I/O. The guard already polls once a minute; this
   * just makes its most recent answer readable without blocking a turn.
   */
  let lastCapacity: Capacity | null = null;

  async function readCapacitySnapshot(config: Config): Promise<Capacity> {
    const reading = await readCapacity("/");
    const verdict = evaluatePressure(reading.primary, config.thresholds);
    lastCapacity = {
      sampledAt: new Date().toISOString(),
      primary: reading.primary,
      volumes: reading.volumes,
      snapshots: reading.snapshots,
      purgeableBytes: reading.purgeableBytes,
      level: verdict.level,
      reason: verdict.reason,
      thresholds: config.thresholds,
    };
    return lastCapacity;
  }

  function toConsumer(
    row: { path: string; treeBytes?: number; bytes?: number; newestMtimeMs?: number; mtimeMs?: number },
    total: number,
    kind: "dir" | "file",
  ): Consumer {
    const bytes = row.treeBytes ?? row.bytes ?? 0;
    return {
      path: row.path,
      displayPath: shortenPath(row.path, HOME),
      bytes,
      kind,
      share: total > 0 ? bytes / total : 0,
      mtimeMs: row.newestMtimeMs ?? row.mtimeMs ?? null,
    };
  }

  async function buildOverview(): Promise<Overview> {
    const config = await readConfig();
    const capacity = await readCapacitySnapshot(config);
    const index = scanner.state;
    const total = capacity.primary.usedBytes || index.bytesIndexed || 1;

    const topDirectories = store
      // The scan root is by definition the largest directory and tells you
      // nothing; the "where the space went" band already covers that level.
      .getTopDirectories(20, { excludePaths: new Set([index.rootPath]) })
      .map((row) => toConsumer(row, total, "dir"));
    const topFiles = store.getTopFiles(20).map((row) => toConsumer(row, total, "file"));
    const rootBreakdown = store
      .getChildren(index.rootPath)
      .slice(0, 14)
      .map((row) => toConsumer(row, total, "dir"));

    const cached = planner.peek();
    return {
      capacity,
      index,
      topDirectories,
      topFiles,
      rootBreakdown,
      plan:
        cached === null
          ? null
          : {
              totalBytes: cached.totalBytes,
              defaultBytes: cached.defaultBytes,
              builtAtMs: cached.builtAtMs,
              groupCount: cached.groups.filter((group) => group.count > 0).length,
            },
      recentGuardEvents: store.listGuardEvents(20).map((event) => ({
        ...event,
        level: event.level as PressureLevel,
        action: event.action as "observed" | "auto-cleaned" | "escalated" | "suppressed",
      })),
      homeDir: HOME,
    };
  }

  /* ---------------- remediation ---------------- */

  /**
   * The automatic tier is bounded twice over: only candidates a reclaimer
   * *preselected*, and only up to the risk level the user authorized.
   * `careful` is unreachable from here at any setting — the Trash and Docker
   * volumes always need a human.
   */
  function autoCleanIds(plan: Plan, maxRisk: Config["autoCleanMaxRisk"]): string[] {
    const allowed: Risk[] = maxRisk === "rebuildable" ? ["safe", "rebuildable"] : ["safe"];
    const ids: string[] = [];
    for (const group of plan.groups) {
      if (!group.available || !allowed.includes(group.risk)) continue;
      for (const candidate of group.candidates) {
        if (candidate.defaultSelected) ids.push(candidate.id);
      }
    }
    return ids;
  }

  async function autoClean(
    config: Config,
    options: { dryRun?: boolean; trigger: string } = { trigger: "pressure" },
  ): Promise<{ bytesFreed: number; detail: string; result: ApplyResult }> {
    const dryRun = options.dryRun === true;
    const plan = await planner.get(config, true);
    const ids = autoCleanIds(plan, config.autoCleanMaxRisk);
    if (ids.length === 0) {
      return {
        bytesFreed: 0,
        detail: `Nothing in the ${config.autoCleanMaxRisk} tier to clean.`,
        result: { dryRun, attempted: 0, succeeded: 0, failed: 0, bytesFreed: 0, items: [] },
      };
    }

    const { found } = planner.lookup(ids);
    const result = await applyCandidates({
      candidates: found,
      roots: config.roots,
      dryRun,
      log: (message) => bb.log.info(`auto-clean: ${message}`),
    });
    if (!dryRun && result.succeeded > 0) planner.invalidate();
    return {
      bytesFreed: result.bytesFreed,
      detail:
        `${dryRun ? "Would auto-clean" : "Auto-cleaned"} ${result.succeeded}/${result.attempted} ` +
        `${config.autoCleanMaxRisk} items (${options.trigger}), ` +
        `${dryRun ? "freeing" : "freed"} ${formatBytes(result.bytesFreed)}.`,
      result,
    };
  }

  async function escalate(
    config: Config,
    capacity: Capacity,
    note?: string,
  ): Promise<{ threadId: string | null; started: boolean; message: string }> {
    if (config.escalationProjectId === null) {
      return {
        threadId: null,
        started: false,
        message: "Set an escalation project in Reclaim's settings first.",
      };
    }
    const plan = await planner.get(config, true);
    const prompt = [
      "Disk pressure on this machine needs attention.",
      "",
      renderCapacity(capacity),
      "",
      renderIndex(scanner.state),
      "",
      renderPlan(plan, { verbose: true }),
      "",
      note === undefined || note.trim() === "" ? "" : `Operator note: ${note.trim()}`,
      "",
      "You have the Reclaim tools and the `bb reclaim` command.",
      "Work in this order:",
      "1. `reclaim_plan` to see current candidates with exact byte counts and ids.",
      "2. `reclaim_apply` with `dryRun: true` on the ids you intend to free, and check the total.",
      "3. `reclaim_apply` with `dryRun: false` for anything rebuildable — caches, build output,",
      "   dependencies in idle projects. These cost a reinstall, not data.",
      "4. Leave anything marked `careful` alone unless nothing else gets under the threshold;",
      "   report those back instead of acting on them.",
      "",
      "Reclaim only ever deletes inside the authorized roots, so you cannot reach anything else",
      "through these tools. Do not use shell `rm` to work around that boundary.",
      "Finish with a short summary: what you freed, how much, and what is left.",
    ]
      .filter((line) => line !== undefined)
      .join("\n");

    try {
      const thread = await bb.sdk.threads.spawn({
        projectId: config.escalationProjectId,
        environment: { type: "project-default" },
        prompt,
        title: `Disk pressure — ${(capacity.primary.usedFraction * 100).toFixed(0)}% full`,
      });
      return {
        threadId: thread.id,
        started: true,
        message: `Started a cleanup thread (${formatBytes(plan.totalBytes)} reclaimable).`,
      };
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : String(cause);
      bb.log.error(`escalation failed: ${message}`);
      return { threadId: null, started: false, message: `Could not start a thread: ${message}` };
    }
  }

  /* ---------------- RPC ---------------- */

  bb.rpc.register(rpcContract, {
    overview: () => buildOverview(),
    capacity: async () => readCapacitySnapshot(await readConfig()),
    indexState: () => scanner.state,
    async scanStart({ force }) {
      const config = await readConfig();
      void scanner.start(config.scanRoot, force === true).catch(() => {});
      return scanner.state;
    },
    scanCancel: () => scanner.cancel(),
    async list({ path }) {
      return listDirectory({ store, path: resolve(path), reclaimableNames: RECLAIMABLE_BADGES });
    },
    async plan({ force }) {
      return planner.get(await readConfig(), force === true);
    },
    async apply({ ids, dryRun }) {
      const config = await readConfig();
      const { found, missing } = planner.lookup(ids);
      if (missing.length > 0) {
        bb.log.warn(`apply: ${missing.length} unknown candidate ids ignored`);
      }
      const result = await applyCandidates({
        candidates: found,
        roots: config.roots,
        dryRun,
        log: (message) => bb.log.info(`apply: ${message}`),
      });
      if (!dryRun && result.succeeded > 0) {
        planner.invalidate();
        bb.realtime.publish(CHANNEL_CAPACITY, { at: Date.now(), reason: "applied" });
      }
      // Ids the planner no longer knows are reported as failures rather than
      // silently dropped, so a stale UI selection is visible.
      return {
        ...result,
        attempted: result.attempted + missing.length,
        failed: result.failed + missing.length,
        items: [
          ...result.items,
          ...missing.map((id) => ({
            id,
            path: "",
            bytes: 0,
            ok: false,
            error: "Candidate is no longer in the current plan — refresh and try again.",
          })),
        ],
      };
    },
    async escalate({ note }) {
      const config = await readConfig();
      const capacity = await readCapacitySnapshot(config);
      const result = await escalate(config, capacity, note);
      if (result.started) {
        store.recordGuardEvent({
          atMs: Date.now(),
          level: capacity.level,
          freeBytes: capacity.primary.freeBytes,
          usedFraction: capacity.primary.usedFraction,
          action: "escalated",
          detail: "Escalated manually.",
          bytesFreed: 0,
          threadId: result.threadId,
        });
      }
      return result;
    },
    config: () => readConfig(),
    async configUpdate(patch) {
      const current = await readConfig();
      const thresholds = { ...current.thresholds, ...(patch.thresholds ?? {}) };
      await settings.experimental_set({
        ...(patch.roots === undefined
          ? {}
          : // Stored as the multiline text the settings descriptor owns, so the
            // panel and `bb plugin config` stay the same source of truth.
            { authorizedRoots: parseRoots(patch.roots.join("\n"), HOME).join("\n") }),
        ...(patch.scanRoot === undefined ? {} : { scanRoot: patch.scanRoot }),
        ...(patch.thresholds === undefined
          ? {}
          : {
              watchPercent: thresholds.watchPercent,
              warnPercent: thresholds.warnPercent,
              criticalPercent: thresholds.criticalPercent,
              minFreeGb: thresholds.minFreeGb,
            }),
        ...(patch.autoCleanEnabled === undefined ? {} : { autoClean: patch.autoCleanEnabled }),
        ...(patch.autoCleanEveryHours === undefined
          ? {}
          : { autoCleanEveryHours: patch.autoCleanEveryHours }),
        ...(patch.autoCleanMaxRisk === undefined
          ? {}
          : { autoCleanMaxRisk: patch.autoCleanMaxRisk }),
        ...(patch.agentEscalationEnabled === undefined
          ? {}
          : { agentEscalation: patch.agentEscalationEnabled }),
        ...(patch.escalationProjectId === undefined
          ? {}
          : { escalationProject: patch.escalationProjectId }),
        ...(patch.staleDays === undefined ? {} : { staleDays: patch.staleDays }),
        ...(patch.scanIntervalHours === undefined
          ? {}
          : { scanIntervalHours: patch.scanIntervalHours }),
        ...(patch.dockerEnabled === undefined ? {} : { dockerEnabled: patch.dockerEnabled }),
      });
      // Roots and staleness change what counts as a candidate, so the cached
      // plan is no longer describing the settings the user is looking at.
      planner.invalidate();
      return readConfig();
    },
    async projects() {
      const rows = await bb.sdk.projects.list({ includePersonal: true });
      return {
        projects: rows.map((row) => ({ id: row.id, name: row.name })),
      };
    },
    async autoCleanNow({ dryRun }) {
      const config = await readConfig();
      const outcome = await autoClean(config, { dryRun, trigger: "manual" });
      if (!dryRun) {
        store.setMeta("last-auto-clean", Date.now());
        store.recordGuardEvent({
          atMs: Date.now(),
          level: (await readCapacitySnapshot(config)).level,
          freeBytes: 0,
          usedFraction: 0,
          action: outcome.bytesFreed > 0 ? "auto-cleaned" : "suppressed",
          detail: outcome.detail,
          bytesFreed: outcome.bytesFreed,
          threadId: null,
        });
        bb.realtime.publish(CHANNEL_CAPACITY, { at: Date.now(), reason: "auto-clean" });
      }
      return outcome.result;
    },
    guardEvents: ({ limit }) => ({
      events: store.listGuardEvents(limit).map((event) => ({
        ...event,
        level: event.level as PressureLevel,
        action: event.action as "observed" | "auto-cleaned" | "escalated" | "suppressed",
      })),
    }),
  });

  /* ---------------- background: scanning ---------------- */

  const sleep = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((done) => {
      const timer = setTimeout(done, ms);
      signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          done();
        },
        { once: true },
      );
    });

  bb.background.service("scan", {
    async start(signal) {
      // A walk runs for a minute or more. Without this the service would sit
      // inside `scanner.start` ignoring the abort, and a reload would fail with
      // "service scan did not stop".
      signal.addEventListener("abort", () => scanner.cancel(), { once: true });

      const config = await readConfig();
      // A machine with no index has no dashboard, so the first scan is not
      // deferred to the interval.
      if (scanner.state.status === "never" && !signal.aborted) {
        await scanner.start(config.scanRoot).catch(() => {});
      }
      while (!signal.aborted) {
        const current = await readConfig();
        await sleep(current.scanIntervalHours * 3_600_000, signal);
        if (signal.aborted) break;
        await scanner.start(current.scanRoot, true).catch(() => {});
      }
    },
  });

  /* ---------------- background: the guard ---------------- */

  bb.background.service("guard", {
    async start(signal) {
      // Persisted, not just in-memory: a plugin reload is not a pressure event,
      // and treating it as one fills the activity log with duplicates that say
      // nothing happened.
      let lastLevel = store.getMeta<PressureLevel>("last-level");
      let lastEscalationMs = store.getMeta<number>("last-escalation") ?? 0;
      let lastAutoCleanMs = store.getMeta<number>("last-auto-clean") ?? 0;

      while (!signal.aborted) {
        try {
          const config = await readConfig();
          const capacity = await readCapacitySnapshot(config);
          // Remediation can take minutes. Never start any of it on a generation
          // that has already been asked to stop.
          if (signal.aborted) break;
          const level = capacity.level;

          if (level !== lastLevel) {
            bb.realtime.publish(CHANNEL_CAPACITY, { at: Date.now(), level });
            if (lastLevel !== null || level !== "ok") {
              store.recordGuardEvent({
                atMs: Date.now(),
                level,
                freeBytes: capacity.primary.freeBytes,
                usedFraction: capacity.primary.usedFraction,
                action: "observed",
                detail: capacity.reason,
                bytesFreed: 0,
                threadId: null,
              });
            }
            bb.log.info(`pressure ${lastLevel ?? "unknown"} → ${level}: ${capacity.reason}`);
            lastLevel = level;
            store.setMeta("last-level", level);
          }

          const pressured = level === "warn" || level === "critical";
          const sinceCleanMs = Date.now() - lastAutoCleanMs;
          // Two independent triggers, one cooldown. Pressure is reactive; the
          // interval is the housekeeping the user asked for on a schedule.
          const dueByPressure =
            pressured && config.autoCleanEnabled && sinceCleanMs > ESCALATION_COOLDOWN_MS;
          const dueBySchedule =
            config.autoCleanEveryHours > 0 &&
            sinceCleanMs > config.autoCleanEveryHours * 3_600_000;

          if (dueByPressure || dueBySchedule) {
            lastAutoCleanMs = Date.now();
            store.setMeta("last-auto-clean", lastAutoCleanMs);
            const outcome = await autoClean(config, {
              trigger: dueByPressure ? "pressure" : "schedule",
            });
            store.recordGuardEvent({
              atMs: Date.now(),
              level,
              freeBytes: capacity.primary.freeBytes,
              usedFraction: capacity.primary.usedFraction,
              action: outcome.bytesFreed > 0 ? "auto-cleaned" : "suppressed",
              detail: outcome.detail,
              bytesFreed: outcome.bytesFreed,
              threadId: null,
            });
            bb.log.info(outcome.detail);
            if (outcome.bytesFreed > 0) {
              bb.realtime.publish(CHANNEL_CAPACITY, { at: Date.now(), reason: "auto-clean" });
            }
          }

          if (
            level === "critical" &&
            config.agentEscalationEnabled &&
            Date.now() - lastEscalationMs > ESCALATION_COOLDOWN_MS
          ) {
            lastEscalationMs = Date.now();
            store.setMeta("last-escalation", lastEscalationMs);
            const result = await escalate(config, capacity);
            store.recordGuardEvent({
              atMs: Date.now(),
              level,
              freeBytes: capacity.primary.freeBytes,
              usedFraction: capacity.primary.usedFraction,
              action: result.started ? "escalated" : "suppressed",
              detail: result.message,
              bytesFreed: 0,
              threadId: result.threadId,
            });
          }
        } catch (cause) {
          bb.log.warn(`guard: ${cause instanceof Error ? cause.message : String(cause)}`);
        }
        await sleep(CAPACITY_POLL_MS, signal);
      }
    },
  });

  /* ---------------- agent tools ---------------- */

  /**
   * Tell every agent thread about disk pressure, as it happens.
   *
   * The tools and the skill are always registered, but an agent only reaches
   * for them if something prompts it. A thread about an unrelated build failure
   * has no reason to suspect the disk — so when the machine is actually under
   * pressure, say so up front, in every thread, with the numbers and the tool
   * names. Below the watch threshold this contributes nothing at all, because
   * a healthy disk is not worth a line of anyone's context.
   */
  bb.agents.contributeInstructions(() => {
    const capacity = lastCapacity;
    if (capacity === null || capacity.level === "ok") return null;

    const plan = planner.peek();
    const reclaimable =
      plan === null || plan.totalBytes === 0
        ? "Run reclaim_plan to see what can be freed."
        : `Reclaim can currently free about ${formatBytes(plan.totalBytes)}.`;

    return [
      `Disk pressure on this machine is ${capacity.level.toUpperCase()}: ` +
        `${(capacity.primary.usedFraction * 100).toFixed(1)}% full, ` +
        `${formatBytes(capacity.primary.freeBytes)} free. ${reclaimable}`,
      "If this thread's work touches disk space — a build failing with ENOSPC, a slow or failing " +
        "write, or the user asking what is using their disk — use the Reclaim tools " +
        "(reclaim_status, reclaim_plan, reclaim_apply) rather than du, find, or rm. They read a " +
        "complete index of this volume and only ever delete inside authorized roots.",
      capacity.level === "critical"
        ? "At this level, a large write may fail outright. Check reclaim_status before starting one."
        : "",
    ]
      .filter((line) => line !== "")
      .join("\n");
  });

  bb.agents.registerTool({
    name: "reclaim_status",
    description:
      "Report disk capacity, pressure level, and the largest directories and files on this machine, " +
      "from a complete index of the volume. Use this instead of du, df, or find whenever a task " +
      "involves disk space, a full disk, or an ENOSPC failure.",
    instructions:
      "Use reclaim_status before proposing any disk cleanup, so your numbers are measured rather than guessed.",
    presentation: {
      label: { pending: "Reading disk usage", completed: "Read disk usage" },
    },
    parameters: z.object({}),
    async execute() {
      const overview = await buildOverview();
      return [
        renderCapacity(overview.capacity),
        renderIndex(overview.index),
        "",
        renderConsumers("Largest directories", overview.topDirectories),
        "",
        renderConsumers("Largest files", overview.topFiles),
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "reclaim_plan",
    description:
      "List reclaimable disk-space candidates with exact byte counts and the ids reclaim_apply takes. " +
      "Covers build output, dependencies, package-manager caches, Xcode derived data, the Trash, and " +
      "Docker (build cache, dangling images, stopped containers, unused volumes, and compacting the " +
      "Docker VM disk image that pruning alone never shrinks).",
    presentation: {
      label: { pending: "Building a reclaim plan", completed: "Built a reclaim plan" },
    },
    parameters: z.object({
      refresh: z.boolean().optional().describe("Rebuild instead of serving the cached plan."),
    }),
    async execute({ refresh }) {
      const config = await readConfig();
      const plan = await planner.get(config, refresh === true);
      return [
        renderPlan(plan, { verbose: true }),
        "",
        `Authorized roots: ${plan.roots.map((root) => shortenPath(root, HOME)).join(", ")}`,
      ].join("\n");
    },
  });

  bb.agents.registerTool({
    name: "reclaim_apply",
    description:
      "Free disk space for candidate ids from reclaim_plan. Always dry-run first and check the total.",
    instructions:
      "reclaim_apply only accepts ids minted by reclaim_plan and only deletes inside Reclaim's authorized roots. " +
      "Never try to widen that boundary with shell commands.",
    presentation: {
      label: { pending: "Reclaiming disk space", completed: "Reclaimed disk space" },
    },
    parameters: z.object({
      ids: z.array(z.string().min(1)).min(1).max(2000),
      dryRun: z.boolean().describe("True reports what would be freed without deleting anything."),
    }),
    async execute({ ids, dryRun }) {
      const config = await readConfig();
      const { found, missing } = planner.lookup(ids);
      if (found.length === 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: "None of those ids are in the current plan. Run reclaim_plan with refresh: true.",
            },
          ],
          isError: true,
        };
      }
      const result = await applyCandidates({
        candidates: found,
        roots: config.roots,
        dryRun,
        log: (message) => bb.log.info(`agent apply: ${message}`),
      });
      if (!dryRun && result.succeeded > 0) planner.invalidate();

      const lines = [
        `${dryRun ? "Dry run" : "Applied"}: ${result.succeeded} succeeded, ` +
          `${result.failed + missing.length} failed, ${formatBytes(result.bytesFreed)} ` +
          `${dryRun ? "would be freed" : "freed"}.`,
      ];
      for (const item of result.items.filter((row) => !row.ok).slice(0, 20)) {
        lines.push(`  failed ${item.path}: ${item.error ?? "unknown"}`);
      }
      if (missing.length > 0) lines.push(`  ${missing.length} ids were not in the current plan.`);
      return lines.join("\n");
    },
  });

  /* ---------------- CLI ---------------- */

  bb.cli.register({
    name: "reclaim",
    summary: "Show disk usage, find reclaimable space, and free it",
    commands: [
      { name: "status", summary: "Disk capacity, pressure, and index state", usage: "bb reclaim status [--json]" },
      { name: "top", summary: "Largest directories and files", usage: "bb reclaim top [--limit 20] [--json]" },
      { name: "tree", summary: "List one directory by size", usage: "bb reclaim tree <path> [--json]" },
      { name: "scan", summary: "Rebuild the index now", usage: "bb reclaim scan [--wait]" },
      { name: "plan", summary: "Reclaimable candidates with ids", usage: "bb reclaim plan [--refresh] [--json]" },
      {
        name: "clean",
        summary: "Free space (dry run unless --yes)",
        usage: "bb reclaim clean [--group <id>] [--id <id>]... [--yes] [--json]",
      },
    ],
    async run(argv) {
      const args = argv.filter((value) => value !== "");
      const json = args.includes("--json");
      const flag = (name: string): string | null => {
        const index = args.indexOf(name);
        return index >= 0 ? (args[index + 1] ?? null) : null;
      };
      const flagAll = (name: string): string[] => {
        const values: string[] = [];
        for (let index = 0; index < args.length; index += 1) {
          if (args[index] === name && args[index + 1] !== undefined) values.push(args[index + 1]!);
        }
        return values;
      };
      const command = args.find((value) => !value.startsWith("--")) ?? "status";
      const config = await readConfig();
      const ok = (stdout: string) => ({ exitCode: 0, stdout: stdout.endsWith("\n") ? stdout : `${stdout}\n` });
      const asJson = (value: unknown) => ok(JSON.stringify(value, null, 2));

      switch (command) {
        case "status": {
          const overview = await buildOverview();
          if (json) return asJson(overview);
          return ok([renderCapacity(overview.capacity), renderIndex(overview.index)].join("\n"));
        }

        case "top": {
          const limit = Math.min(200, Math.max(1, Number(flag("--limit") ?? 20) || 20));
          const overview = await buildOverview();
          if (json) {
            return asJson({
              directories: overview.topDirectories.slice(0, limit),
              files: overview.topFiles.slice(0, limit),
            });
          }
          return ok(
            [
              renderConsumers("Largest directories", overview.topDirectories.slice(0, limit)),
              "",
              renderConsumers("Largest files", overview.topFiles.slice(0, limit)),
            ].join("\n"),
          );
        }

        case "tree": {
          const target = args.find((value, index) => index > 0 && !value.startsWith("--")) ?? HOME;
          const listing = await listDirectory({
            store,
            path: resolve(target),
            reclaimableNames: RECLAIMABLE_BADGES,
          });
          if (json) return asJson(listing);
          if (!listing.exists) {
            return { exitCode: 1, stderr: `Cannot read ${listing.path}: ${listing.error}\n` };
          }
          const lines = [
            `${listing.path}  ${formatBytes(listing.indexedBytes ?? listing.totalBytes)}`,
          ];
          for (const entry of listing.entries.slice(0, 60)) {
            const marker = entry.kind === "dir" ? "/" : "";
            const unsized = entry.kind === "dir" && !entry.sized ? "  (not indexed)" : "";
            lines.push(`  ${padBytes(entry.bytes)}  ${entry.name}${marker}${unsized}`);
          }
          if (listing.truncated) lines.push(`  … listing truncated`);
          return ok(lines.join("\n"));
        }

        case "scan": {
          const wait = args.includes("--wait");
          const started = scanner.start(config.scanRoot, true);
          if (!wait) {
            return ok(`Scan of ${config.scanRoot} started. Watch it with \`bb reclaim status\`.`);
          }
          const state = await started;
          return json ? asJson(state) : ok(renderIndex(state));
        }

        case "plan": {
          const plan = await planner.get(config, args.includes("--refresh"));
          if (json) return asJson(plan);
          return ok(renderPlan(plan, { verbose: true }));
        }

        case "clean": {
          const plan = await planner.get(config, true);
          const groupFilter = flag("--group");
          const explicitIds = flagAll("--id");
          const ids =
            explicitIds.length > 0
              ? explicitIds
              : plan.groups
                  .filter((group) => group.available && (groupFilter === null || group.id === groupFilter))
                  .flatMap((group) =>
                    group.candidates
                      .filter((candidate) => (groupFilter === null ? candidate.defaultSelected : true))
                      .map((candidate) => candidate.id),
                  );

          if (ids.length === 0) {
            return ok("Nothing selected. Run `bb reclaim plan` to see candidates.");
          }
          const dryRun = !args.includes("--yes");
          const { found, missing } = planner.lookup(ids);
          const result = await applyCandidates({
            candidates: found,
            roots: config.roots,
            dryRun,
            log: (message) => bb.log.info(`cli clean: ${message}`),
          });
          if (!dryRun && result.succeeded > 0) planner.invalidate();
          if (json) return asJson({ ...result, missing });

          const lines = [
            dryRun
              ? `Dry run: would free ${formatBytes(result.bytesFreed)} across ${result.succeeded} items.`
              : `Freed ${formatBytes(result.bytesFreed)} across ${result.succeeded} items.`,
          ];
          for (const item of result.items.filter((row) => !row.ok).slice(0, 20)) {
            lines.push(`  failed ${item.path}: ${item.error ?? "unknown"}`);
          }
          // An id the planner does not recognise is a real problem for the
          // caller; reporting "0 items" and exiting 0 hides it.
          if (missing.length > 0) {
            for (const id of missing.slice(0, 20)) {
              lines.push(`  unknown candidate id: ${id}`);
            }
            lines.push("Run `bb reclaim plan --refresh` for current ids.");
            return { exitCode: 1, stdout: `${lines.join("\n")}\n` };
          }
          if (dryRun) lines.push("Re-run with --yes to apply.");
          return ok(lines.join("\n"));
        }

        default:
          return {
            exitCode: 1,
            stderr: `Unknown command: ${command}\nTry: status, top, tree, scan, plan, clean\n`,
          };
      }
    },
  });

  bb.onDispose(() => {
    scanner.cancel();
    bb.log.info("disposed");
  });
}
