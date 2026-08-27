/**
 * EdgePromptPopover — the small popover that opens right after a workflow
 * connect-drag (or on double-clicking an existing workflow edge) to set the
 * prompt that step delivers. Anchored near the edge's midpoint (a screen
 * point Canvas computes from the two nodes' positions — edges have no stable
 * DOM element to anchor a ref to, unlike FrameNode's AnchoredMenu). Portaled
 * to <body>, clamped to the viewport, closes on Escape/click-away.
 */
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

export interface EdgePromptValue {
  prompt: string;
  includePrevReply: boolean;
}

interface Props {
  /** Screen coords to anchor near (the edge's midpoint). */
  x: number;
  y: number;
  initial: EdgePromptValue;
  /** Whether "include previous step's reply" is offered at all — false when
   *  the edge's source is the trigger (no prior step) or its target is a
   *  cmdButton (no prompt concept at all — see `promptless`). */
  showIncludePrevReply: boolean;
  /** True for an edge into a cmdButton — no prompt is needed, the popover
   *  just confirms the connection (Save/Delete only, no textarea). */
  promptless: boolean;
  onSave: (v: EdgePromptValue) => void;
  /** Discard this edge entirely (Cancel on a fresh connect, or an explicit
   *  delete on an existing one). */
  onDelete: () => void;
  onClose: () => void;
}

const inputCls =
  "w-full bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-lg px-2.5 py-2 text-[12.5px] text-[var(--color-fg)] placeholder:text-[var(--color-fg3)] focus:outline-none focus:border-[var(--color-brand)] focus:ring-2 focus:ring-[var(--color-brand)]/30 hm-soft";

export function EdgePromptPopover({ x, y, initial, showIncludePrevReply, promptless, onSave, onDelete, onClose }: Props) {
  const [prompt, setPrompt] = useState(initial.prompt);
  const [includePrevReply, setIncludePrevReply] = useState(initial.includePrevReply);
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x, y });

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const px = Math.min(x - r.width / 2, window.innerWidth - r.width - pad);
    const py = Math.min(y, window.innerHeight - r.height - pad);
    setPos({ x: Math.max(pad, px), y: Math.max(pad, py) });
  }, [x, y]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = () => onSave({ prompt: prompt.trim(), includePrevReply });

  return createPortal(
    <>
      <div className="fixed inset-0 z-[9998]" onClick={onClose} onContextMenu={(e) => { e.preventDefault(); onClose(); }} />
      <div
        ref={ref}
        className="fixed z-[9999] w-[300px] p-3 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg shadow-2xl grid gap-2.5"
        style={{ left: pos.x, top: pos.y }}
        onClick={(e) => e.stopPropagation()}
      >
        {promptless ? (
          <div className="text-[12px] text-[var(--color-fg2)]">
            Reaching this step runs its script — no prompt needed.
          </div>
        ) : (
          <>
            <textarea
              autoFocus
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
              placeholder="What should this step do?"
              rows={4}
              className={`${inputCls} resize-y`}
            />
            {showIncludePrevReply && (
              <label className="flex items-center gap-2 text-[11px] text-[var(--color-fg2)] cursor-pointer">
                <input
                  type="checkbox"
                  checked={includePrevReply}
                  onChange={(e) => setIncludePrevReply(e.target.checked)}
                  className="accent-[var(--color-brand)]"
                />
                Include previous step's reply as context
              </label>
            )}
          </>
        )}
        <div className="flex items-center justify-between gap-2 pt-0.5">
          <button
            onClick={onDelete}
            className="px-2 py-1 text-[11px] text-[var(--color-fg3)] hover:text-[var(--color-err)] rounded hover:bg-[var(--color-bg4)]"
          >
            Delete
          </button>
          <div className="flex gap-1.5">
            <button
              onClick={onClose}
              className="px-2.5 py-1 text-[11px] text-[var(--color-fg2)] hover:text-[var(--color-fg)] rounded hover:bg-[var(--color-bg4)]"
            >
              Cancel
            </button>
            <button
              onClick={save}
              disabled={!promptless && !prompt.trim()}
              className="px-2.5 py-1 text-[11px] font-semibold text-white bg-[var(--color-brand)] rounded hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed"
            >
              Save
            </button>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
