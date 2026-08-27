# Canvas Workflows — visual, user-authored multi-agent chains

> Status: shipped (v1). Companion to [`hcp-workflows.md`](./hcp-workflows.md),
> which covers the **agent-driven** orchestration primitive (`hive_workflow`,
> called by an agent from inside a session). This doc covers the
> **user-drawn** counterpart: wiring a chain directly on the canvas by
> connecting agent/action tiles you already spawned. (The workflow only sends
> a message into a running agent — it never spawns a terminal or an agent; the
> tiles work standalone exactly as before.)

## Goal

Let the user turn the canvas itself into a small workflow: spawn two agents
(each in its own repo/frame, as usual), drop a trigger, drag a connection
from the trigger to agent 1 (typing its prompt when the connection is made),
drag from agent 1 to agent 2 (its own prompt, optionally primed with agent
1's reply), and drag from agent 2 to a command-button tile that runs a
script (e.g. a deploy). Firing the trigger — by hand or on a schedule — runs
the chain end to end, with the app deterministically waiting for each agent's
turn to finish before advancing (not screen-scraping).

This is explicitly **not** a separate workflow-builder screen. Nodes in the
graph are the same tiles the user already interacts with directly; the
trigger and the connections are a layer on top of the existing canvas, so
spawning/renaming/closing tiles, frames, worktrees, etc. all keep working
exactly as before.

## Data model

- **`trigger` — a new `TileKind`** (`tile-kinds.ts`), spawned/configured like
  the existing `cmdButton` tile. Its config
  (`TileInstance.trigger: { mode: "manual" | "schedule"; everyMs?: number }`)
  lives in `canvas-persistence.ts`, additive and optional — no schema
  version bump needed (same pattern `cmdButton` used).
- **`WorkflowEdge`** (`canvas-persistence.ts`) — a *persisted*, user-drawn
  edge: `{ id, source, target, prompt?, includePrevReply? }`. `source`/
  `target` are **tile ids** — the same ids already on the canvas. A workflow
  node is never a template that gets respawned on each run; it's whichever
  real tile the edge points at. This is deliberately different from the
  *ephemeral* `dataflow`/`spawn` edges in `canvas-pipe-edge.tsx` (computed
  from live HCP pipe/parentage state, never persisted, never user-drawn).
  `PersistedLayout.workflowEdges` rides along with the rest of the layout.

## Connect UX

Workflow nodes are connectable via real `@xyflow/react` `<Handle>`s — the
first use of `Handle` in this codebase (every other edge type is a
*floating* edge computed from node geometry; see `canvas-pipe-edge.tsx`'s
`nodeIntersection`). Handles are gated by node kind:

| Node | Target handle | Source handle |
|---|---|---|
| `trigger` | — | ✓ |
| agent (`terminal` node, `identifyAgent(cmd) != null`) | ✓ | ✓ |
| `cmdButton` | ✓ | — |

A plain shell has **no** handles — it has no "turn" concept for
`agent.send`/`agent.read` to await, so it can't be a workflow step.

Completing a connect-drag (`onConnect` on `<ReactFlow>`, wired in
`Canvas.tsx`) creates a `WorkflowEdge` and opens `EdgePromptPopover` — a
small screen-anchored popover (positioned from the two nodes' flow
positions converted to screen coordinates by hand, since `Canvas` is not
wrapped in a `ReactFlowProvider` — see the `onCanvasContextMenu` comment for
the same client↔flow conversion done in the other direction). An edge into a
`cmdButton` is *promptless* (reaching that step just runs its script); an
edge whose source is an agent gets an "include previous step's reply as
context" checkbox, **default on** — this is v1's answer to cross-agent
"memory sharing": the delivered message becomes
`previousReply + "\n\n" + prompt` when enabled. Double-clicking an existing
workflow edge reopens the popover to edit it.

`canvas-workflow-edge.tsx`'s `WorkflowEdgeComponent` renders the edge:
quiet/static normally, a red "no prompt" badge if a required prompt is
still empty, and the same animated traveling-dot idiom as the ephemeral
`DataFlowEdge` while that edge is the one the engine is currently executing.

## Execution engine

`workflow-engine.ts`'s `runWorkflow(triggerId, graph, deps)` is a **pure**
graph walk (no React/Electron imports — see `workflow-engine.test.ts`).
Given the trigger id and the persisted `{ tiles, edges }`, it walks
`WorkflowEdge`s reachable from the trigger:

- **agent step** — builds the message (prefixing the previous reply if
  `includePrevReply`), calls the injected `deliverStep(tileId, message)`,
  and on success recurses into that node's outgoing edges.
- **action step** (`cmdButton`) — calls the injected `runAction(tileId)`
  (which runs the saved script and waits for a terminal state), then
  recurses the same way.
- **fan-out, for free** — a node with *multiple* outgoing edges fires all of
  them concurrently (`Promise.all`). This is not a conditional — every
  outgoing edge always fires — but it means "one step kicks off two things"
  needs zero extra engine code. True conditionals (an edge gated on a
  keyword/regex match against the reply, or an exit code) are a natural,
  **not yet built** extension: add `WorkflowEdge.condition` and check it in
  `fanOut` before recursing.
- Any failure (missing tile, empty required prompt, a thrown
  `deliverStep`/`runAction`) ends the run as `{status:"error", note}` —
  first error wins under concurrent fan-out. Never throws.

`Canvas.tsx` wires the **real** `deliverStep`/`runAction`:

- `deliverStep` — sends the step's prompt INTO the (already-running) agent
  tile with `hcpInvoke("agent.send", {tileId, text})`, then awaits its turn
  with `hcpInvoke("agent.read", {tileId, timeoutMs})`. **It only sends a
  message — it never spawns a terminal or an agent.** The user opens/spawns
  the agent tiles the normal way (they work standalone, exactly as before);
  the workflow just delivers into them. A cheap `hcpInvoke("agent.alive",…)`
  probe first turns "the agent tile isn't running" into a clear step error
  instead of a bare `TILE_NOT_FOUND`. `agent.send`/`agent.read` are the
  **same** pair HCP already exposes to `mcp__hive__*` tools — Mailbox-safe
  delivery (holds the message if the tile is mid-turn, e.g. still booting, and
  types it in once the agent is back at its prompt) and a deterministic,
  hook-driven turn-completion signal (`TurnTracker.waitForTurn`, driven by
  claude/droid's Stop hook — **not** screen-scraping). See
  `docs/agent-status-signals.md` for the hook mechanics.
- `runAction` — `window.hive.cmdRun(tileId, script, cwd)`, then resolves on
  the next `done`/`error` from `onCmdState` (the exact primitive
  `CommandButtonTile` itself uses).

### The `hcp:invoke` bridge

Before this feature, HCP's `dispatch(method, params)` — the function behind
every `agent.send`/`agent.read`/`tile.connect`/… verb — was reachable only
from the external unix-socket MCP server (i.e. an agent calling
`mcp__hive__*`). The workflow engine runs in the **renderer**, so it needed
a way to call the same `dispatch` directly. The fix was a ~10-line generic
bridge, not new orchestration logic:

```
renderer: window.hive.hcpInvoke(method, params)
  → preload: ipcRenderer.invoke("hcp:invoke", method, params)
  → main:    ipcMain.handle("hcp:invoke", (_, method, params) => hcpDispatch(method, params))
```

`hcpDispatch` is hoisted at module scope in `main/index.ts` (same pattern as
the pre-existing `hcpForgetTile`) and assigned inside `startHcpControlPlane`.
Every existing verb — including ones nothing here uses yet, like
`workflow.run` — becomes reachable from the renderer for free.

## Scheduling

v1 schedule mode is a **fixed interval** ("every N minutes/hours"), not a
cron expression — deliberately simple for a first cut (see
`TriggerConfigModal.tsx`). `workflow-scheduler.ts`'s `WorkflowScheduler` is a
`setInterval`-per-trigger timer with an injectable clock, mirroring
`main/hcp/subagent-reaper.ts`'s `SubagentReaper` conventions (idempotent
arm/cancel, keyed by id) but recurring instead of one-shot. It lives in the
**renderer**, not main — the trigger graph and schedule config are
renderer/localStorage state (`canvas-persistence.ts`); main has no
visibility into it. A `useEffect` in `Canvas.tsx` (re)arms every
`schedule`-mode trigger tile on tile-list change and cancels timers for
triggers that no longer exist. Manual mode is never armed; "Run now" always
works regardless of mode (a manual override on top of the schedule, not
instead of it).

## v1 limitations (by design, not oversights)

- **Linear chains + free fan-out only** — no conditional branching. The data
  model doesn't preclude it (see "fan-out, for free" above); the UI/engine
  just don't evaluate any condition yet.
- **Hook-backed agents only.** `TurnTracker.waitForTurn` is driven by
  claude's (and droid's) Stop hook. An agent CLI without hook support will
  never resolve a turn deterministically — a workflow step into one times
  out. Not solved in v1; a documented gap (would need the renderer's
  `agent-status-bus` idle-transition as a best-effort fallback for hookless
  providers).
- **Interval scheduling, not cron.**
- **No respawn-on-run.** A workflow step always targets the tile that
  already exists; if it's been closed, that run fails with a clear error
  (surfaced on the trigger tile) rather than silently spawning a
  replacement.
- **No retries.**
- **Manual e2e verification only** for the connect-drag gesture itself. It
  was verified end-to-end (spawn → connect → prompt popover → run → action
  completes) via a scripted Electron session, but no automated Playwright
  spec exercises the Handle drag-and-drop: `page.mouse`-based simulation of
  a 10px `<Handle>` connect-drag proved unreliable in this repo's
  Electron+Xvfb CI-style environment (the gesture works — verified via raw
  DOM event dispatch — but OS-level mouse simulation of it does not
  reliably reach react-flow's connection state machine). This mirrors the
  codebase's existing tolerance for drag-related e2e flakiness (see
  `apps/desktop/AGENTS.md`'s "Gotchas": tile-drag e2e tests already probe
  via `elementFromPoint`, and the pre-release checklist already carries a
  "known resize flake"). `workflow-engine.test.ts` and
  `workflow-scheduler.test.ts` cover the actual logic; a reliable
  drag-connect e2e spec is a follow-up, not a blocker.

## Future

- **Conditionals** — `WorkflowEdge.condition` (keyword/regex on the prior
  reply, or an action step's exit code) gating whether `fanOut` recurses
  into that edge.
- **Event triggers** — a third `trigger` mode beyond manual/schedule (e.g. a
  git push, an issue state change).
- **Real cross-agent memory sharing** beyond reply-prefixing — a
  workflow-scoped scratch file both agents can read/write, or literally
  resuming agent B inside agent A's session.
- **Non-hook-backed agent support** for workflow steps (see limitations).

## Files this touches

| File | Role |
|---|---|
| `apps/desktop/src/renderer/src/workflow-engine.ts` | pure graph-walk engine |
| `apps/desktop/src/renderer/src/workflow-scheduler.ts` | schedule-mode recurring timer |
| `apps/desktop/src/renderer/src/canvas-workflow-edge.tsx` | the `workflow` edge type |
| `apps/desktop/src/renderer/src/TriggerTile.tsx` + `components/TriggerConfigModal.tsx` | the trigger tile + its config modal |
| `apps/desktop/src/renderer/src/components/EdgePromptPopover.tsx` | the per-edge prompt popover |
| `apps/desktop/src/renderer/src/canvas-persistence.ts` | `TileInstance.trigger`, `WorkflowEdge`, `PersistedLayout.workflowEdges` |
| `apps/desktop/src/renderer/src/canvas-node-build.ts`, `canvas-nodes.tsx` | trigger node build/render + `<Handle>`s on trigger/terminal/cmdButton |
| `apps/desktop/src/renderer/src/Canvas.tsx` | connect/popover/engine/scheduler wiring, `edges` memo extension |
| `apps/desktop/src/shared/ipc.ts`, `src/preload/index.ts`, `src/main/index.ts` | the `hcp:invoke` bridge |
