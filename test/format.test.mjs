import assert from "node:assert/strict";
import { test } from "node:test";
import {
  daysBetween,
  ellipsizePath,
  formatAgo,
  formatBytes,
  formatDuration,
  formatPercent,
  shortenPath,
} from "../lib/format.ts";
import { evaluatePressure, DEFAULT_THRESHOLDS } from "../lib/volumes.ts";
import { insideBundle } from "../lib/reclaimers.ts";
import { barPercent, levelLabel, levelTone, riskTone } from "../lib/ui.ts";

test("formatBytes uses powers of 1000, matching Finder and df -h", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(999), "999 B");
  assert.equal(formatBytes(1000), "1.00 KB");
  assert.equal(formatBytes(1_500_000), "1.50 MB");
  assert.equal(formatBytes(494_384_795_648), "494 GB");
  assert.equal(formatBytes(-1000), "-1.00 KB");
});

test("formatBytes degrades on non-finite input rather than printing NaN", () => {
  assert.equal(formatBytes(Number.NaN), "—");
  assert.equal(formatBytes(Number.POSITIVE_INFINITY), "—");
});

test("shortenPath collapses the home directory", () => {
  assert.equal(shortenPath("/Users/me/Documents/x", "/Users/me"), "~/Documents/x");
  assert.equal(shortenPath("/Users/me", "/Users/me"), "~");
  assert.equal(shortenPath("/opt/build", "/Users/me"), "/opt/build");
  // A sibling directory that merely shares the prefix is left alone.
  assert.equal(shortenPath("/Users/meta/x", "/Users/me"), "/Users/meta/x");
});

test("ellipsizePath keeps the identifying tail", () => {
  assert.equal(ellipsizePath("/a/b/c", 20), "/a/b/c");
  assert.equal(ellipsizePath("/very/long/path/to/thing", 10).endsWith("thing"), true);
});

test("formatPercent and formatDuration", () => {
  assert.equal(formatPercent(0.985, 1), "98.5%");
  assert.equal(formatDuration(500), "500ms");
  assert.equal(formatDuration(73_294), "1m 13s");
  assert.equal(formatDuration(3_600_000), "1h 0m");
});

test("formatAgo handles never and recent", () => {
  assert.equal(formatAgo(null), "never");
  const now = 1_700_000_000_000;
  assert.equal(formatAgo(now - 1000, now), "just now");
  assert.equal(formatAgo(now - 3 * 86_400_000, now), "3d ago");
});

test("daysBetween never goes negative", () => {
  assert.equal(daysBetween(1000, 0), 0);
  assert.equal(daysBetween(0, 86_400_000 * 3), 3);
});

/* ---------------- pressure ---------------- */

function volume(usedFraction, freeGb) {
  return {
    mountPoint: "/",
    device: null,
    fsType: "apfs",
    label: null,
    totalBytes: 500e9,
    freeBytes: freeGb * 1e9,
    usedBytes: 500e9 * usedFraction,
    usedFraction,
    isPrimary: true,
    sharesPool: true,
  };
}

test("pressure is ok with room on both signals", () => {
  assert.equal(evaluatePressure(volume(0.5, 250), DEFAULT_THRESHOLDS).level, "ok");
});

test("percent-full alone can raise the level", () => {
  assert.equal(evaluatePressure(volume(0.92, 40), DEFAULT_THRESHOLDS).level, "warn");
  assert.equal(evaluatePressure(volume(0.985, 40), DEFAULT_THRESHOLDS).level, "critical");
});

/**
 * The case percent-full misses: a large array at 88% still has very little
 * absolute headroom left in this configuration.
 */
test("the absolute floor wins when it is angrier than the percentage", () => {
  const verdict = evaluatePressure(volume(0.88, 2), DEFAULT_THRESHOLDS);
  assert.equal(verdict.level, "critical");
  assert.match(verdict.reason, /Only/);
});

test("the percentage wins when it is angrier than the floor", () => {
  const verdict = evaluatePressure(volume(0.97, 400), DEFAULT_THRESHOLDS);
  assert.equal(verdict.level, "critical");
  assert.match(verdict.reason, /threshold/);
});

/* ---------------- ui helpers ---------------- */

test("bars scale against the largest sibling and stay visible", () => {
  assert.equal(barPercent(100, 100), 100);
  assert.equal(barPercent(50, 100), 50);
  assert.equal(barPercent(0, 100), 0);
  // A tiny non-zero value still renders as a sliver rather than vanishing.
  assert.equal(barPercent(1, 1_000_000), 1.5);
  assert.equal(barPercent(10, 0), 0);
});

test("levels and risks map to distinct tones", () => {
  assert.equal(levelTone("ok"), "good");
  assert.equal(levelTone("critical"), "critical");
  assert.equal(levelLabel("watch"), "Watch");
  assert.equal(riskTone("safe"), "good");
  assert.equal(riskTone("careful"), "warn");
});

/* ---------------- bundle protection ---------------- */

test("nothing inside a macOS bundle is ever a candidate", () => {
  // The real false positive this rule was written for: VS Code ships an `out/`
  // beside a `package.json`, which is exactly the evidence the build-output
  // rule looks for.
  assert.equal(
    insideBundle(
      "/Users/me/Library/Caches/x/Visual Studio Code.app/Contents/Resources/app/out",
    ),
    true,
  );
  assert.equal(insideBundle("/Applications/Xcode.app/Contents/Frameworks/a.framework/x"), true);
  assert.equal(insideBundle("/Users/me/p/Some.bundle/node_modules"), true);
  assert.equal(insideBundle("/Users/me/p/thing.appex/dist"), true);
});

test("ordinary project paths are not treated as bundles", () => {
  assert.equal(insideBundle("/Users/me/Documents/parlour/apps/web/.next"), false);
  assert.equal(insideBundle("/Users/me/Documents/code/dist"), false);
  // A directory merely *named* like an app, without the extension, is fine.
  assert.equal(insideBundle("/Users/me/apps/web/out"), false);
});
