import assert from "node:assert/strict";
import { test } from "node:test";
import { allocatedBytes, countedBytes, shareKey } from "../lib/file-stat.ts";

const unique = {
  dev: 1,
  ino: 10,
  nlink: 1,
  size: 8000,
  blocks: 16,
  mtimeMs: 1,
  cloneId: 10,
  cloneRefcnt: 1,
  privateBytes: 8192,
};

const hardlink = { ...unique, nlink: 2, cloneId: null, cloneRefcnt: null, privateBytes: null };

const cloneOrigin = {
  ...unique,
  ino: 100,
  cloneId: 100,
  cloneRefcnt: 3,
  privateBytes: 0,
};

const cloneCopy = {
  ...cloneOrigin,
  ino: 200,
  privateBytes: 4096,
};

test("shareKey uses inode for hardlinks and clone-id for APFS clones", () => {
  assert.equal(shareKey(unique), null);
  assert.equal(shareKey(hardlink), "h:1:10");
  assert.equal(shareKey(cloneOrigin), "c:1:100");
  assert.equal(shareKey(cloneCopy), "c:1:100");
  assert.equal(shareKey({ ...cloneOrigin, cloneRefcnt: 1 }), null);
  assert.equal(shareKey({ ...cloneOrigin, cloneId: 0 }), null);
});

test("countedBytes attributes the full stream to the first name", () => {
  assert.equal(allocatedBytes(cloneOrigin), 8192);
  assert.equal(countedBytes(cloneOrigin, false), 8192);
  assert.equal(countedBytes(cloneCopy, true), 4096);
  assert.equal(countedBytes({ ...cloneCopy, privateBytes: 0 }, true), 0);
  assert.equal(countedBytes(hardlink, true), 0);
});
