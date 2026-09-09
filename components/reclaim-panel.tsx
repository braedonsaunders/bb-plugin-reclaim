import { useCallback, useEffect, useMemo, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";
import { formatAgo, formatBytes, formatCount } from "@/lib/format";
import { barPercent, riskLabel, riskTone, toneBorder, toneText } from "@/lib/ui";
import type { ApplyResult, Plan } from "@/lib/contract";
import type { rpcContract } from "@/server";

export function ReclaimPanel({
  plan,
  loading,
  onRefresh,
  onApplied,
}: {
  plan: Plan | null;
  loading: boolean;
  onRefresh: () => void;
  onApplied: () => void;
}) {
  const rpc = useRpc<typeof rpcContract>();
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [confirming, setConfirming] = useState(false);
  const [preview, setPreview] = useState<ApplyResult | null>(null);
  const [result, setResult] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /**
   * Whether the selection is the user's rather than Reclaim's default.
   *
   * This is tracked explicitly instead of inferred from `selected.size > 0`.
   * Inferring it meant an *empty* selection looked like a first load, so the
   * moment a successful clean emptied it the next plan re-applied defaults —
   * and the button that had just freed 24 GB immediately re-armed itself with
   * "Free 12 GB" of whatever was left, which reads exactly like the delete
   * silently failed.
   */
  const [touched, setTouched] = useState(false);

  useEffect(() => {
    if (plan === null) return;
    setSelected((current) => {
      if (touched) {
        // Keep the user's choice, minus anything the new plan no longer has.
        const live = new Set<string>();
        for (const group of plan.groups) {
          for (const candidate of group.candidates) {
            if (current.has(candidate.id)) live.add(candidate.id);
          }
        }
        return live;
      }
      const next = new Set<string>();
      for (const group of plan.groups) {
        for (const candidate of group.candidates) {
          if (candidate.defaultSelected) next.add(candidate.id);
        }
      }
      return next;
    });
  }, [plan, touched]);

  const { selectedBytes, selectedCount } = useMemo(() => {
    let bytes = 0;
    let count = 0;
    for (const group of plan?.groups ?? []) {
      for (const candidate of group.candidates) {
        if (selected.has(candidate.id)) {
          bytes += candidate.bytes;
          count += 1;
        }
      }
    }
    return { selectedBytes: bytes, selectedCount: count };
  }, [plan, selected]);

  const toggle = useCallback((id: string) => {
    setTouched(true);
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleGroup = useCallback(
    (groupId: string, on: boolean) => {
      const group = plan?.groups.find((row) => row.id === groupId);
      if (group === undefined) return;
      setTouched(true);
      setSelected((current) => {
        const next = new Set(current);
        for (const candidate of group.candidates) {
          if (on) next.add(candidate.id);
          else next.delete(candidate.id);
        }
        return next;
      });
    },
    [plan],
  );

  const run = useCallback(
    async (dryRun: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const outcome = await rpc.call("apply", { ids: [...selected], dryRun });
        if (dryRun) {
          setPreview(outcome);
          setConfirming(true);
        } else {
          setResult(outcome);
          setConfirming(false);
          setPreview(null);
          // The freed items are gone; starting the next round from an empty
          // selection is the honest state, and `touched` keeps the incoming
          // refreshed plan from silently re-arming the button.
          setSelected(new Set());
          setTouched(true);
          onApplied();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : String(cause));
        setConfirming(false);
      } finally {
        setBusy(false);
      }
    },
    [rpc, selected, onApplied],
  );

  if (plan === null) {
    return (
      <div className="px-4 py-10 text-center text-sm text-muted-foreground">
        {loading ? "Building a plan…" : "No plan yet."}
      </div>
    );
  }

  const active = plan.groups.filter((group) => group.available && group.count > 0);
  const inactive = plan.groups.filter((group) => !group.available || group.count === 0);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* Action bar. Free is destructive and always states the exact amount. */}
      <div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2">
        <div className="min-w-0 text-sm">
          <span className="font-semibold tabular-nums">{formatBytes(selectedBytes)}</span>{" "}
          <span className="text-muted-foreground">
            selected across {formatCount(selectedCount)} item{selectedCount === 1 ? "" : "s"} · of{" "}
            {formatBytes(plan.totalBytes)} found
          </span>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onRefresh} disabled={loading}>
            <Icon
              name={loading ? "Loading" : "ArrowReloadHorizontal"}
              className={cn("size-4", loading ? "animate-spin" : null)}
            />
            Rescan
          </Button>
          <Button
            size="sm"
            variant="destructive"
            disabled={selectedCount === 0 || busy}
            onClick={() => void run(true)}
          >
            <Icon name="Clean" className="size-4" />
            Free {formatBytes(selectedBytes)}
          </Button>
        </div>
      </div>

      {error === null ? null : (
        <p role="alert" className="shrink-0 px-4 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {/* Spell out what is LEFT, not just what went. Without that sentence a
          non-zero "found" total after a successful clean reads as "the delete
          did nothing", when it is simply the candidates that were never
          selected. */}
      {result === null ? null : (
        <div className="flex shrink-0 items-start gap-2 border-b border-border bg-success/10 px-4 py-2 text-sm">
          <Icon name="CircleCheck" className="mt-0.5 size-4 shrink-0 text-success" />
          <div className="min-w-0 flex-1">
            <span className="font-medium text-success">
              Freed {formatBytes(result.bytesFreed)}
            </span>{" "}
            <span className="text-muted-foreground">
              from {formatCount(result.succeeded)} item
              {result.succeeded === 1 ? "" : "s"}
              {result.failed > 0 ? `, ${result.failed} failed` : ""}.
            </span>
            {plan.totalBytes > 0 ? (
              <span className="text-muted-foreground">
                {" "}
                {formatBytes(plan.totalBytes)} is still reclaimable — those are
                candidates you did not select.
              </span>
            ) : null}
          </div>
          <button
            type="button"
            onClick={() => setResult(null)}
            className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-secondary"
            aria-label="Dismiss"
          >
            <Icon name="X" className="size-3.5" />
          </button>
        </div>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
        {plan.warnings.map((warning) => (
          <p key={warning} className="mb-2 text-xs text-muted-foreground">
            <Icon name="Info" className="mr-1 inline size-3.5 align-[-2px]" />
            {warning}
          </p>
        ))}

        {active.length === 0 ? (
          <div className="rounded-lg border border-dashed border-border px-4 py-8 text-center text-sm text-muted-foreground">
            Nothing reclaimable found in the authorized roots.
          </div>
        ) : (
          <div className="space-y-3">
            {active.map((group) => {
              const tone = riskTone(group.risk);
              const groupSelected = group.candidates.filter((row) => selected.has(row.id)).length;
              const isCollapsed = collapsed.has(group.id);
              const max = group.candidates[0]?.bytes ?? 0;
              return (
                <section
                  key={group.id}
                  className="overflow-hidden rounded-lg border border-border bg-card"
                >
                  <header className="flex items-center gap-2 border-b border-border px-3 py-2">
                    <Checkbox
                      checked={
                        groupSelected === group.candidates.length
                          ? true
                          : groupSelected === 0
                            ? false
                            : "indeterminate"
                      }
                      onCheckedChange={(checked) => toggleGroup(group.id, checked === true)}
                      aria-label={`Select all in ${group.title}`}
                    />
                    <button
                      type="button"
                      onClick={() =>
                        setCollapsed((current) => {
                          const next = new Set(current);
                          if (next.has(group.id)) next.delete(group.id);
                          else next.add(group.id);
                          return next;
                        })
                      }
                      className="flex min-w-0 flex-1 items-center gap-2 text-left"
                    >
                      <Icon
                        name={isCollapsed ? "ChevronRight" : "ChevronDown"}
                        className="size-3.5 shrink-0 text-muted-foreground"
                      />
                      <span className="truncate text-sm font-medium">{group.title}</span>
                      <span
                        className={cn(
                          "shrink-0 rounded-full border px-1.5 py-px text-[10px] font-medium",
                          toneBorder[tone],
                          toneText[tone],
                        )}
                      >
                        {riskLabel(group.risk)}
                      </span>
                      <span className="shrink-0 text-xs text-muted-foreground">
                        {formatCount(group.count)}
                      </span>
                    </button>
                    <span className="shrink-0 text-sm font-semibold tabular-nums">
                      {formatBytes(group.bytes)}
                    </span>
                  </header>

                  {isCollapsed ? null : (
                    <>
                      <p className="px-3 pt-2 text-xs text-muted-foreground">{group.description}</p>
                      {/* Muted, not the risk tone: the pill beside the title
                          already carries the status colour, and a caution
                          rendered in "safe" green reads as reassurance. */}
                      {group.caution === null ? null : (
                        <p className="px-3 pt-1 text-xs text-muted-foreground">
                          <Icon name="AlertCircle" className="mr-1 inline size-3.5 align-[-2px]" />
                          {group.caution}
                        </p>
                      )}
                      <ul className="mt-1 divide-y divide-border/60">
                        {group.candidates.slice(0, 200).map((candidate) => (
                          <li
                            key={candidate.id}
                            className="flex items-center gap-2 px-3 py-1.5 hover:bg-secondary/40"
                          >
                            <Checkbox
                              checked={selected.has(candidate.id)}
                              onCheckedChange={() => toggle(candidate.id)}
                              aria-label={`Select ${candidate.displayPath}`}
                            />
                            <div className="min-w-0 flex-1">
                              <div className="truncate font-mono text-xs" title={candidate.path}>
                                {candidate.displayPath}
                              </div>
                              <div className="truncate text-[11px] text-muted-foreground">
                                {candidate.detail}
                              </div>
                            </div>
                            <div className="hidden w-20 shrink-0 sm:block">
                              <div className="h-1 w-full overflow-hidden rounded-full bg-muted-foreground/10">
                                <div
                                  className="h-full rounded-full bg-primary/60"
                                  style={{ width: `${barPercent(candidate.bytes, max)}%` }}
                                />
                              </div>
                            </div>
                            <span className="w-16 shrink-0 text-right text-xs tabular-nums">
                              {formatBytes(candidate.bytes)}
                            </span>
                          </li>
                        ))}
                      </ul>
                      {group.candidates.length > 200 ? (
                        <p className="px-3 py-2 text-[11px] text-muted-foreground">
                          Showing the 200 largest of {formatCount(group.candidates.length)}.
                        </p>
                      ) : null}
                    </>
                  )}
                </section>
              );
            })}
          </div>
        )}

        {inactive.length === 0 ? null : (
          <div className="mt-4">
            <h3 className="mb-1.5 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
              Not applicable
            </h3>
            <ul className="space-y-1">
              {inactive.map((group) => (
                <li key={group.id} className="flex items-baseline gap-2 text-xs text-muted-foreground">
                  <span className="font-medium">{group.title}</span>
                  <span>— {group.unavailableReason ?? "nothing found"}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Confirmation shows the dry-run's own numbers, not the selection's. */}
      <Dialog open={confirming} onOpenChange={(open) => !open && setConfirming(false)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Free {formatBytes(preview?.bytesFreed ?? selectedBytes)}?</DialogTitle>
            <DialogDescription>
              This permanently deletes {formatCount(preview?.succeeded ?? selectedCount)} item
              {(preview?.succeeded ?? selectedCount) === 1 ? "" : "s"} inside your authorized roots.
              Caches and build output rebuild themselves; anything marked Careful does not.
            </DialogDescription>
          </DialogHeader>
          {preview !== null && preview.failed > 0 ? (
            <p className="text-sm text-destructive">
              {preview.failed} item{preview.failed === 1 ? "" : "s"} cannot be removed and will be
              skipped.
            </p>
          ) : null}
          <DialogFooter>
            <Button variant="ghost" onClick={() => setConfirming(false)} disabled={busy}>
              Cancel
            </Button>
            <Button variant="destructive" onClick={() => void run(false)} disabled={busy}>
              {busy ? "Freeing…" : `Free ${formatBytes(preview?.bytesFreed ?? selectedBytes)}`}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Small helper reused by the overview's "recent activity" list. */
export function relativeLabel(atMs: number | null): string {
  return formatAgo(atMs);
}
