import assert from "node:assert/strict";
import { test } from "node:test";
import {
  authorizePath,
  isStrictlyInside,
  neverDelete,
  parseRoots,
} from "../lib/roots.ts";

const HOME = "/Users/tester";
const ROOTS = [`${HOME}/Documents`, `${HOME}/.cache`];
/** Identity resolver: these tests exercise policy, not the filesystem. */
const identity = async (path) => path;

test("parseRoots expands ~ and drops comments and blanks", () => {
  const roots = parseRoots(
    ["~/Documents", "", "# a comment", "~/.cache", "/opt/build", "~"].join("\n"),
    HOME,
  );
  assert.deepEqual(roots, [
    `${HOME}/Documents`,
    `${HOME}/.cache`,
    "/opt/build",
    HOME,
  ]);
});

test("parseRoots deduplicates and normalizes", () => {
  const roots = parseRoots("~/Documents\n/Users/tester/Documents/\n~/Documents", HOME);
  assert.deepEqual(roots, [`${HOME}/Documents`]);
});

test("isStrictlyInside rejects the root itself and sibling prefixes", () => {
  assert.equal(isStrictlyInside("/a/b/c", "/a/b"), true);
  assert.equal(isStrictlyInside("/a/b", "/a/b"), false);
  // The classic prefix bug: /a/bc is not inside /a/b.
  assert.equal(isStrictlyInside("/a/bc", "/a/b"), false);
});

test("a path inside an authorized root is allowed", async () => {
  const verdict = await authorizePath(
    `${HOME}/Documents/project/node_modules`,
    ROOTS,
    { resolveSymlinks: identity },
  );
  assert.equal(verdict.ok, true);
  assert.equal(verdict.resolvedPath, `${HOME}/Documents/project/node_modules`);
});

test("a path outside every root is refused", async () => {
  const verdict = await authorizePath(`${HOME}/Pictures/holiday`, ROOTS, {
    resolveSymlinks: identity,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "outside-roots");
});

test("a root itself is never deletable", async () => {
  const verdict = await authorizePath(`${HOME}/Documents`, ROOTS, {
    resolveSymlinks: identity,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "is-root");
});

test("relative paths and traversal are refused before any resolution", async () => {
  assert.equal((await authorizePath("relative/path", ROOTS)).reason, "not-absolute");
  assert.equal(
    (await authorizePath(`${HOME}/Documents/../../etc`, ROOTS)).reason,
    "traversal",
  );
});

test("never-delete paths are refused even when a root would cover them", async () => {
  const verdict = await authorizePath("/Users", ["/"], { resolveSymlinks: identity });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "protected-path");
});

test("home itself is protected", async () => {
  const protectedPaths = neverDelete();
  assert.equal(protectedPaths.has("/"), true);
  assert.equal(protectedPaths.has("/System"), true);
});

/**
 * The escape this check exists to stop: a symlink inside an authorized root
 * that points somewhere else entirely. A string-prefix test alone would pass it.
 */
test("a symlink escaping its root is refused", async () => {
  const resolveSymlinks = async (path) =>
    path === `${HOME}/Documents/evil` ? "/etc/passwd" : path;
  const verdict = await authorizePath(`${HOME}/Documents/evil`, ROOTS, {
    resolveSymlinks,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "outside-roots");
  assert.equal(verdict.resolvedPath, "/etc/passwd");
});

test("a symlink resolving to a protected path is refused", async () => {
  const resolveSymlinks = async (path) =>
    path === `${HOME}/Documents/link` ? "/System" : path;
  const verdict = await authorizePath(`${HOME}/Documents/link`, ROOTS, {
    resolveSymlinks,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "protected-path");
});

test("a root given as a symlink still matches its resolved candidate", async () => {
  const resolveSymlinks = async (path) =>
    path === "/link-root" ? `${HOME}/Documents` : path;
  const verdict = await authorizePath(
    `${HOME}/Documents/build`,
    ["/link-root"],
    { resolveSymlinks },
  );
  assert.equal(verdict.ok, true);
});

test("a missing path is refused rather than assumed safe", async () => {
  const resolveSymlinks = async () => {
    throw new Error("ENOENT");
  };
  const verdict = await authorizePath(`${HOME}/Documents/gone`, ROOTS, {
    resolveSymlinks,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "missing");
});

test("an empty root list authorizes nothing", async () => {
  const verdict = await authorizePath(`${HOME}/Documents/x`, [], {
    resolveSymlinks: identity,
  });
  assert.equal(verdict.ok, false);
  assert.equal(verdict.reason, "outside-roots");
});
