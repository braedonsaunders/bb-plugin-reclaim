import assert from "node:assert/strict";
import { test } from "node:test";
import { parseDockerDf, parseDockerReclaimed, parseDockerSize, trimmableBytes } from "../lib/docker.ts";

test("parseDockerSize understands docker's units", () => {
  assert.equal(parseDockerSize("1.234GB"), 1_234_000_000);
  assert.equal(parseDockerSize("512MB (45%)"), 512_000_000);
  assert.equal(parseDockerSize("4.5GiB"), 4_500_000_000);
  assert.equal(parseDockerSize("0B"), 0);
  assert.equal(parseDockerSize("nonsense"), 0);
});

test("parseDockerDf maps each section and sums the total held", () => {
  const stdout = [
    '{"Type":"Images","TotalCount":"20","Size":"9GB","Reclaimable":"4.2GB (46%)"}',
    '{"Type":"Containers","TotalCount":"3","Size":"1GB","Reclaimable":"800MB"}',
    '{"Type":"Local Volumes","TotalCount":"5","Size":"2GB","Reclaimable":"1.5GB"}',
    '{"Type":"Build Cache","TotalCount":"100","Size":"12GB","Reclaimable":"12GB"}',
    "not json at all",
    "",
  ].join("\n");
  const usage = parseDockerDf(stdout);
  assert.equal(usage.danglingImageBytes, 4_200_000_000);
  assert.equal(usage.stoppedContainerBytes, 800_000_000);
  assert.equal(usage.unusedVolumeBytes, 1_500_000_000);
  assert.equal(usage.buildCacheBytes, 12_000_000_000);
  // Total is what Docker holds, reclaimable or not: 9 + 1 + 2 + 12.
  assert.equal(usage.totalBytes, 24_000_000_000);
});

test("parseDockerReclaimed reads the prune summary", () => {
  assert.equal(
    parseDockerReclaimed("deleted: sha256:abc\nTotal reclaimed space: 4.2GB\n"),
    4_200_000_000,
  );
  assert.equal(parseDockerReclaimed("nothing happened"), 0);
});

/* ---------------- the sparse-image gap ---------------- */

function state({ allocated, held }) {
  return {
    cli: "/usr/local/bin/docker",
    daemonRunning: true,
    reason: null,
    usage: {
      buildCacheBytes: 0,
      danglingImageBytes: 0,
      stoppedContainerBytes: 0,
      unusedVolumeBytes: 0,
      totalBytes: held,
    },
    diskImage: { path: "/x/Docker.raw", apparentBytes: 460e9, allocatedBytes: allocated },
  };
}

/**
 * The case this whole feature exists for: Docker reports almost nothing inside
 * the VM, while the host's sparse image is still holding tens of gigabytes
 * because nothing ever issued a TRIM.
 */
test("trimmable is the gap between what the image costs and what it holds", () => {
  assert.equal(trimmableBytes(state({ allocated: 66e9, held: 24e9 })), 42e9);
});

test("a freshly compacted image offers nothing", () => {
  assert.equal(trimmableBytes(state({ allocated: 24e9, held: 24e9 })), 0);
});

test("sub-gigabyte slack is filesystem overhead, not a candidate", () => {
  assert.equal(trimmableBytes(state({ allocated: 24.5e9, held: 24e9 })), 0);
});

test("a negative gap never becomes a candidate", () => {
  assert.equal(trimmableBytes(state({ allocated: 10e9, held: 24e9 })), 0);
});

test("no disk image or no usage means nothing to trim", () => {
  const noImage = { ...state({ allocated: 66e9, held: 24e9 }), diskImage: null };
  const noUsage = { ...state({ allocated: 66e9, held: 24e9 }), usage: null };
  assert.equal(trimmableBytes(noImage), 0);
  assert.equal(trimmableBytes(noUsage), 0);
});
