import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { formatBytes, formatPercent } from "@/lib/format";
import {
  barPercent,
  levelIcon,
  levelLabel,
  levelTone,
  toneBorder,
  toneFill,
  toneText,
  toneTrack,
  type Tone,
} from "@/lib/ui";
import type { Capacity } from "@/lib/contract";

/** A thin magnitude bar for a table row. One hue: it encodes size, not identity. */
export function SizeBar({
  bytes,
  max,
  tone = "info",
  className,
}: {
  bytes: number;
  max: number;
  tone?: Tone;
  className?: string;
}) {
  return (
    <div className={cn("h-1 w-full overflow-hidden rounded-full bg-muted-foreground/10", className)}>
      <div
        className={cn("h-full rounded-full", toneFill[tone])}
        style={{ width: `${barPercent(bytes, max)}%` }}
      />
    </div>
  );
}

export function StatTile({
  label,
  value,
  hint,
  tone = "neutral",
}: {
  label: string;
  value: string;
  hint?: string;
  tone?: Tone;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
        {label}
      </div>
      <div className={cn("mt-0.5 truncate text-lg font-semibold tabular-nums", toneText[tone])}>
        {value}
      </div>
      {hint === undefined ? null : (
        <div className="truncate text-xs text-muted-foreground">{hint}</div>
      )}
    </div>
  );
}

/**
 * The index can legitimately exceed the volume's used bytes.
 *
 * `st_blocks` reports a full allocation for every APFS clone even though the
 * blocks are shared, so a volume with cloned files sums to more than it holds —
 * `du` reports the same thing. Saying so is better than printing "104% of used"
 * and looking broken.
 */
function indexedHint(indexedBytes: number | null, usedBytes: number): string | undefined {
  if (indexedBytes === null || indexedBytes === 0) return "no scan yet";
  if (usedBytes <= 0) return undefined;
  if (indexedBytes > usedBytes * 1.02) return "clones counted per copy";
  return `${formatPercent(indexedBytes / usedBytes)} of used`;
}

export function LevelPill({ capacity }: { capacity: Capacity }) {
  const tone = levelTone(capacity.level);
  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border px-2 py-0.5 text-xs font-medium",
        toneBorder[tone],
        toneText[tone],
      )}
    >
      <Icon name={levelIcon(capacity.level)} className="size-3.5" />
      {levelLabel(capacity.level)}
    </span>
  );
}

/**
 * The header band: one hero number, one segmented bar, four figures.
 *
 * The bar splits "used" so the answer to "what can I do about it" is visible in
 * the same glance as the problem — a distinct step of the same hue shows how
 * much of the used space Reclaim believes it can give back.
 */
export function CapacityBand({
  capacity,
  reclaimableBytes,
  indexedBytes,
}: {
  capacity: Capacity;
  reclaimableBytes: number | null;
  indexedBytes: number | null;
}) {
  const { primary } = capacity;
  const tone = levelTone(capacity.level);
  const total = Math.max(1, primary.totalBytes);
  const reclaimable = Math.min(reclaimableBytes ?? 0, primary.usedBytes);
  const heldPercent = ((primary.usedBytes - reclaimable) / total) * 100;
  const reclaimablePercent = (reclaimable / total) * 100;
  const freePercent = Math.max(0, 100 - heldPercent - reclaimablePercent);

  return (
    <div className="border-b border-border bg-card/40 px-4 py-3 md:px-5">
      <div className="flex flex-wrap items-end justify-between gap-x-6 gap-y-2">
        <div className="flex items-baseline gap-3">
          <span className={cn("text-3xl font-semibold tabular-nums leading-none", toneText[tone])}>
            {formatPercent(primary.usedFraction, 1)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <span className="text-sm font-medium">full</span>
              <LevelPill capacity={capacity} />
            </div>
            <div className="truncate text-xs text-muted-foreground">
              {primary.label ?? primary.mountPoint}
              {primary.sharesPool ? " · shared APFS pool" : ""}
            </div>
          </div>
        </div>

        <div className="grid shrink-0 grid-cols-2 gap-x-6 gap-y-1 sm:grid-cols-4">
          <StatTile
            label="Free"
            value={formatBytes(primary.freeBytes)}
            tone={tone}
            hint={`of ${formatBytes(primary.totalBytes)}`}
          />
          <StatTile label="Used" value={formatBytes(primary.usedBytes)} />
          <StatTile
            label="Reclaimable"
            value={reclaimableBytes === null ? "—" : formatBytes(reclaimable)}
            tone={reclaimable > 0 ? "info" : "neutral"}
            hint={reclaimableBytes === null ? "not planned yet" : undefined}
          />
          <StatTile
            label="Indexed"
            value={indexedBytes === null || indexedBytes === 0 ? "—" : formatBytes(indexedBytes)}
            hint={indexedHint(indexedBytes, primary.usedBytes)}
          />
        </div>
      </div>

      {/* Segmented capacity bar. 2px surface gaps keep the segments legible
          against each other without a border. */}
      <div className="mt-3 flex h-2.5 w-full gap-0.5" role="img" aria-label={capacity.reason}>
        {heldPercent > 0 ? (
          <div
            className={cn("rounded-[3px]", toneFill[tone])}
            style={{ width: `${heldPercent}%` }}
          />
        ) : null}
        {reclaimablePercent > 0 ? (
          <div
            className={cn("rounded-[3px]", toneFill[tone], "opacity-40")}
            style={{ width: `${reclaimablePercent}%` }}
          />
        ) : null}
        {freePercent > 0 ? (
          <div className={cn("rounded-[3px]", toneTrack[tone])} style={{ width: `${freePercent}%` }} />
        ) : null}
      </div>

      <div className="mt-1.5 flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <span>{capacity.reason}</span>
        {reclaimable > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <span className={cn("size-2 rounded-[2px] opacity-40", toneFill[tone])} aria-hidden />
            {formatBytes(reclaimable)} Reclaim can free
          </span>
        ) : null}
        {capacity.snapshots.length > 0 ? (
          <span className="inline-flex items-center gap-1.5">
            <Icon name="Layers" className="size-3.5" />
            {capacity.snapshots.length} local snapshot
            {capacity.snapshots.length === 1 ? "" : "s"} held by macOS
          </span>
        ) : null}
      </div>
    </div>
  );
}
