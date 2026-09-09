import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { formatAgo, formatBytes, shortenPath } from "@/lib/format";
import type { ApplyResult, Config, ConfigPatch, ProjectRef } from "@/lib/contract";
import type { rpcContract } from "@/server";

function Section({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="border-b border-border px-3 py-2">
        <h3 className="text-sm font-medium">{title}</h3>
        <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>
      </header>
      <div className="space-y-3 px-3 py-3">{children}</div>
    </section>
  );
}

function Toggle({
  checked,
  onChange,
  label,
  hint,
  disabled,
}: {
  checked: boolean;
  onChange: (next: boolean) => void;
  label: string;
  hint?: string;
  disabled?: boolean;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-2.5",
        disabled === true ? "opacity-50" : "cursor-pointer",
      )}
    >
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
        className="mt-0.5"
      />
      <span className="min-w-0">
        <span className="block text-sm">{label}</span>
        {hint === undefined ? null : (
          <span className="block text-xs text-muted-foreground">{hint}</span>
        )}
      </span>
    </label>
  );
}

function NumberField({
  label,
  value,
  onCommit,
  suffix,
  min,
  max,
  hint,
}: {
  label: string;
  value: number;
  onCommit: (next: number) => void;
  suffix?: string;
  min: number;
  max: number;
  hint?: string;
}) {
  // Local draft so typing "1" on the way to "15" does not immediately persist
  // a threshold of 1 and trip an alert.
  const [draft, setDraft] = useState(String(value));
  useEffect(() => setDraft(String(value)), [value]);

  const commit = () => {
    const next = Number(draft);
    if (!Number.isFinite(next)) {
      setDraft(String(value));
      return;
    }
    const clamped = Math.min(max, Math.max(min, next));
    setDraft(String(clamped));
    if (clamped !== value) onCommit(clamped);
  };

  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint === undefined ? null : (
          <div className="text-xs text-muted-foreground">{hint}</div>
        )}
      </div>
      <div className="flex shrink-0 items-center gap-1.5">
        <Input
          value={draft}
          inputMode="numeric"
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") event.currentTarget.blur();
          }}
          className="h-7 w-20 text-right text-sm tabular-nums"
          aria-label={label}
        />
        {suffix === undefined ? null : (
          <span className="w-10 text-xs text-muted-foreground">{suffix}</span>
        )}
      </div>
    </div>
  );
}

export function SettingsPanel({ homeDir }: { homeDir: string }) {
  const rpc = useRpc<typeof rpcContract>();
  const [config, setConfig] = useState<Config | null>(null);
  const [projects, setProjects] = useState<ProjectRef[]>([]);
  const [newRoot, setNewRoot] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<ApplyResult | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    rpc.call("config").then(setConfig, () => {});
    rpc.call("projects").then((next) => setProjects(next.projects), () => {});
  }, [rpc]);

  const patch = useCallback(
    (next: ConfigPatch) => {
      setBusy(true);
      setError(null);
      rpc.call("configUpdate", next).then(
        (updated) => {
          setConfig(updated);
          setBusy(false);
        },
        (cause: unknown) => {
          setError(cause instanceof Error ? cause.message : String(cause));
          setBusy(false);
        },
      );
    },
    [rpc],
  );

  if (config === null) {
    return (
      <div className="flex h-full items-center justify-center">
        <Icon name="Loading" className="size-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const addRoot = () => {
    const trimmed = newRoot.trim();
    if (trimmed === "") return;
    patch({ roots: [...config.roots, trimmed] });
    setNewRoot("");
  };

  return (
    <div className="min-h-0 flex-1 overflow-y-auto px-4 py-3">
      <div className="mx-auto w-full max-w-2xl space-y-3">
        {error === null ? null : (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <Section
          title="Where Reclaim may delete"
          description="Nothing outside these roots can ever be removed, by you, by the schedule, or by an agent. A built-in never-delete list still protects ~, /System and friends inside them."
        >
          <ul className="space-y-1">
            {config.roots.map((root) => (
              <li
                key={root}
                className="flex items-center gap-2 rounded border border-border px-2 py-1"
              >
                <Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" />
                <span className="min-w-0 flex-1 truncate font-mono text-xs" title={root}>
                  {shortenPath(root, homeDir)}
                </span>
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => patch({ roots: config.roots.filter((row) => row !== root) })}
                  className="shrink-0 rounded p-0.5 text-muted-foreground hover:bg-secondary hover:text-destructive"
                  aria-label={`Remove ${root}`}
                >
                  <Icon name="X" className="size-3.5" />
                </button>
              </li>
            ))}
            {config.roots.length === 0 ? (
              <li className="rounded border border-dashed border-border px-2 py-3 text-center text-xs text-muted-foreground">
                No roots authorized — Reclaim can index but cannot delete anything.
              </li>
            ) : null}
          </ul>
          <div className="flex items-center gap-2">
            <Input
              value={newRoot}
              onChange={(event) => setNewRoot(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") addRoot();
              }}
              placeholder="~/Projects"
              className="h-7 font-mono text-xs"
              aria-label="Add an authorized root"
            />
            <Button size="sm" variant="outline" onClick={addRoot} disabled={busy}>
              <Icon name="Plus" className="size-4" />
              Add
            </Button>
          </div>
        </Section>

        <Section
          title="Alerts"
          description="Pressure is graded on whichever signal is angrier — percent full, or absolute free space."
        >
          <NumberField
            label="Watch"
            hint="First notice that space is getting tight."
            value={config.thresholds.watchPercent}
            min={1}
            max={99}
            suffix="% full"
            onCommit={(watchPercent) => patch({ thresholds: { watchPercent } })}
          />
          <NumberField
            label="Warning"
            hint="Enables auto-clean, if you turn it on below."
            value={config.thresholds.warnPercent}
            min={1}
            max={99}
            suffix="% full"
            onCommit={(warnPercent) => patch({ thresholds: { warnPercent } })}
          />
          <NumberField
            label="Critical"
            hint="Enables agent escalation, if you turn it on below."
            value={config.thresholds.criticalPercent}
            min={1}
            max={100}
            suffix="% full"
            onCommit={(criticalPercent) => patch({ thresholds: { criticalPercent } })}
          />
          <NumberField
            label="Minimum free space"
            hint="Raises the level regardless of percentage — 90% of a 4TB array still leaves 400GB."
            value={config.thresholds.minFreeGb}
            min={1}
            max={10_000}
            suffix="GB"
            onCommit={(minFreeGb) => patch({ thresholds: { minFreeGb } })}
          />
        </Section>

        <Section
          title="Automatic cleanup"
          description="Reclaim can free space on its own. It only ever takes candidates it would have preselected, and never anything marked Careful."
        >
          <Toggle
            checked={config.autoCleanEnabled}
            onChange={(autoCleanEnabled) => patch({ autoCleanEnabled })}
            label="Clean when pressure reaches Warning"
            hint="Reactive. Runs at most once every 6 hours."
          />
          <NumberField
            label="Also clean on a schedule"
            hint="Regular housekeeping regardless of pressure. 0 turns it off."
            value={config.autoCleanEveryHours}
            min={0}
            max={720}
            suffix="hours"
            onCommit={(autoCleanEveryHours) => patch({ autoCleanEveryHours })}
          />

          <div>
            <div className="text-sm">Automatic cleanup may remove</div>
            <div className="mt-1.5 flex gap-1.5">
              {(
                [
                  { id: "safe", label: "Caches only", hint: "Package-manager downloads." },
                  {
                    id: "rebuildable",
                    label: "Caches + build output",
                    hint: "Also node_modules and build directories.",
                  },
                ] as const
              ).map((option) => (
                <button
                  key={option.id}
                  type="button"
                  disabled={busy}
                  onClick={() => patch({ autoCleanMaxRisk: option.id })}
                  className={cn(
                    "flex-1 rounded-md border px-2.5 py-1.5 text-left",
                    config.autoCleanMaxRisk === option.id
                      ? "border-primary bg-primary/10"
                      : "border-border hover:bg-secondary/60",
                  )}
                >
                  <span className="block text-xs font-medium">{option.label}</span>
                  <span className="block text-[11px] text-muted-foreground">{option.hint}</span>
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-[11px] text-muted-foreground">
              The Trash and unused Docker volumes are never automatic, at any setting.
            </p>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border pt-2.5">
            <span className="text-xs text-muted-foreground">
              Last automatic run {formatAgo(config.lastAutoCleanMs)}
            </span>
            <div className="flex items-center gap-2">
              <Button
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={() => {
                  setBusy(true);
                  rpc.call("autoCleanNow", { dryRun: true }).then(
                    (next) => {
                      setPreview(next);
                      setBusy(false);
                    },
                    () => setBusy(false),
                  );
                }}
              >
                Preview
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy || preview === null || preview.bytesFreed === 0}
                onClick={() => {
                  setBusy(true);
                  rpc.call("autoCleanNow", { dryRun: false }).then(
                    (next) => {
                      setPreview(null);
                      setBusy(false);
                      setConfigAfterRun(next, setConfig, rpc);
                    },
                    () => setBusy(false),
                  );
                }}
              >
                Run now
              </Button>
            </div>
          </div>
          {preview === null ? null : (
            <p className="text-xs text-muted-foreground">
              Would free <span className="font-medium">{formatBytes(preview.bytesFreed)}</span> from{" "}
              {preview.succeeded} item{preview.succeeded === 1 ? "" : "s"}.
            </p>
          )}
        </Section>

        <Section
          title="Agent escalation"
          description="At Critical, Reclaim can start a thread with the full report and its tools, so an agent works the problem while you are away."
        >
          <Toggle
            checked={config.agentEscalationEnabled}
            onChange={(agentEscalationEnabled) => patch({ agentEscalationEnabled })}
            label="Hand disk pressure to an agent automatically"
            hint="At most once every 6 hours. The agent is bound by the same authorized roots."
          />
          <div>
            <div className="text-sm">Escalation project</div>
            <p className="text-xs text-muted-foreground">
              Threads are created here. Escalation stays off until one is chosen.
            </p>
            <div className="mt-1.5 flex flex-wrap gap-1.5">
              {projects.map((project) => (
                <button
                  key={project.id}
                  type="button"
                  disabled={busy}
                  onClick={() =>
                    patch({
                      escalationProjectId:
                        config.escalationProjectId === project.id ? null : project.id,
                    })
                  }
                  className={cn(
                    "rounded-md border px-2 py-1 text-xs",
                    config.escalationProjectId === project.id
                      ? "border-primary bg-primary/10 font-medium"
                      : "border-border hover:bg-secondary/60",
                  )}
                >
                  {project.name}
                </button>
              ))}
              {projects.length === 0 ? (
                <span className="text-xs text-muted-foreground">No projects found.</span>
              ) : null}
            </div>
          </div>
        </Section>

        <Section
          title="Scanning"
          description="A full scan of a 500GB volume takes about a minute and runs in the background."
        >
          <NumberField
            label="Rescan every"
            value={config.scanIntervalHours}
            min={1}
            max={720}
            suffix="hours"
            onCommit={(scanIntervalHours) => patch({ scanIntervalHours })}
          />
          <NumberField
            label="Treat a project as idle after"
            hint="Drives which node_modules are offered as reclaimable."
            value={config.staleDays}
            min={1}
            max={3650}
            suffix="days"
            onCommit={(staleDays) => patch({ staleDays })}
          />
          <Toggle
            checked={config.dockerEnabled}
            onChange={(dockerEnabled) => patch({ dockerEnabled })}
            label="Include Docker"
            hint="Build cache, dangling images and stopped containers."
          />
          <div className="border-t border-border pt-2.5 text-xs text-muted-foreground">
            Scan root <span className="font-mono">{config.scanRoot}</span>
          </div>
        </Section>
      </div>
    </div>
  );
}

/** Refresh config after a run so "last automatic run" is immediately right. */
function setConfigAfterRun(
  _result: ApplyResult,
  setConfig: (config: Config) => void,
  rpc: ReturnType<typeof useRpc<typeof rpcContract>>,
): void {
  void rpc.call("config").then(setConfig, () => {});
}
