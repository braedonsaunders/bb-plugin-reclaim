// Reclaim — frontend entry.
//
// Layout contract: the panel is an APP, not a document. The outermost element
// is `h-full min-h-0 overflow-hidden` and every scroll happens inside a
// `min-h-0 flex-1 overflow-y-auto` region, so the page itself never scrolls and
// the capacity band stays pinned while you read a 500-row tree under it.
import { useCallback, useEffect, useMemo, useState } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Icon, type IconName } from "@/components/ui/icon";
import { useIsCompactViewport } from "@/components/ui/hooks/use-compact-viewport";
import { cn } from "@/lib/utils";
import { CapacityBand, SizeBar, StatTile } from "@/components/meter";
import { TreeBrowser } from "@/components/tree-browser";
import { ReclaimPanel } from "@/components/reclaim-panel";
import { SettingsPanel } from "@/components/settings-panel";
import { publishRailReading, railIcon } from "@/components/rail-icon";
import {
  formatAgo,
  formatBytes,
  formatCount,
  formatDuration,
  formatPercent,
} from "@/lib/format";
import { levelIcon, levelTone, toneFill, toneText, toneTrack } from "@/lib/ui";
import type { Capacity, Consumer, GuardEvent, Overview, Plan } from "@/lib/contract";
import type { rpcContract } from "./server";

const OVERVIEW_POLL_MS = 30_000;

/* ------------------------------------------------------------------ */
/* data                                                                */
/* ------------------------------------------------------------------ */

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  const [data, setData] = useState<Overview | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("overview").then(
      (next) => {
        setData(next);
        setError(null);
      },
      (cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [rpc]);

  useEffect(() => {
    load();
    const timer = window.setInterval(() => {
      if (document.visibilityState === "visible") load();
    }, OVERVIEW_POLL_MS);
    return () => window.clearInterval(timer);
  }, [load]);

  // The scanner and the guard both publish; either one changes these numbers.
  useRealtime("index", load);
  useRealtime("capacity", load);

  return { data, error, reload: load };
}

function usePlan() {
  const rpc = useRpc<typeof rpcContract>();
  const [plan, setPlan] = useState<Plan | null>(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (force: boolean) => {
      setLoading(true);
      rpc.call("plan", { force }).then(
        (next) => {
          setPlan(next);
          setLoading(false);
        },
        () => setLoading(false),
      );
    },
    [rpc],
  );

  useEffect(() => {
    load(false);
  }, [load]);
  useRealtime("plan", () => load(false));

  return { plan, loading, refresh: () => load(true) };
}

/* ------------------------------------------------------------------ */
/* pieces                                                              */
/* ------------------------------------------------------------------ */

function ConsumerList({
  title,
  rows,
  emptyLabel,
  onOpen,
}: {
  title: string;
  rows: Consumer[];
  emptyLabel: string;
  onOpen?: (path: string) => void;
}) {
  const max = rows[0]?.bytes ?? 0;
  return (
    <section className="overflow-hidden rounded-lg border border-border bg-card">
      <h3 className="border-b border-border px-3 py-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        {title}
      </h3>
      {rows.length === 0 ? (
        <p className="px-3 py-6 text-center text-xs text-muted-foreground">{emptyLabel}</p>
      ) : (
        <ul className="divide-y divide-border/60">
          {rows.map((row) => (
            <li key={row.path}>
              <button
                type="button"
                onClick={onOpen === undefined ? undefined : () => onOpen(row.path)}
                disabled={onOpen === undefined}
                className={cn(
                  "flex w-full items-center gap-3 px-3 py-1.5 text-left",
                  onOpen === undefined ? "cursor-default" : "hover:bg-secondary/50",
                )}
                title={row.path}
              >
                <Icon
                  name={row.kind === "dir" ? "Folder" : "File"}
                  className="size-3.5 shrink-0 text-muted-foreground/60"
                />
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{row.displayPath}</span>
                <div className="hidden w-24 shrink-0 sm:block">
                  <SizeBar bytes={row.bytes} max={max} />
                </div>
                <span className="w-16 shrink-0 text-right text-xs font-medium tabular-nums">
                  {formatBytes(row.bytes)}
                </span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function ScanCard({ overview, onScan, onCancel }: {
  overview: Overview;
  onScan: () => void;
  onCancel: () => void;
}) {
  const { index } = overview;
  const scanning = index.status === "scanning";
  const progress = index.progress;

  return (
    <section className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Index
        </h3>
        <Button size="sm" variant="ghost" onClick={scanning ? onCancel : onScan}>
          <Icon
            name={scanning ? "X" : "ArrowReloadHorizontal"}
            className={cn("size-4")}
          />
          {scanning ? "Cancel scan" : "Rescan"}
        </Button>
      </div>

      {scanning ? (
        <div className="mt-1.5">
          <div className="flex items-baseline gap-2 text-sm">
            <Icon name="Loading" className="size-4 animate-spin text-primary" />
            <span className="tabular-nums">
              {formatCount(progress?.entriesSeen ?? 0)} entries
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatBytes(progress?.bytesSeen ?? 0)}
            </span>
            <span className="text-muted-foreground tabular-nums">
              {formatCount(progress?.entriesPerSecond ?? 0)}/s
            </span>
          </div>
          <p className="mt-1 truncate font-mono text-[11px] text-muted-foreground">
            {progress?.currentPath ?? index.rootPath}
          </p>
        </div>
      ) : index.status === "never" ? (
        <p className="mt-1.5 text-sm text-muted-foreground">
          Not scanned yet. A first scan of {index.rootPath} takes about a minute.
        </p>
      ) : index.status === "failed" ? (
        <p className="mt-1.5 text-sm text-destructive">{index.error}</p>
      ) : (
        <div className="mt-1.5 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
          <StatTile label="Files" value={formatCount(index.filesSeen)} />
          <StatTile label="Folders" value={formatCount(index.dirsStored)} />
          <StatTile label="Scanned" value={formatAgo(index.finishedAtMs)} />
          <StatTile
            label="Took"
            value={formatDuration(index.durationMs ?? 0)}
            hint={index.unreadable > 0 ? `${formatCount(index.unreadable)} unreadable` : undefined}
          />
        </div>
      )}
    </section>
  );
}

function GuardLog({ events }: { events: GuardEvent[] }) {
  const actionIcon: Record<GuardEvent["action"], IconName> = {
    observed: "Info",
    "auto-cleaned": "Clean",
    escalated: "Bot",
    suppressed: "Limitation",
  };
  if (events.length === 0) {
    return (
      <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
        No pressure events recorded. Reclaim logs every threshold crossing and every automatic
        action here.
      </div>
    );
  }
  return (
    <ul className="space-y-1.5">
      {events.map((event) => {
        const tone = levelTone(event.level);
        return (
          <li
            key={event.id}
            className="flex items-start gap-2.5 rounded-lg border border-border bg-card px-3 py-2"
          >
            <Icon
              name={actionIcon[event.action]}
              className={cn("mt-0.5 size-4 shrink-0", toneText[tone])}
            />
            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-baseline gap-x-2">
                <span className="text-sm">{event.detail}</span>
                {event.bytesFreed > 0 ? (
                  <span className="text-xs font-medium text-success tabular-nums">
                    +{formatBytes(event.bytesFreed)}
                  </span>
                ) : null}
              </div>
              <div className="text-[11px] text-muted-foreground tabular-nums">
                {formatAgo(event.atMs)} · {formatPercent(event.usedFraction, 1)} full ·{" "}
                {formatBytes(event.freeBytes)} free
              </div>
            </div>
          </li>
        );
      })}
    </ul>
  );
}

/* ------------------------------------------------------------------ */
/* the page                                                            */
/* ------------------------------------------------------------------ */

type TabId = "overview" | "reclaim" | "files" | "activity" | "settings";

function ReclaimPage() {
  const rpc = useRpc<typeof rpcContract>();
  const { data, error, reload } = useOverview();
  const { plan, loading: planLoading, refresh: refreshPlan } = usePlan();
  const compact = useIsCompactViewport();
  const [tab, setTab] = useState<TabId>("overview");
  const [treeRoot, setTreeRoot] = useState<string | null>(null);

  const root = treeRoot ?? data?.index.rootPath ?? "/";

  const tabs = useMemo(() => {
    const base: { id: TabId; label: string; icon: IconName }[] = [
      { id: "overview", label: "Overview", icon: "ChartColumn" },
      { id: "reclaim", label: "Reclaim", icon: "Clean" },
      { id: "activity", label: "Activity", icon: "Clock" },
      { id: "settings", label: "Settings", icon: "SlidersHorizontal" },
    ];
    // The tree lives in a permanent left rail on wide layouts; on a narrow one
    // it becomes a tab so it is still reachable.
    return compact ? [base[0]!, { id: "files" as const, label: "Files", icon: "Folder" as IconName }, ...base.slice(1)] : base;
  }, [compact]);

  useEffect(() => {
    if (!compact && tab === "files") setTab("overview");
  }, [compact, tab]);

  const openInTree = useCallback(
    (path: string) => {
      setTreeRoot(path);
      if (compact) setTab("files");
    },
    [compact],
  );

  if (error !== null && data === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      </div>
    );
  }

  if (data === null) {
    return (
      <div className="flex h-full items-center justify-center p-6">
        <Icon name="Loading" className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <CapacityBand
        capacity={data.capacity}
        reclaimableBytes={plan?.totalBytes ?? data.plan?.totalBytes ?? null}
        indexedBytes={data.index.bytesIndexed}
      />

      <div className="flex min-h-0 flex-1 overflow-hidden">
        {compact ? null : (
          <aside className="flex w-[330px] shrink-0 flex-col overflow-hidden border-r border-border lg:w-[380px]">
            <TreeBrowser rootPath={root} homeDir={data.homeDir} onRootChange={setTreeRoot} />
          </aside>
        )}

        <main className="flex min-h-0 flex-1 flex-col overflow-hidden">
          <nav className="flex shrink-0 items-center gap-1 border-b border-border px-2 py-1">
            {tabs.map((entry) => (
              <button
                key={entry.id}
                type="button"
                onClick={() => setTab(entry.id)}
                aria-current={tab === entry.id}
                className={cn(
                  "flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium",
                  tab === entry.id
                    ? "bg-secondary text-foreground"
                    : "text-muted-foreground hover:bg-secondary/60 hover:text-foreground",
                )}
              >
                <Icon name={entry.icon} className="size-3.5" />
                {entry.label}
                {entry.id === "reclaim" && plan !== null && plan.totalBytes > 0 ? (
                  <span className="rounded-full bg-primary/15 px-1.5 text-[10px] text-primary tabular-nums">
                    {formatBytes(plan.totalBytes)}
                  </span>
                ) : null}
              </button>
            ))}
          </nav>

          {tab === "files" ? (
            <div className="min-h-0 flex-1 overflow-hidden">
              <TreeBrowser rootPath={root} homeDir={data.homeDir} onRootChange={setTreeRoot} />
            </div>
          ) : tab === "reclaim" ? (
            <ReclaimPanel
              plan={plan}
              loading={planLoading}
              onRefresh={refreshPlan}
              onApplied={() => {
                reload();
                refreshPlan();
              }}
            />
          ) : tab === "settings" ? (
            <SettingsPanel homeDir={data.homeDir} />
          ) : tab === "activity" ? (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <p className="mb-3 text-xs text-muted-foreground">
                Threshold crossings, automatic cleanups, and agent escalations.
              </p>
              <GuardLog events={data.recentGuardEvents} />
            </div>
          ) : (
            <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
              <div className="space-y-3">
                <ScanCard
                  overview={data}
                  onScan={() => {
                    void rpc.call("scanStart", { force: true }).then(reload);
                  }}
                  onCancel={() => {
                    void rpc.call("scanCancel").then(reload);
                  }}
                />
                {/* On a wide layout the tree rail already shows the root's
                    children, so repeating them here is the same list twice.
                    It earns its place only when the rail is a tab. */}
                {compact ? (
                  <ConsumerList
                    title="Where the space went"
                    rows={data.rootBreakdown}
                    emptyLabel="Run a scan to see the breakdown."
                    onOpen={openInTree}
                  />
                ) : null}
                <ConsumerList
                  title="Largest folders"
                  rows={data.topDirectories}
                  emptyLabel="Run a scan to find them."
                  onOpen={openInTree}
                />
                <ConsumerList
                  title="Largest files"
                  rows={data.topFiles}
                  emptyLabel="Run a scan to find them."
                />
              </div>
            </div>
          )}
        </main>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* compact surfaces                                                    */
/* ------------------------------------------------------------------ */

/**
 * Panel header actions.
 *
 * Escalation lives here rather than inside the Activity tab: handing the
 * problem to an agent is something you decide while looking at the *capacity*,
 * and burying it behind a tab you would only open to read history meant it was
 * invisible exactly when it was wanted.
 */
function PanelHeaderActions() {
  const rpc = useRpc<typeof rpcContract>();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  return (
    <div className="flex items-center gap-2">
      {message === null ? null : (
        <span className="hidden max-w-64 truncate text-xs text-muted-foreground md:inline">
          {message}
        </span>
      )}
      <Button
        size="sm"
        variant="outline"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setMessage(null);
          rpc.call("escalate", {}).then(
            (outcome) => {
              setMessage(outcome.message);
              setBusy(false);
            },
            (cause: unknown) => {
              setMessage(cause instanceof Error ? cause.message : String(cause));
              setBusy(false);
            },
          );
        }}
      >
        <Icon name={busy ? "Loading" : "Bot"} className={cn("size-4", busy ? "animate-spin" : null)} />
        {busy ? "Starting…" : "Hand to an agent"}
      </Button>
    </div>
  );
}

/**
 * Feeds the navigation-rail badge. Renders nothing; it exists because it is a
 * slot with plugin context, which the rail icon itself is not.
 */
function RailFeed() {
  const rpc = useRpc<typeof rpcContract>();

  const load = useCallback(() => {
    rpc.call("capacity").then(
      (capacity) => {
        publishRailReading({
          fraction: capacity.primary.usedFraction,
          tone:
            capacity.level === "critical"
              ? "critical"
              : capacity.level === "warn"
                ? "warn"
                : "calm",
        });
      },
      () => {},
    );
  }, [rpc]);

  useEffect(() => {
    load();
    const timer = window.setInterval(load, 120_000);
    return () => {
      window.clearInterval(timer);
      publishRailReading(null);
    };
  }, [load]);
  useRealtime("capacity", load);

  return null;
}

function HomepageCapacity() {
  const rpc = useRpc<typeof rpcContract>();
  const [capacity, setCapacity] = useState<Capacity | null>(null);

  const load = useCallback(() => {
    rpc.call("capacity").then(setCapacity, () => {});
  }, [rpc]);

  useEffect(() => {
    load();
  }, [load]);
  useRealtime("capacity", load);

  if (capacity === null) return null;
  const tone = levelTone(capacity.level);
  const { primary } = capacity;
  return (
    <div className="rounded-lg border border-border bg-card px-3 py-2.5">
      <div className="flex items-center gap-3">
        <Icon name={levelIcon(capacity.level)} className={cn("size-5 shrink-0", toneText[tone])} />
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <span className={cn("text-lg font-semibold tabular-nums", toneText[tone])}>
              {formatPercent(primary.usedFraction, 1)}
            </span>
            <span className="text-sm text-muted-foreground">
              full · {formatBytes(primary.freeBytes)} free
            </span>
          </div>
          <p className="truncate text-xs text-muted-foreground">{capacity.reason}</p>
        </div>
      </div>
      {/* toneFill, never a class built by string manipulation — Tailwind only
          emits classes it can see literally in the source. */}
      <div className={cn("mt-2 h-1.5 w-full overflow-hidden rounded-full", toneTrack[tone])}>
        <div
          className={cn("h-full rounded-full", toneFill[tone])}
          style={{ width: `${Math.min(100, primary.usedFraction * 100)}%` }}
        />
      </div>
    </div>
  );
}

/** The panel's rail icon: the Clean glyph with the live disk-used badge. */
const RAIL_ICON = "reclaim-rail";

export default definePluginApp((app) => {
  app.experimental_icons.register({ name: RAIL_ICON, component: railIcon("Clean") });
  app.slots.experimental_appOverlay({ id: "rail-feed", component: RailFeed });
  app.slots.navPanel({
    id: "reclaim",
    title: "Reclaim",
    icon: RAIL_ICON,
    path: "reclaim",
    component: ReclaimPage,
    headerContent: PanelHeaderActions,
  });
  app.slots.homepageSection({
    id: "capacity",
    title: "Disk",
    component: HomepageCapacity,
  });
});
