// buildBaseNodes is the pure react-flow node-array builder. These unit tests
// cover the logic previously only exercised via slow Electron e2e: worktree /
// workspace zone cwd·repoPath·root scoping (incl. the cross-repo-leak guard),
// parents-before-children ordering, relative child positioning, and zIndex tiers.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBaseNodes, type NodeBuildCtx } from "../../src/renderer/src/canvas-node-build.ts";
import type { FrameState, TileInstance } from "../../src/renderer/src/canvas-persistence.ts";

const noop = () => {};
function ctx(over: Partial<NodeBuildCtx>): NodeBuildCtx {
  return {
    repoPath: "/base/repo", root: "/base/repo/.hivemind", cwd: "/base/repo",
    tiles: [], frames: [], frameOf: {}, pinnedIds: new Set(), sizes: {}, positions: {}, editorTabs: {},
    tileNames: {}, agentTitles: {}, frameTiles: new Map(), framesChipNames: {},
    updateFrameTitle: noop, updateFrameColor: noop, deleteFrame: noop, arrangeFrame: noop,
    bringFrameToFront: noop, onAttachWorktree: noop, onCreateWorktree: noop, unbindBranch: noop,
    bindWorkspace: noop, unbindWorkspace: noop, openFileInTile: noop, closeTabInTile: noop,
    closeTile: noop, onNodeResizeCommit: noop, renameTile: noop, setAgentTitle: noop,
    onTogglePin: noop,
    ...over,
  };
}
const frame = (over: Partial<FrameState>): FrameState => ({
  id: "f", x: 0, y: 0, w: 800, h: 600, title: "F", color: "#fff", z: 1, ...over,
});
const tile = (over: Partial<TileInstance>): TileInstance => ({ id: "t", kind: "shell", label: "shell", ...over });
const byId = (nodes: ReturnType<typeof buildBaseNodes>, id: string) => nodes.find((n) => n.id === id)!;

test("tile in a WORKTREE zone scopes cwd + repoPath to the worktree path; issues root stays base", () => {
  const frames = [frame({ id: "wt", worktreePath: "/wt/feature", branch: "feature", parentFrameId: "repo" }), frame({ id: "repo" })];
  const tiles = [tile({ id: "sh", kind: "shell" }), tile({ id: "iss", kind: "issues", label: "Issues" })];
  const nodes = buildBaseNodes(ctx({ frames, tiles, frameOf: { sh: "wt", iss: "wt" }, positions: { sh: { x: 10, y: 10 }, iss: { x: 20, y: 20 } } }));
  const sh = byId(nodes, "sh").data as Record<string, unknown>;
  assert.equal(sh.cwd, "/wt/feature"); // terminal runs in the worktree
  const iss = byId(nodes, "iss").data as Record<string, unknown>;
  // A worktree shares the repo's .hivemind — issues stay the BASE root, NOT the worktree.
  assert.equal(iss.root, "/base/repo/.hivemind");
});

test("tile in a WORKSPACE zone scopes cwd/repoPath/root to the bound repo", () => {
  const frames = [frame({ id: "ws", workspacePath: "/other/proj", workspaceRoot: "/other/proj/.hivemind" })];
  const nodes = buildBaseNodes(ctx({
    frames,
    tiles: [tile({ id: "sh", kind: "shell" }), tile({ id: "iss", kind: "issues", label: "Issues" })],
    frameOf: { sh: "ws", iss: "ws" },
    positions: { sh: { x: 0, y: 0 }, iss: { x: 0, y: 0 } },
  }));
  assert.equal((byId(nodes, "sh").data as Record<string, unknown>).cwd, "/other/proj");
  assert.equal((byId(nodes, "iss").data as Record<string, unknown>).root, "/other/proj/.hivemind");
});

test("cross-repo-leak guard: a workspace zone with NO .hivemind nulls root (never leaks base)", () => {
  const frames = [frame({ id: "ws", workspacePath: "/other/proj", workspaceRoot: null })];
  const nodes = buildBaseNodes(ctx({
    frames, tiles: [tile({ id: "iss", kind: "issues", label: "Issues" })],
    frameOf: { iss: "ws" }, positions: { iss: { x: 0, y: 0 } },
  }));
  assert.equal((byId(nodes, "iss").data as Record<string, unknown>).root, null);
});

test("a base-frame (no zone) tile keeps the canvas base cwd/repoPath/root", () => {
  const frames = [frame({ id: "base", workspacePath: undefined })];
  const nodes = buildBaseNodes(ctx({
    frames, tiles: [tile({ id: "sh", kind: "shell" })], frameOf: { sh: "base" }, positions: { sh: { x: 0, y: 0 } },
  }));
  assert.equal((byId(nodes, "sh").data as Record<string, unknown>).cwd, "/base/repo");
});

test("frames emit PARENTS before worktree CHILDREN; child position is relative + zIndex tiers hold", () => {
  const frames = [
    frame({ id: "child", x: 120, y: 140, parentFrameId: "parent", z: 5 }),
    frame({ id: "parent", x: 100, y: 100, z: 3 }),
  ];
  const nodes = buildBaseNodes(ctx({ frames }));
  const order = nodes.filter((n) => n.type === "frame").map((n) => n.id);
  assert.deepEqual(order, ["parent", "child"], "parent emitted before its child");
  const child = byId(nodes, "child");
  assert.deepEqual(child.position, { x: 20, y: 40 }, "child position relative to parent (120-100, 140-100)");
  assert.equal(child.parentId, "parent");
  // zIndex: parent ≤40, child 50–90.
  const pz = (byId(nodes, "parent").style as { zIndex: number }).zIndex;
  const cz = (child.style as { zIndex: number }).zIndex;
  assert.ok(pz <= 40 && cz >= 50 && cz < 100, `parent ${pz} < child ${cz} < 100`);
});

test("editor/diff tiles are skipped when there's no repo", () => {
  const nodes = buildBaseNodes(ctx({
    repoPath: null, root: null,
    tiles: [tile({ id: "ed", kind: "editor", label: "Editor" }), tile({ id: "sh", kind: "shell" })],
  }));
  assert.equal(nodes.find((n) => n.id === "ed"), undefined, "editor skipped without a repo");
  assert.ok(nodes.find((n) => n.id === "sh"), "shell still rendered");
});

// ── board tiles (Excalidraw) ────────────────────────────────────────────────

test("an UNSAVED board (no boardFile) renders even without a repo — it's in-memory", () => {
  const nodes = buildBaseNodes(ctx({
    repoPath: null, root: null,
    tiles: [tile({ id: "bd", kind: "board", label: "Board #1" })],
  }));
  const bd = nodes.find((n) => n.id === "bd");
  assert.ok(bd, "unsaved board renders with no repo (like a scratch note)");
  assert.equal(bd!.type, "board");
  const data = bd!.data as Record<string, unknown>;
  assert.equal(data.boardFile, undefined, "unsaved board carries no boardFile");
});

test("a BOUND board (has boardFile) is repo-gated: skipped without a repo, carries its path with one", () => {
  // No repo → the bound board can't resolve its path, so it's skipped.
  const skipped = buildBaseNodes(ctx({
    repoPath: null, root: null,
    tiles: [tile({ id: "bd", kind: "board", label: "sketch", boardFile: ".hivemind/boards/sketch.excalidraw" })],
  }));
  assert.equal(skipped.find((n) => n.id === "bd"), undefined, "bound board skipped without a repo");

  // With a repo → renders, carries repoPath + boardFile through to the tile data.
  const nodes = buildBaseNodes(ctx({
    tiles: [tile({ id: "bd", kind: "board", label: "sketch", boardFile: ".hivemind/boards/sketch.excalidraw" })],
    positions: { bd: { x: 0, y: 0 } },
  }));
  const data = byId(nodes, "bd").data as Record<string, unknown>;
  assert.equal(data.repoPath, "/base/repo");
  assert.equal(data.boardFile, ".hivemind/boards/sketch.excalidraw");
});

// ── N-level nesting (frames within frames) ──────────────────────────────────

test("grandchild tile inherits the enclosing WORKSPACE zone via parent-chain walk-up", () => {
  // ws (workspace zone) → group (plain sub-frame, no binding) → tile.
  const frames = [
    frame({ id: "ws", workspacePath: "/other/proj", workspaceRoot: "/other/proj/.hivemind" }),
    frame({ id: "group", parentFrameId: "ws" }),
  ];
  const nodes = buildBaseNodes(ctx({
    frames,
    tiles: [tile({ id: "sh", kind: "shell" }), tile({ id: "iss", kind: "issues", label: "Issues" })],
    frameOf: { sh: "group", iss: "group" },
    positions: { sh: { x: 0, y: 0 }, iss: { x: 0, y: 0 } },
  }));
  // cwd/root come from the ANCESTOR zone, not the direct (unbound) group frame.
  assert.equal((byId(nodes, "sh").data as Record<string, unknown>).cwd, "/other/proj");
  assert.equal((byId(nodes, "iss").data as Record<string, unknown>).root, "/other/proj/.hivemind");
});

test("grandchild tile inherits the enclosing WORKTREE zone via walk-up (cwd = worktree)", () => {
  // repo → wt (worktree) → group → tile. Terminal must run on the worktree path.
  const frames = [
    frame({ id: "repo" }),
    frame({ id: "wt", worktreePath: "/wt/feature", branch: "feature", parentFrameId: "repo" }),
    frame({ id: "group", parentFrameId: "wt" }),
  ];
  const nodes = buildBaseNodes(ctx({
    frames,
    tiles: [tile({ id: "sh", kind: "shell" })],
    frameOf: { sh: "group" },
    positions: { sh: { x: 0, y: 0 } },
  }));
  assert.equal((byId(nodes, "sh").data as Record<string, unknown>).cwd, "/wt/feature");
});

test("editor in a nested group under a worktree renders (repo resolved by walk-up)", () => {
  // No global repo — the editor must still render because an ANCESTOR frame
  // provides one. Regression guard for the render-gate walk-up.
  const frames = [
    frame({ id: "wt", worktreePath: "/wt/feature", branch: "feature" }),
    frame({ id: "group", parentFrameId: "wt" }),
  ];
  const nodes = buildBaseNodes(ctx({
    repoPath: null, root: null, cwd: "/tmp",
    frames,
    tiles: [tile({ id: "ed", kind: "editor", label: "Editor" })],
    frameOf: { ed: "group" },
    positions: { ed: { x: 0, y: 0 } },
  }));
  assert.ok(nodes.find((n) => n.id === "ed"), "editor renders via the ancestor worktree repo");
  assert.equal((byId(nodes, "ed").data as Record<string, unknown>).repoPath, "/wt/feature");
});

test("3-level frames emit in depth order (grandparent → parent → grandchild)", () => {
  const frames = [
    frame({ id: "GC", x: 40, y: 40, parentFrameId: "P", z: 7 }),
    frame({ id: "GP", x: 0, y: 0, z: 1 }),
    frame({ id: "P", x: 20, y: 20, parentFrameId: "GP", z: 4 }),
  ];
  const nodes = buildBaseNodes(ctx({ frames }));
  const order = nodes.filter((n) => n.type === "frame").map((n) => n.id);
  // Each parent appears before its child (react-flow parentId requirement).
  assert.ok(order.indexOf("GP") < order.indexOf("P"), "GP before P");
  assert.ok(order.indexOf("P") < order.indexOf("GC"), "P before GC");
  // zIndex increases with depth but stays below the tile tier (100).
  const z = (id: string) => (byId(nodes, id).style as { zIndex: number }).zIndex;
  assert.ok(z("GP") < z("P") && z("P") < z("GC") && z("GC") < 100, `${z("GP")} < ${z("P")} < ${z("GC")} < 100`);
  // A grandchild's position is relative to its DIRECT parent.
  assert.deepEqual(byId(nodes, "GC").position, { x: 20, y: 20 }, "GC rel to P (40-20,40-20)");
});
