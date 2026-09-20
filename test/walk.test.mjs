import assert from "node:assert/strict";
import { test, before, after } from "node:test";
import { copyFile, constants, mkdtemp, mkdir, writeFile, link, rm } from "node:fs/promises";
import { platform, tmpdir } from "node:os";
import { join } from "node:path";
import { walk } from "../lib/walk.ts";

let root;

/**
 * A fixture with the three things the aggregation has to get right: nesting,
 * an opaque directory, and a hardlinked file counted twice by a naive walker.
 *
 *   root/
 *     a/            small.txt (1KB)
 *       b/          nested.txt (2KB)
 *     node_modules/ deep/deep/pkg.txt (4KB)     <- opaque
 *     linked-1.txt  <-> linked-2.txt            <- one inode, two names
 */
before(async () => {
  root = await mkdtemp(join(tmpdir(), "reclaim-walk-"));
  await mkdir(join(root, "a", "b"), { recursive: true });
  await mkdir(join(root, "node_modules", "deep", "deep"), { recursive: true });
  await writeFile(join(root, "a", "small.txt"), "x".repeat(1024));
  await writeFile(join(root, "a", "b", "nested.txt"), "x".repeat(2048));
  await writeFile(join(root, "node_modules", "deep", "deep", "pkg.txt"), "x".repeat(4096));
  await writeFile(join(root, "linked-1.txt"), "x".repeat(8192));
  await link(join(root, "linked-1.txt"), join(root, "linked-2.txt"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

async function collect(options = {}) {
  const records = new Map();
  const result = await walk({
    root,
    onDirectory: (record) => records.set(record.path, record),
    ...options,
  });
  return { result, records };
}

test("subtree totals equal children plus own files, at every level", async () => {
  const { records } = await collect();
  // Opaque roots are excluded by construction: their descendants are measured
  // but deliberately not stored, so their stored children cannot add up.
  for (const record of [...records.values()].filter((row) => !row.opaque)) {
    const children = [...records.values()].filter((row) => row.parentId === record.id);
    const childBytes = children.reduce((sum, row) => sum + row.treeBytes, 0);
    assert.equal(
      record.selfBytes + childBytes,
      record.treeBytes,
      `${record.path}: ${record.selfBytes} + ${childBytes} !== ${record.treeBytes}`,
    );
  }
});

test("the root record's total matches the walk result", async () => {
  const { result, records } = await collect();
  assert.equal(records.get(root).treeBytes, result.totalBytes);
});

test("hardlinked files are counted once", async () => {
  const { records } = await collect();
  const rootRecord = records.get(root);
  // Two 8KB names sharing one inode must contribute 8KB, not 16KB. Compare
  // against the subtree total, which is allocation-based and block-rounded.
  const nested = records.get(join(root, "a")).treeBytes;
  const modules = records.get(join(root, "node_modules")).treeBytes;
  const linkBytes = rootRecord.treeBytes - nested - modules;
  assert.ok(
    linkBytes >= 8192 && linkBytes < 16384,
    `hardlink pair contributed ${linkBytes} bytes; expected one copy`,
  );
  // treeFiles counts what treeBytes counts, so the deduplicated name is
  // excluded from both: 5 directory entries, 4 distinct files.
  assert.equal(rootRecord.treeFiles, 4);
});

test("filesSeen counts entries encountered, before hardlink dedup", async () => {
  const { result } = await collect();
  assert.equal(result.filesSeen, 5);
});

test("an opaque directory is stored once but measured in full", async () => {
  const { records } = await collect();
  const modules = records.get(join(root, "node_modules"));
  assert.ok(modules !== undefined, "the opaque root itself is stored");
  assert.equal(modules.opaque, true);
  assert.ok(modules.treeBytes >= 4096, "its full subtree is still measured");
  assert.equal(modules.treeFiles, 1);
  // Its descendants are deliberately absent from the index.
  assert.equal(records.has(join(root, "node_modules", "deep")), false);
  assert.equal(records.has(join(root, "node_modules", "deep", "deep")), false);
});

test("opaque descendants still count toward dirsSeen but not dirsStored", async () => {
  const { result } = await collect();
  assert.ok(result.dirsSeen > result.dirsStored);
});

test("treating nothing as opaque stores the whole tree", async () => {
  const { records } = await collect({ opaqueNames: new Set() });
  assert.equal(records.has(join(root, "node_modules", "deep", "deep")), true);
});

test("skipPaths prunes a subtree from the totals", async () => {
  const { records } = await collect({
    skipPaths: new Set([join(root, "node_modules")]),
  });
  assert.equal(records.has(join(root, "node_modules")), false);
  const rootRecord = records.get(root);
  const modulesBytes = 4096;
  assert.ok(
    rootRecord.treeBytes < 8192 + 1024 + 2048 + modulesBytes + 8192,
    "skipped bytes are excluded",
  );
});

test("newestMtimeMs rolls up from the deepest file", async () => {
  const { records } = await collect();
  const rootRecord = records.get(root);
  const nested = records.get(join(root, "a", "b"));
  assert.ok(rootRecord.newestMtimeMs >= nested.newestMtimeMs);
  assert.ok(nested.newestMtimeMs > 0);
});

test("the biggest file is reported in topFiles", async () => {
  const { result } = await collect();
  assert.ok(result.topFiles.length > 0);
  assert.equal(result.topFiles[0].bytes >= 8192, true);
});

test("topFiles honours its limit", async () => {
  const { result } = await collect({ topFiles: 2 });
  assert.equal(result.topFiles.length, 2);
  assert.ok(result.topFiles[0].bytes >= result.topFiles[1].bytes);
});

test("an aborted walk reports aborted and still returns a total", async () => {
  const controller = new AbortController();
  controller.abort();
  const result = await walk({ root, signal: controller.signal, onDirectory: () => {} });
  assert.equal(result.aborted, true);
  assert.equal(typeof result.totalBytes, "number");
});

test("a missing root is an unreadable count, not a throw", async () => {
  const result = await walk({
    root: join(root, "does-not-exist"),
    onDirectory: () => {},
  });
  assert.equal(result.unreadable, 1);
  assert.equal(result.totalBytes, 0);
});

test("injected APFS clones are counted once, plus later private bytes", async () => {
  const fixture = await mkdtemp(join(tmpdir(), "reclaim-clone-"));
  try {
    await writeFile(join(fixture, "origin.bin"), "x");
    await writeFile(join(fixture, "copy.bin"), "y");
    const shared = {
      dev: 1,
      ino: 1,
      nlink: 1,
      size: 1_048_576,
      blocks: 2048,
      mtimeMs: 1,
      cloneId: 99n,
      cloneRefcnt: 2,
      privateBytes: 0,
    };
    const records = new Map();
    const result = await walk({
      root: fixture,
      onDirectory: (record) => records.set(record.path, record),
      statFile: async (path) =>
        path.endsWith("copy.bin")
          ? { ...shared, ino: 2, privateBytes: 4096 }
          : { ...shared },
    });
    const row = records.get(fixture);
    // One 1MB allocation + 4KB of COW bytes on the second name, not 2MB.
    assert.equal(row.treeBytes, 1_048_576 + 4096);
    assert.equal(row.treeFiles, 2);
    assert.equal(result.filesSeen, 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("APFS clonefile copies are counted once on Darwin", async (t) => {
  if (platform() !== "darwin") {
    t.skip("clonefile is an APFS feature");
    return;
  }
  const fixture = await mkdtemp(join(tmpdir(), "reclaim-clonefile-"));
  try {
    const src = join(fixture, "src.bin");
    const dest = join(fixture, "dest.bin");
    await writeFile(src, "c".repeat(256 * 1024));
    try {
      await copyFile(src, dest, constants.COPYFILE_FICLONE_FORCE);
    } catch (error) {
      t.skip(`clonefile unavailable: ${error instanceof Error ? error.message : error}`);
      return;
    }
    const records = new Map();
    await walk({
      root: fixture,
      onDirectory: (record) => records.set(record.path, record),
    });
    const row = records.get(fixture);
    const oneCopy = 256 * 1024;
    assert.ok(
      row.treeBytes >= oneCopy && row.treeBytes < oneCopy * 2,
      `clone pair contributed ${row.treeBytes} bytes; expected one copy`,
    );
    assert.ok(row.treeFiles >= 1 && row.treeFiles <= 2);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
