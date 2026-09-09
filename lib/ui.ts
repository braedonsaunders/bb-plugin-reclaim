/**
 * Visual language.
 *
 * Two rules the whole UI follows:
 *
 * 1. **Size bars use one hue.** Every bar in Reclaim encodes magnitude ("how
 *    big"), not identity, so they all draw from a single sequential hue. A
 *    multi-colour palette here would imply the colours mean something.
 * 2. **Status colour is reserved and never used alone.** Pressure level is the
 *    only thing that gets good/warn/critical colour, and every place it appears
 *    it carries an icon and a word too, so the state survives colourblindness,
 *    greyscale printing, and forced-colours mode.
 *
 * Colours are BB theme tokens rather than literals, so light and dark are the
 * host's already-designed pairs instead of an automatic flip.
 */
import type { PressureLevel, Risk } from "./contract";

export type Tone = "good" | "info" | "warn" | "critical" | "neutral";

export function levelTone(level: PressureLevel): Tone {
  if (level === "critical") return "critical";
  if (level === "warn") return "warn";
  if (level === "watch") return "info";
  return "good";
}

export function levelLabel(level: PressureLevel): string {
  if (level === "critical") return "Critical";
  if (level === "warn") return "Warning";
  if (level === "watch") return "Watch";
  return "Healthy";
}

/** Paired with the tone everywhere, so state is never colour-alone. */
export function levelIcon(level: PressureLevel): "AlertTriangle" | "AlertCircle" | "Info" | "CircleCheck" {
  if (level === "critical") return "AlertTriangle";
  if (level === "warn") return "AlertCircle";
  if (level === "watch") return "Info";
  return "CircleCheck";
}

export const toneText: Record<Tone, string> = {
  good: "text-success",
  info: "text-primary",
  warn: "text-destructive/80",
  critical: "text-destructive",
  neutral: "text-muted-foreground",
};

export const toneFill: Record<Tone, string> = {
  good: "bg-success",
  info: "bg-primary",
  warn: "bg-destructive/70",
  critical: "bg-destructive",
  neutral: "bg-muted-foreground",
};

/**
 * The unfilled track is a light step of the fill's own colour, so the whole bar
 * carries the state rather than only the filled part.
 */
export const toneTrack: Record<Tone, string> = {
  good: "bg-success/15",
  info: "bg-primary/15",
  warn: "bg-destructive/10",
  critical: "bg-destructive/15",
  neutral: "bg-muted-foreground/15",
};

export const toneBorder: Record<Tone, string> = {
  good: "border-success/30",
  info: "border-primary/30",
  warn: "border-destructive/25",
  critical: "border-destructive/40",
  neutral: "border-border",
};

export function riskTone(risk: Risk): Tone {
  if (risk === "safe") return "good";
  if (risk === "rebuildable") return "info";
  return "warn";
}

export function riskLabel(risk: Risk): string {
  if (risk === "safe") return "Safe";
  if (risk === "rebuildable") return "Rebuildable";
  return "Careful";
}

/**
 * Bars scale against the largest sibling, not the total: a folder holding 4% of
 * a listing still needs a visible bar to be comparable with its neighbours. The
 * percentage-of-total stays in the text label, where the precision belongs.
 */
export function barPercent(bytes: number, max: number): number {
  if (max <= 0 || bytes <= 0) return 0;
  return Math.max(1.5, Math.min(100, (bytes / max) * 100));
}
