// workflow-engine's graph walk — pure, so it's exercised here with fake
// deliverStep/runAction (no real IPC/agents). Mirrors command-runner.test.ts's
// style: plain node:test + assert, no framework.
import { test } from "node:test";
import assert from "node:assert/strict";
import { runWorkflow, type WorkflowDeps, type WorkflowGraph } from "../../src/renderer/src/workflow-engine.ts";
import type { TileInstance, WorkflowEdge } from "../../src/renderer/src/canvas-persistence.ts";

const trigger = (id: string): TileInstance => ({ id, kind: "trigger", label: "Start" });
const agent = (id: string): TileInstance => ({ id, kind: "claude", label: id });
const action = (id: string, script = "echo hi"): TileInstance => ({ id, kind: "cmdButton", label: id, cmdButton: { script } });
const edge = (source: string, target: string, extra: Partial<WorkflowEdge> = {}): WorkflowEdge =>
  ({ id: `${source}->${target}`, source, target, ...extra });

test("linear chain: trigger → agent1 → agent2 → cmdButton, in order", async () => {
  const calls: string[] = [];
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), agent("a1"), agent("a2"), action("btn")],
    edges: [
      edge("t", "a1", { prompt: "do X" }),
      edge("a1", "a2", { prompt: "integrate", includePrevReply: true }),
      edge("a2", "btn"),
    ],
  };
  const deps: WorkflowDeps = {
    deliverStep: async (tileId, message) => { calls.push(`deliver:${tileId}:${message}`); return { text: `${tileId} done` }; },
    runAction: async (tileId) => { calls.push(`action:${tileId}`); return { ok: true }; },
  };
  const res = await runWorkflow("t", graph, deps);
  assert.deepEqual(res, { status: "done" });
  assert.deepEqual(calls, [
    "deliver:a1:do X",
    "deliver:a2:a1 done\n\nintegrate", // includePrevReply prefixes the prior step's reply
    "action:btn",
  ]);
});

test("includePrevReply:false does not prefix the prior reply", async () => {
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), agent("a1"), agent("a2")],
    edges: [edge("t", "a1", { prompt: "first" }), edge("a1", "a2", { prompt: "second", includePrevReply: false })],
  };
  let secondMessage = "";
  const deps: WorkflowDeps = {
    deliverStep: async (tileId, message) => {
      if (tileId === "a2") secondMessage = message;
      return { text: `${tileId} reply` };
    },
    runAction: async () => ({ ok: true }),
  };
  await runWorkflow("t", graph, deps);
  assert.equal(secondMessage, "second");
});

test("fan-out: one finished step fires all outgoing edges concurrently", async () => {
  const started: string[] = [];
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), agent("a1"), agent("b"), agent("c")],
    edges: [edge("t", "a1", { prompt: "go" }), edge("a1", "b", { prompt: "x" }), edge("a1", "c", { prompt: "y" })],
  };
  const deps: WorkflowDeps = {
    deliverStep: async (tileId) => { started.push(tileId); return { text: "ok" }; },
    runAction: async () => ({ ok: true }),
  };
  const res = await runWorkflow("t", graph, deps);
  assert.deepEqual(res, { status: "done" });
  assert.deepEqual(started.sort(), ["a1", "b", "c"]);
});

test("missing tile (closed mid-graph) → clear terminal error, no throw", async () => {
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), agent("a1")],
    // edge points at a tile id that no longer exists in `tiles`.
    edges: [edge("t", "a1", { prompt: "go" }), edge("a1", "gone", { prompt: "next" })],
  };
  const deps: WorkflowDeps = {
    deliverStep: async () => ({ text: "ok" }),
    runAction: async () => ({ ok: true }),
  };
  const res = await runWorkflow("t", graph, deps);
  assert.equal(res.status, "error");
  assert.match(res.note ?? "", /gone/);
});

test("a step with no prompt configured ends the run as an error", async () => {
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), agent("a1")],
    edges: [edge("t", "a1")], // no prompt set
  };
  const deps: WorkflowDeps = {
    deliverStep: async () => ({ text: "should not be called" }),
    runAction: async () => ({ ok: true }),
  };
  const res = await runWorkflow("t", graph, deps);
  assert.equal(res.status, "error");
  assert.match(res.note ?? "", /no prompt/);
});

test("deliverStep timeout/rejection ends the run as an error, not a throw", async () => {
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), agent("a1")],
    edges: [edge("t", "a1", { prompt: "go" })],
  };
  const deps: WorkflowDeps = {
    deliverStep: async () => { throw new Error("timed out waiting for a reply"); },
    runAction: async () => ({ ok: true }),
  };
  const res = await runWorkflow("t", graph, deps);
  assert.deepEqual(res, { status: "error", note: "timed out waiting for a reply" });
});

test("an action step (cmdButton) with no script configured fails cleanly", async () => {
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), { id: "btn", kind: "cmdButton", label: "btn" }], // cmdButton with no cmdButton.script
    edges: [edge("t", "btn")],
  };
  const deps: WorkflowDeps = {
    deliverStep: async () => ({ text: "n/a" }),
    runAction: async () => ({ ok: true }),
  };
  const res = await runWorkflow("t", graph, deps);
  assert.equal(res.status, "error");
  assert.match(res.note ?? "", /no script configured/);
});

test("onProgress reports each visited node and clears at the end", async () => {
  const progress: Array<{ activeNodeId: string | null }> = [];
  const graph: WorkflowGraph = {
    tiles: [trigger("t"), agent("a1"), action("btn")],
    edges: [edge("t", "a1", { prompt: "go" }), edge("a1", "btn")],
  };
  const deps: WorkflowDeps = {
    deliverStep: async () => ({ text: "ok" }),
    runAction: async () => ({ ok: true }),
    onProgress: (p) => progress.push({ activeNodeId: p.activeNodeId }),
  };
  await runWorkflow("t", graph, deps);
  assert.deepEqual(progress.map((p) => p.activeNodeId), ["a1", "btn", null]);
});

test("a trigger with no outgoing edges is a trivially successful no-op run", async () => {
  const graph: WorkflowGraph = { tiles: [trigger("t")], edges: [] };
  const deps: WorkflowDeps = { deliverStep: async () => ({ text: null }), runAction: async () => ({ ok: true }) };
  const res = await runWorkflow("t", graph, deps);
  assert.deepEqual(res, { status: "done" });
});
