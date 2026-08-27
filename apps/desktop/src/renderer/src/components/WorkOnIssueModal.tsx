/**
 * WorkOnIssueModal — the "▶ Work" launcher. Instead of immediately spawning an
 * agent, clicking Work opens this modal to choose:
 *   • which AGENT runs (claude / codex / kiro / …),
 *   • which FRAME (workspace — a repo or a worktree) it spawns INTO,
 *   • an optional EXTRA PROMPT appended to the task instructions.
 *
 * On submit it fires the enriched `hivemind:work-on-issue` event that Canvas's
 * onWork handler consumes (frameId + agent + extraPrompt). Prefilled from the
 * issue's `preferredFrame` / `preferredAgent` when set.
 *
 * Opened via `hivemind:open-work-modal` {root, id, title, preferredFrame,
 * preferredAgent} (fired by IssuePeek / IssuesTile / cards). Frame list comes
 * from the Canvas snapshot on `window.__hivemindFrames`.
 */
import { useEffect, useMemo, useState } from "react";
import { Play, X } from "lucide-react";
import { AGENTS } from "../agents";

interface FrameSnap {
  id: string;
  title: string;
  branch: string | null;
  repo: string | null;
  isWorktree: boolean;
}

/** Payload carried by `hivemind:open-work-modal`. */
export interface WorkModalReq {
  root: string | null;
  id: string;
  title?: string;
  preferredFrame?: string;
  preferredAgent?: string;
}

function readFrames(): FrameSnap[] {
  const w = window as unknown as { __hivemindFrames?: FrameSnap[] };
  return Array.isArray(w.__hivemindFrames) ? w.__hivemindFrames : [];
}

export function WorkOnIssueModal({
  req,
  open,
  onOpenChange,
}: {
  req: WorkModalReq | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const [frames, setFrames] = useState<FrameSnap[]>(() => readFrames());
  const [agent, setAgent] = useState("claude");
  const [frameId, setFrameId] = useState<string>("");
  const [extra, setExtra] = useState("");

  useEffect(() => {
    const onChange = (e: Event) => {
      const d = (e as CustomEvent<FrameSnap[]>).detail;
      setFrames(Array.isArray(d) ? d : readFrames());
    };
    window.addEventListener("hivemind:frames-changed", onChange as EventListener);
    setFrames(readFrames());
    return () => window.removeEventListener("hivemind:frames-changed", onChange as EventListener);
  }, []);

  // Seed the pickers from the issue's preferences each time the modal opens.
  useEffect(() => {
    if (!open || !req) return;
    setAgent(req.preferredAgent && AGENTS.some((a) => a.id === req.preferredAgent) ? req.preferredAgent : "claude");
    const fs = readFrames();
    const pref = req.preferredFrame && fs.some((f) => f.id === req.preferredFrame) ? req.preferredFrame : "";
    // Default to the preferred frame, else the first frame, else "" (Canvas
    // falls back to the issue's own workspace frame / a fresh frame).
    setFrameId(pref || fs[0]?.id || "");
    setExtra("");
  }, [open, req]);

  const enabledAgents = useMemo(() => AGENTS.filter((a) => a.enabled), []);

  if (!open || !req) return null;

  const submit = () => {
    window.dispatchEvent(
      new CustomEvent("hivemind:work-on-issue", {
        detail: {
          root: req.root,
          id: req.id,
          title: req.title,
          agent,
          frameId: frameId || undefined,
          extraPrompt: extra.trim() || undefined,
        },
      }),
    );
    onOpenChange(false);
  };

  const inputCls =
    "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 text-[13px] text-[var(--color-fg)] outline-none focus:border-[var(--color-brand)]";

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[460px] max-w-[92vw] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Play size={14} className="text-[var(--color-brand)]" fill="currentColor" strokeWidth={0} aria-hidden />
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Work on {req.id}</h2>
          <button
            onClick={() => onOpenChange(false)}
            className="ml-auto size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>
        {req.title && <p className="mt-1 text-[12px] text-[var(--color-fg3)] truncate">{req.title}</p>}

        <div className="mt-3 grid gap-3">
          <div className="grid gap-1.5">
            <span className="u-eyebrow">Agent</span>
            <select value={agent} onChange={(e) => setAgent(e.target.value)} className={inputCls} aria-label="Agent">
              {enabledAgents.map((a) => (
                <option key={a.id} value={a.id}>{a.label}</option>
              ))}
            </select>
          </div>

          <div className="grid gap-1.5">
            <span className="u-eyebrow">Workspace (frame)</span>
            {frames.length > 0 ? (
              <select value={frameId} onChange={(e) => setFrameId(e.target.value)} className={inputCls} aria-label="Frame">
                {frames.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.title}
                    {f.repo ? ` · ${f.repo}` : ""}
                    {f.branch ? ` (${f.branch})` : ""}
                    {f.isWorktree ? " — worktree" : ""}
                  </option>
                ))}
              </select>
            ) : (
              <p className="text-[11.5px] text-[var(--color-fg3)]">
                No frames yet — the agent spawns into the task's workspace (a frame is created if needed).
              </p>
            )}
          </div>

          <div className="grid gap-1.5">
            <span className="u-eyebrow">Extra prompt (optional)</span>
            <textarea
              value={extra}
              onChange={(e) => setExtra(e.target.value)}
              placeholder="Anything to tell the agent on top of the task reference…"
              rows={3}
              className={`${inputCls} resize-y`}
              aria-label="Extra prompt"
            />
          </div>
        </div>

        <div className="mt-4 flex items-center justify-end gap-2">
          <button
            onClick={() => onOpenChange(false)}
            className="px-3 py-1.5 text-[12px] font-medium text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded-md hover:bg-[var(--color-bg3)]"
          >
            Cancel
          </button>
          <button
            onClick={submit}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 text-[12px] font-semibold text-white bg-[var(--color-brand)] rounded-md hover:opacity-90 cursor-pointer"
          >
            <Play size={11} fill="currentColor" strokeWidth={0} aria-hidden />
            Start agent
          </button>
        </div>
      </div>
    </div>
  );
}
