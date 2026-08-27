/**
 * IssueAgents — the issue→agent half of the bidirectional issue↔terminal link.
 * Lists the running agent tiles associated with THIS issue (with live status),
 * lets you focus one, unlink it, or associate another already-running terminal.
 *
 * Data source: the Canvas publishes a snapshot of agent tiles (id, name, frame,
 * issue link) to `window.__hivemindAgentTiles` and fires
 * `hivemind:agent-tiles-changed` on every change; we read + subscribe. Live
 * status comes from the agent-status bus (same source the tile header dot uses).
 * Mutations reuse the shared `hivemind:link-tile-to-issue` event so both halves
 * of the link go through one Canvas handler.
 */
import { useEffect, useMemo, useState } from "react";
import { Bot, Link2, Unlink, Crosshair, ChevronDown } from "lucide-react";
import { subscribeStatus, type TileStatusKind } from "../agent-status-bus";

/** One agent tile as published by the Canvas snapshot. */
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

/** Color + label for a live tile status (mirrors the terminal header dot). */
function statusStyle(s: TileStatusKind | undefined): { color: string; label: string } {
  switch (s) {
    case "working": return { color: "var(--color-brand)", label: "working" };
    case "blocked":
    case "permission":
    case "question":
    case "plan_review":
    case "awaiting_approval": return { color: "var(--color-warn)", label: "needs you" };
    case "exited": return { color: "var(--color-err)", label: "exited" };
    case "idle": return { color: "var(--color-ok)", label: "idle" };
    default: return { color: "var(--color-fg3)", label: "—" };
  }
}

export function IssueAgents({ issueId, root }: { issueId: string; root: string | null }) {
  const [snap, setSnap] = useState<AgentTileSnap[]>(() => readSnapshot());
  const [statuses, setStatuses] = useState<Map<string, TileStatusKind>>(() => new Map());
  const [picking, setPicking] = useState(false);

  // Subscribe to the Canvas agent-tile snapshot.
  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<AgentTileSnap[]>).detail;
      setSnap(Array.isArray(d) ? d : readSnapshot());
    };
    window.addEventListener("hivemind:agent-tiles-changed", onChange as EventListener);
    setSnap(readSnapshot());
    return () => window.removeEventListener("hivemind:agent-tiles-changed", onChange as EventListener);
  }, []);

  // Track live per-tile status.
  useEffect(() => {
    return subscribeStatus((e) => {
      setStatuses((m) => {
        if (m.get(e.tileId) === e.status) return m;
        const next = new Map(m);
        next.set(e.tileId, e.status);
        return next;
      });
    });
  }, []);

  const linked = useMemo(() => snap.filter((t) => t.issueId === issueId), [snap, issueId]);
  const available = useMemo(() => snap.filter((t) => t.issueId !== issueId), [snap, issueId]);

  const linkTile = (tileId: string, clear: boolean) => {
    window.dispatchEvent(
      new CustomEvent("hivemind:link-tile-to-issue", {
        detail: clear ? { tileId, clear: true } : { tileId, issueId, root },
      }),
    );
  };
  const focusTile = (tileId: string) => {
    window.dispatchEvent(new CustomEvent("hivemind:focus-tile", { detail: { tileId } }));
  };

  return (
    <div className="space-y-1.5">
      {linked.length === 0 && (
        <p className="text-[11.5px] text-[var(--color-fg3)]">No agents linked yet.</p>
      )}
      {linked.map((t) => {
        const st = statusStyle(statuses.get(t.tileId));
        return (
          <div
            key={t.tileId}
            className="flex items-center gap-2 rounded-md border border-[var(--color-line2)] bg-[var(--color-bg)] px-2 py-1.5"
          >
            <span className="size-2 rounded-full shrink-0" style={{ background: st.color }} title={st.label} aria-hidden />
            <Bot size={13} className="text-[var(--color-fg3)] shrink-0" aria-hidden />
            <span className="text-[12px] text-[var(--color-fg)] truncate">{t.name}</span>
            <span className="text-[10px] text-[var(--color-fg3)] shrink-0">{st.label}</span>
            <div className="ml-auto flex items-center gap-0.5 shrink-0">
              <button
                onClick={() => focusTile(t.tileId)}
                className="size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] cursor-pointer"
                title="Focus this agent on the canvas"
                aria-label="Focus agent"
              >
                <Crosshair size={12} aria-hidden />
              </button>
              <button
                onClick={() => linkTile(t.tileId, true)}
                className="size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-err)] cursor-pointer"
                title="Unlink this agent"
                aria-label="Unlink agent"
              >
                <Unlink size={12} aria-hidden />
              </button>
            </div>
          </div>
        );
      })}

      {/* Associate an already-running terminal with this issue. */}
      <div className="relative">
        <button
          onClick={() => setPicking((v) => !v)}
          disabled={available.length === 0}
          className="w-full inline-flex items-center gap-1.5 h-7 px-2 rounded-md border border-dashed border-[var(--color-line2)] text-[11.5px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:border-[var(--color-brand)]/50 disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
          title={available.length === 0 ? "No other running agents to link" : "Associate a running terminal with this task"}
        >
          <Link2 size={12} aria-hidden />
          Associate a running terminal
          <ChevronDown size={12} className="ml-auto" aria-hidden />
        </button>
        {picking && available.length > 0 && (
          <ul className="absolute z-[60] left-0 right-0 mt-1 max-h-[220px] overflow-y-auto bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-md shadow-xl py-1">
            {available.map((t) => {
              const st = statusStyle(statuses.get(t.tileId));
              return (
                <li key={t.tileId}>
                  <button
                    onClick={() => { linkTile(t.tileId, false); setPicking(false); }}
                    className="w-full flex items-center gap-2 px-2.5 py-1 text-left text-[12px] hover:bg-[var(--color-bg3)] cursor-pointer"
                  >
                    <span className="size-1.5 rounded-full shrink-0" style={{ background: st.color }} aria-hidden />
                    <span className="text-[var(--color-fg)] truncate">{t.name}</span>
                    {t.frameTitle && <span className="ml-auto text-[10px] text-[var(--color-fg3)] shrink-0 truncate">{t.frameTitle}</span>}
                    {t.issueId && <span className="text-[10px] text-[var(--color-warn)] shrink-0">→ {t.issueId}</span>}
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
