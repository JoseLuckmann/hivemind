/**
 * useIssueAgentSignal — collapses the live status of every agent tile LINKED to
 * an issue into a single, discrete board signal, so an issue card can show
 * at-a-glance whether an agent bound to it needs you, is working, or finished a
 * turn you haven't looked at yet.
 *
 * Data sources (both already used by IssueAgents):
 *   • `window.__hivemindAgentTiles` snapshot (+ `hivemind:agent-tiles-changed`)
 *     — the tileId→issueId map the Canvas publishes.
 *   • the agent-status bus (`subscribeStatus`) — the same per-tile status that
 *     drives the terminal header dot and the Layers rail.
 *
 * The signal priority mirrors what the user asked for, loudest first:
 *   1. "needs"      — a linked agent is blocked / needs a human. Card pulses warn.
 *   2. "working"    — a linked agent is actively working. A quiet animated dot.
 *   3. "done-unseen"— a linked agent finished a turn (working→idle / clean exit)
 *                     and the user hasn't looked yet. Static lavender border.
 *   4. null         — nothing noteworthy (idle+seen, or no linked agents).
 *
 * "Seen" is tracked per ISSUE in a module-level store (survives card unmount /
 * board regroup). markIssueSeen() clears the done-unseen state — call it when the
 * user opens the issue peek or focuses one of its agents. A NEW working→idle
 * edge re-arms done-unseen even after a prior seen.
 */
import { useEffect, useState } from "react";
import { subscribeStatus, statusOf, type TileStatusKind } from "../agent-status-bus";

export type IssueAgentSignal = "needs" | "working" | "done-unseen" | null;

interface AgentTileSnap {
  tileId: string;
  name: string;
  frameId: string | null;
  frameTitle: string | null;
  issueId: string | null;
  issueRoot: string | null;
}

function readSnapshot(): AgentTileSnap[] {
  const w = window as unknown as { __hivemindAgentTiles?: AgentTileSnap[] };
  return Array.isArray(w.__hivemindAgentTiles) ? w.__hivemindAgentTiles : [];
}

const NEEDS_YOU = (s: TileStatusKind | null | undefined): boolean =>
  s === "blocked" || s === "permission" || s === "question" || s === "plan_review" || s === "awaiting_approval";

// ── done-unseen store (per issue) ────────────────────────────────────
// A set of issue ids that currently have a FINISHED-but-unseen agent turn. We
// track it centrally (not per-card) so the flag persists across the board's
// frequent re-groups/re-renders and so markIssueSeen from the peek reaches it.
const doneUnseen = new Set<string>();
const seenListeners = new Set<() => void>();
// Remember the last status we saw per (issue, tile) so we can detect the
// working→idle EDGE (a completion) rather than a resting idle.
const lastStatus = new Map<string, TileStatusKind>();

function emitSeenChange() {
  for (const l of seenListeners) l();
}

/** Clear an issue's done-unseen flag — the user has looked at its result. */
export function markIssueSeen(issueId: string): void {
  if (doneUnseen.delete(issueId)) emitSeenChange();
}

// A single global subscription to the status bus feeds the done-unseen store,
// independent of how many cards are mounted. Started lazily on first hook use.
let busStarted = false;
function ensureBus() {
  if (busStarted) return;
  busStarted = true;
  subscribeStatus((e) => {
    // Map this tile to its issue via the live snapshot.
    const snap = readSnapshot();
    const tile = snap.find((t) => t.tileId === e.tileId);
    const issueId = tile?.issueId ?? null;
    const key = `${e.tileId}`;
    const prev = lastStatus.get(key);
    lastStatus.set(key, e.status);
    if (!issueId) return;
    // A completion edge: an agent that WAS working just went idle (a real finish,
    // not a synthetic staleness correction) or exited cleanly. Re-arms unseen.
    const finished =
      (e.status === "idle" && prev === "working" && !e.synthetic) ||
      (e.status === "exited" && prev === "working" && (e.exitCode === undefined || e.exitCode === 0));
    if (finished) {
      if (!doneUnseen.has(issueId)) { doneUnseen.add(issueId); emitSeenChange(); }
    }
  });
}

/**
 * The current signal for one issue's linked agents. Re-renders the caller only
 * when the derived signal changes (not on every status tick).
 */
export function useIssueAgentSignal(issueId: string): IssueAgentSignal {
  const [signal, setSignal] = useState<IssueAgentSignal>(null);

  useEffect(() => {
    ensureBus();
    let snap = readSnapshot();

    const compute = (): IssueAgentSignal => {
      const linked = snap.filter((t) => t.issueId === issueId);
      if (linked.length === 0) return null;
      const statuses = linked.map((t) => statusOf(t.tileId));
      if (statuses.some((s) => NEEDS_YOU(s))) return "needs";
      if (statuses.some((s) => s === "working")) return "working";
      if (doneUnseen.has(issueId)) return "done-unseen";
      return null;
    };

    const update = () => setSignal((prev) => {
      const next = compute();
      return prev === next ? prev : next;
    });

    const onTiles = () => { snap = readSnapshot(); update(); };
    window.addEventListener("hivemind:agent-tiles-changed", onTiles as EventListener);
    const offStatus = subscribeStatus(() => update());
    const offSeen = (() => { seenListeners.add(update); return () => seenListeners.delete(update); })();
    update();

    return () => {
      window.removeEventListener("hivemind:agent-tiles-changed", onTiles as EventListener);
      offStatus();
      offSeen();
    };
  }, [issueId]);

  return signal;
}
