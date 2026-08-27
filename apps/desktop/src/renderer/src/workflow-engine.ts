/**
 * workflow-engine — the pure graph-walk for a canvas workflow. Given a
 * trigger tile id + the persisted graph (workflowEdges + tiles), it delivers
 * each step's prompt to the REAL, already-running tile (workflow nodes ARE
 * tiles — the engine only SENDS a message into an agent; it never spawns a
 * terminal or an agent) and awaits completion via the injected
 * `deliverStep`/`runAction`, which Canvas.tsx wires to the real
 * `hcpInvoke("agent.send"/"agent.read")` and `cmdRun`/`onCmdState` primitives
 * (see docs/canvas-workflows.md). No React/Electron imports here — the walk
 * itself is unit-testable with fake deps (see workflow-engine.test.ts).
 *
 * v1 scope: linear chains + free fan-out (a finished step fires ALL of its
 * outgoing edges concurrently), no conditionals. A node with no incoming edge
 * from the trigger's reachable set is simply never visited.
 */
import type { TileInstance, WorkflowEdge } from "./canvas-persistence";

export type StepStatus = "idle" | "running" | "done" | "error";
export interface TriggerRunState {
  status: StepStatus;
  note?: string;
}

export interface WorkflowGraph {
  edges: WorkflowEdge[];
  tiles: TileInstance[];
}

export interface WorkflowProgress {
  triggerId: string;
  activeEdgeId: string | null;
  activeNodeId: string | null;
}

export interface WorkflowDeps {
  /** Deliver a message to an agent tile and await its turn. Resolves with the
   *  clean reply text (or null if the agent gave none) once the turn
   *  completes; throws (a clear message) on timeout, a missing tile, or any
   *  other delivery failure — the engine treats that as a run-ending error. */
  deliverStep(tileId: string, message: string): Promise<{ text: string | null }>;
  /** Run a command-button tile's saved script and resolve once it reaches a
   *  terminal state. `ok:false` (with `note`) ends the run as an error. */
  runAction(tileId: string): Promise<{ ok: boolean; note?: string }>;
  /** Fired on every node visit (and once more at the end, with both ids
   *  null) so the UI can highlight the live edge/node. Best-effort — engine
   *  correctness never depends on it being called. */
  onProgress?: (p: WorkflowProgress) => void;
}

/** Walk the graph from `triggerId`, firing every reachable step in order
 *  (fan-out runs concurrently), and return the run's terminal state. Never
 *  throws — any failure surfaces as `{status:"error", note}`. */
export async function runWorkflow(
  triggerId: string,
  graph: WorkflowGraph,
  deps: WorkflowDeps,
): Promise<TriggerRunState> {
  const tileById = new Map(graph.tiles.map((t) => [t.id, t]));
  const outgoing = (nodeId: string) => graph.edges.filter((e) => e.source === nodeId);
  const edgeById = new Map(graph.edges.map((e) => [e.id, e]));

  // First error wins — with concurrent fan-out, later rejections racing in
  // are noise once the run is already going to report a failure.
  let firstError: string | null = null;
  const fail = (msg: string) => { if (!firstError) firstError = msg; };

  async function runNode(nodeId: string, incomingReply: string | null, viaEdgeId: string): Promise<void> {
    if (firstError) return; // a sibling branch already failed — stop spreading further
    const tile = tileById.get(nodeId);
    deps.onProgress?.({ triggerId, activeEdgeId: viaEdgeId, activeNodeId: nodeId });
    if (!tile) { fail(`step failed: tile ${nodeId} no longer exists`); return; }

    if (tile.kind === "cmdButton") {
      if (!tile.cmdButton?.script?.trim()) { fail(`action step "${tile.label}" has no script configured`); return; }
      let res: { ok: boolean; note?: string };
      try { res = await deps.runAction(nodeId); }
      catch (e) { fail((e as Error).message ?? String(e)); return; }
      if (!res.ok) { fail(res.note ?? `action step "${tile.label}" failed`); return; }
      await fanOut(nodeId, null);
      return;
    }

    const edge = edgeById.get(viaEdgeId);
    const prompt = (edge?.prompt ?? "").trim();
    if (!prompt) { fail(`step "${tile.label}" has no prompt configured`); return; }
    const message = edge?.includePrevReply && incomingReply ? `${incomingReply}\n\n${prompt}` : prompt;
    let res: { text: string | null };
    try { res = await deps.deliverStep(nodeId, message); }
    catch (e) { fail((e as Error).message ?? String(e)); return; }
    await fanOut(nodeId, res.text);
  }

  async function fanOut(nodeId: string, reply: string | null): Promise<void> {
    const next = outgoing(nodeId);
    if (next.length === 0 || firstError) return;
    await Promise.all(next.map((e) => runNode(e.target, reply, e.id)));
  }

  await fanOut(triggerId, null);
  deps.onProgress?.({ triggerId, activeEdgeId: null, activeNodeId: null });
  return firstError ? { status: "error", note: firstError } : { status: "done" };
}
