import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveProjectPaths } from "../../src/main/resolve-project.ts";

// The regression this file exists for: binding a CHILD repo nested inside a
// parent folder that itself has `.hivemind/`. findRoot climbs UP and returns
// the parent's `.hivemind`; the picked child's own git repo must still win.
test("child repo nested under a parent .hivemind binds to the CHILD, not the parent", () => {
  // Picked ~/Workspace/snr-agentx. findRoot climbed to ~/Workspace/.hivemind;
  // findGitRoot found ~/Workspace/snr-agentx (its own .git).
  const r = resolveProjectPaths(
    "/home/u/Workspace/.hivemind",
    "/home/u/Workspace/snr-agentx",
  );
  assert.equal(r.repoPath, "/home/u/Workspace/snr-agentx", "repoPath = the picked child repo");
  assert.equal(r.root, null, "the parent's .hivemind is NOT adopted as the child's issues root");
});

test("launching directly in a hivemind repo keeps its own root + repoPath", () => {
  // ~/proj has BOTH .hivemind/ and .git/ — foundRoot's parent === gitRoot.
  const r = resolveProjectPaths("/home/u/proj/.hivemind", "/home/u/proj");
  assert.equal(r.repoPath, "/home/u/proj");
  assert.equal(r.root, "/home/u/proj/.hivemind", "own .hivemind is adopted (parent matches git root)");
});

test("parent workspace folder with .hivemind but no git keeps root + folder repoPath", () => {
  // ~/Workspace has .hivemind/ but is not a git repo (findGitRoot === null).
  const r = resolveProjectPaths("/home/u/Workspace/.hivemind", null);
  assert.equal(r.repoPath, "/home/u/Workspace", "repoPath falls back to the .hivemind's folder");
  assert.equal(r.root, "/home/u/Workspace/.hivemind", "no git root to prefer → keep the found root");
});

test("plain git repo with no .hivemind anywhere → repoPath only, no root", () => {
  const r = resolveProjectPaths(null, "/home/u/some-repo");
  assert.equal(r.repoPath, "/home/u/some-repo");
  assert.equal(r.root, null);
});

test("nothing found → both null", () => {
  const r = resolveProjectPaths(null, null);
  assert.equal(r.repoPath, null);
  assert.equal(r.root, null);
});

test("child git repo WITH its own .hivemind adopts its own root", () => {
  // findRoot stops at the child's own .hivemind (doesn't climb): parent === gitRoot.
  const r = resolveProjectPaths(
    "/home/u/Workspace/child/.hivemind",
    "/home/u/Workspace/child",
  );
  assert.equal(r.repoPath, "/home/u/Workspace/child");
  assert.equal(r.root, "/home/u/Workspace/child/.hivemind");
});
