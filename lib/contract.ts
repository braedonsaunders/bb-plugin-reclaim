/**
 * The wire contract between Reclaim's server and its app bundle.
 *
 * Schemas live here rather than in `server.ts` so the CLI, the agent tools and
 * the React app all describe the same shapes. `app.tsx` imports only the
 * inferred types (`import type`), so zod never reaches the frontend bundle.
 */
import { z } from "zod";

/* ------------------------------------------------------------------ */
/* Capacity                                                            */
/* ------------------------------------------------------------------ */

export const PRESSURE_LEVELS = ["ok", "watch", "warn", "critical"] as const;
export const pressureLevelSchema = z.enum(PRESSURE_LEVELS);
export type PressureLevel = (typeof PRESSURE_LEVELS)[number];

export const volumeSchema = z.object({
  mountPoint: z.string(),
  device: z.string().nullable(),
  fsType: z.string().nullable(),
  label: z.string().nullable(),
  /** Container capacity on APFS, so sibling volumes report one shared pool. */
  totalBytes: z.number(),
  freeBytes: z.number(),
  usedBytes: z.number(),
  usedFraction: z.number(),
  isPrimary: z.boolean(),
  /** True when this row shares its free space with other mounts (APFS). */
  sharesPool: z.boolean(),
});
export type Volume = z.infer<typeof volumeSchema>;

export const snapshotSchema = z.object({
  name: z.string(),
  mountPoint: z.string(),
  bytes: z.number().nullable(),
  createdAtMs: z.number().nullable(),
  /** A sealed system snapshot is macOS itself and must never be offered up. */
  sealed: z.boolean(),
});
export type VolumeSnapshotRow = z.infer<typeof snapshotSchema>;

export const thresholdsSchema = z.object({
  watchPercent: z.number(),
  warnPercent: z.number(),
  criticalPercent: z.number(),
  minFreeGb: z.number(),
});
export type Thresholds = z.infer<typeof thresholdsSchema>;

export const capacitySchema = z.object({
  sampledAt: z.string(),
  primary: volumeSchema,
  volumes: z.array(volumeSchema),
  snapshots: z.array(snapshotSchema),
  /** Space macOS will hand back under pressure; null when it can't be read. */
  purgeableBytes: z.number().nullable(),
  level: pressureLevelSchema,
  /** Plain-language cause of the current level, for the alert banner. */
  reason: z.string(),
  thresholds: thresholdsSchema,
});
export type Capacity = z.infer<typeof capacitySchema>;

/* ------------------------------------------------------------------ */
/* Index                                                               */
/* ------------------------------------------------------------------ */

export const scanProgressSchema = z.object({
  currentPath: z.string(),
  entriesSeen: z.number(),
  filesSeen: z.number(),
  dirsSeen: z.number(),
  bytesSeen: z.number(),
  unreadable: z.number(),
  elapsedMs: z.number(),
  entriesPerSecond: z.number(),
});
export type ScanProgress = z.infer<typeof scanProgressSchema>;

export const indexStateSchema = z.object({
  status: z.enum(["never", "scanning", "ready", "failed"]),
  rootPath: z.string(),
  generation: z.number(),
  startedAtMs: z.number().nullable(),
  finishedAtMs: z.number().nullable(),
  durationMs: z.number().nullable(),
  filesSeen: z.number(),
  dirsSeen: z.number(),
  dirsStored: z.number(),
  bytesIndexed: z.number(),
  unreadable: z.number(),
  error: z.string().nullable(),
  progress: scanProgressSchema.nullable(),
});
export type IndexState = z.infer<typeof indexStateSchema>;

/* ------------------------------------------------------------------ */
/* Browsing                                                            */
/* ------------------------------------------------------------------ */

export const ENTRY_KINDS = ["dir", "file", "symlink", "other"] as const;
export const entryKindSchema = z.enum(ENTRY_KINDS);
export type EntryKind = (typeof ENTRY_KINDS)[number];

export const entrySchema = z.object({
  path: z.string(),
  name: z.string(),
  kind: entryKindSchema,
  /** Subtree bytes for a directory, allocated size for a file. */
  bytes: z.number(),
  /** False when a directory's size has not been indexed yet. */
  sized: z.boolean(),
  fileCount: z.number().nullable(),
  mtimeMs: z.number().nullable(),
  /** Fraction of the parent listing's total, for the inline bar. */
  share: z.number(),
  /**
   * Indexed as a single unit (node_modules, .git). Browsable, but Reclaim
   * deliberately stops aggregating inside it.
   */
  opaque: z.boolean(),
  /** Matches a reclaimer, so the browser can badge it. */
  reclaimableAs: z.string().nullable(),
});
export type Entry = z.infer<typeof entrySchema>;

export const listingSchema = z.object({
  path: z.string(),
  parentPath: z.string().nullable(),
  exists: z.boolean(),
  /** Sum of the listed children, not the indexed subtree total. */
  totalBytes: z.number(),
  /** Indexed subtree total when known — the number the tree browser shows. */
  indexedBytes: z.number().nullable(),
  entries: z.array(entrySchema),
  truncated: z.boolean(),
  error: z.string().nullable(),
});
export type Listing = z.infer<typeof listingSchema>;

export const consumerSchema = z.object({
  path: z.string(),
  displayPath: z.string(),
  bytes: z.number(),
  kind: entryKindSchema,
  share: z.number(),
  mtimeMs: z.number().nullable(),
});
export type Consumer = z.infer<typeof consumerSchema>;

/* ------------------------------------------------------------------ */
/* Reclaim plan                                                        */
/* ------------------------------------------------------------------ */

export const RISKS = ["safe", "rebuildable", "careful"] as const;
export const riskSchema = z.enum(RISKS);
export type Risk = (typeof RISKS)[number];

export const candidateSchema = z.object({
  id: z.string(),
  groupId: z.string(),
  path: z.string(),
  displayPath: z.string(),
  bytes: z.number(),
  detail: z.string(),
  /** Last time anything in this candidate changed; drives the age filter. */
  lastUsedMs: z.number().nullable(),
  risk: riskSchema,
  /** Preselected in the UI. Only ever true for `safe` and stale rebuildables. */
  defaultSelected: z.boolean(),
});
export type Candidate = z.infer<typeof candidateSchema>;

export const groupSchema = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  risk: riskSchema,
  bytes: z.number(),
  count: z.number(),
  available: z.boolean(),
  unavailableReason: z.string().nullable(),
  /** Shown when reclaiming this group costs something non-obvious. */
  caution: z.string().nullable(),
  candidates: z.array(candidateSchema),
});
export type Group = z.infer<typeof groupSchema>;

export const planSchema = z.object({
  builtAtMs: z.number(),
  totalBytes: z.number(),
  /** Bytes in candidates Reclaim would preselect. */
  defaultBytes: z.number(),
  groups: z.array(groupSchema),
  roots: z.array(z.string()),
  warnings: z.array(z.string()),
  stale: z.boolean(),
});
export type Plan = z.infer<typeof planSchema>;

export const applyResultSchema = z.object({
  dryRun: z.boolean(),
  attempted: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  bytesFreed: z.number(),
  items: z.array(
    z.object({
      id: z.string(),
      path: z.string(),
      bytes: z.number(),
      ok: z.boolean(),
      error: z.string().nullable(),
    }),
  ),
});
export type ApplyResult = z.infer<typeof applyResultSchema>;

/* ------------------------------------------------------------------ */
/* Guard + remediation                                                 */
/* ------------------------------------------------------------------ */

export const guardEventSchema = z.object({
  id: z.number(),
  atMs: z.number(),
  level: pressureLevelSchema,
  freeBytes: z.number(),
  usedFraction: z.number(),
  action: z.enum(["observed", "auto-cleaned", "escalated", "suppressed"]),
  detail: z.string(),
  bytesFreed: z.number(),
  threadId: z.string().nullable(),
});
export type GuardEvent = z.infer<typeof guardEventSchema>;

export const overviewSchema = z.object({
  capacity: capacitySchema,
  index: indexStateSchema,
  /** Largest directories anywhere under the indexed root. */
  topDirectories: z.array(consumerSchema),
  /** Largest individual files anywhere under the indexed root. */
  topFiles: z.array(consumerSchema),
  /** Immediate children of the root, for the "where it went" band. */
  rootBreakdown: z.array(consumerSchema),
  plan: z
    .object({
      totalBytes: z.number(),
      defaultBytes: z.number(),
      builtAtMs: z.number(),
      groupCount: z.number(),
    })
    .nullable(),
  recentGuardEvents: z.array(guardEventSchema),
  homeDir: z.string(),
});
export type Overview = z.infer<typeof overviewSchema>;

/**
 * The most Reclaim is ever allowed to delete without being asked. `safe` means
 * package-manager caches only; `rebuildable` additionally lets it take build
 * output and dependencies. `careful` is deliberately not an option — the Trash
 * and Docker volumes always need a human.
 */
export const AUTO_RISKS = ["safe", "rebuildable"] as const;
export const autoRiskSchema = z.enum(AUTO_RISKS);
export type AutoRisk = (typeof AUTO_RISKS)[number];

export const configSchema = z.object({
  roots: z.array(z.string()),
  scanRoot: z.string(),
  thresholds: thresholdsSchema,
  /** Clean automatically when pressure reaches warn or critical. */
  autoCleanEnabled: z.boolean(),
  /** Clean automatically on a timer regardless of pressure. 0 disables it. */
  autoCleanEveryHours: z.number(),
  autoCleanMaxRisk: autoRiskSchema,
  agentEscalationEnabled: z.boolean(),
  escalationProjectId: z.string().nullable(),
  staleDays: z.number(),
  scanIntervalHours: z.number(),
  dockerEnabled: z.boolean(),
  /** When the scheduled clean last ran, for the settings page to show. */
  lastAutoCleanMs: z.number().nullable(),
});
export type Config = z.infer<typeof configSchema>;

export const configPatchSchema = z
  .object({
    roots: z.array(z.string().min(1)).max(200).optional(),
    scanRoot: z.string().min(1).optional(),
    thresholds: thresholdsSchema.partial().optional(),
    autoCleanEnabled: z.boolean().optional(),
    autoCleanEveryHours: z.number().min(0).max(720).optional(),
    autoCleanMaxRisk: autoRiskSchema.optional(),
    agentEscalationEnabled: z.boolean().optional(),
    escalationProjectId: z.string().nullable().optional(),
    staleDays: z.number().min(1).max(3650).optional(),
    scanIntervalHours: z.number().min(1).max(720).optional(),
    dockerEnabled: z.boolean().optional(),
  })
  .strict();
export type ConfigPatch = z.infer<typeof configPatchSchema>;

export const projectRefSchema = z.object({
  id: z.string(),
  name: z.string(),
});
export type ProjectRef = z.infer<typeof projectRefSchema>;

/* ------------------------------------------------------------------ */
/* RPC                                                                 */
/* ------------------------------------------------------------------ */

export const rpcShape = {
  overview: { input: z.null(), output: overviewSchema },
  capacity: { input: z.null(), output: capacitySchema },
  indexState: { input: z.null(), output: indexStateSchema },
  scanStart: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: indexStateSchema,
  },
  scanCancel: { input: z.null(), output: indexStateSchema },
  list: {
    input: z.object({ path: z.string().min(1) }).strict(),
    output: listingSchema,
  },
  plan: {
    input: z.object({ force: z.boolean().optional() }).strict(),
    output: planSchema,
  },
  apply: {
    input: z
      .object({
        ids: z.array(z.string().min(1)).min(1).max(5000),
        dryRun: z.boolean(),
      })
      .strict(),
    output: applyResultSchema,
  },
  escalate: {
    input: z.object({ note: z.string().max(2000).optional() }).strict(),
    output: z.object({
      threadId: z.string().nullable(),
      started: z.boolean(),
      message: z.string(),
    }),
  },
  config: { input: z.null(), output: configSchema },
  configUpdate: { input: configPatchSchema, output: configSchema },
  projects: { input: z.null(), output: z.object({ projects: z.array(projectRefSchema) }) },
  /** Run the auto-clean tier now, so the settings page can show its effect. */
  autoCleanNow: {
    input: z.object({ dryRun: z.boolean() }).strict(),
    output: applyResultSchema,
  },
  guardEvents: {
    input: z.object({ limit: z.number().int().min(1).max(200) }).strict(),
    output: z.object({ events: z.array(guardEventSchema) }),
  },
} as const;

/** Realtime channels the app subscribes to. */
export const CHANNEL_INDEX = "index";
export const CHANNEL_CAPACITY = "capacity";
export const CHANNEL_PLAN = "plan";
