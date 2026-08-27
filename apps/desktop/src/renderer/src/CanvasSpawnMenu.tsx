/**
 * CanvasSpawnMenu — the right-click "spawn a component" menu for empty canvas
 * space. Opened from Canvas's pane onContextMenu with the click coords and the
 * frame the click landed in (if any). Picking an item spawns that component; a
 * `frameId` means it's born associated with that frame, otherwise it routes
 * through the global spawn path (selection → picker → base frame).
 *
 * Mirrors FrameRailMenu's conventions: rendered via createPortal to <body>,
 * fixed-positioned at the click point (clamped to the viewport), with a
 * full-screen click-away catcher that also closes on a nested right-click.
 */
import { createPortal } from "react-dom";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { FilePlus2, SquareTerminal, Zap } from "lucide-react";
import { OPEN_KINDS } from "./spawn-icons";
import { AGENTS, AgentIcon } from "./agents";

export interface CanvasSpawnMenuState {
  /** Client (screen) coords where the menu opens. */
  x: number;
  y: number;
  /** The frame the right-click landed in, or null for bare canvas. */
  frameId: string | null;
  /** A human label for the target (frame title / "canvas") for the header. */
  targetLabel: string;
}

interface Props {
  menu: CanvasSpawnMenuState;
  onClose: () => void;
  /** Open a registry agent (claude/codex/…) — id from AGENTS. */
  onSpawnAgent: (agentId: string, frameId: string | null) => void;
  /** Open a non-agent "open kind" (shell/tree/diff/issues/browser). */
  onSpawnKind: (kind: string, frameId: string | null) => void;
  /** Open the single-file picker (spawns a file tile on pick). */
  onSpawnFile: (frameId: string | null) => void;
  /** Create a command-button tile (opens its config modal). */
  onSpawnCommand: (frameId: string | null) => void;
  /** Create a trigger tile — the start of a workflow (opens its config modal). */
  onSpawnTrigger: (frameId: string | null) => void;
}

function Section({ label }: { label: string }) {
  return (
    <div className="px-2.5 pt-2 pb-1 text-[10px] uppercase tracking-wider text-[var(--color-fg3)] font-semibold select-none">
      {label}
    </div>
  );
}

function Item({ icon, label, onClick }: { icon: ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className="w-full text-left flex items-center gap-2.5 px-2.5 py-1.5 text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg4)] transition-colors cursor-pointer rounded-[5px]"
    >
      <span aria-hidden className="grid place-items-center size-4 shrink-0 text-[var(--color-fg2)]">{icon}</span>
      <span className="flex-1 min-w-0 truncate">{label}</span>
    </button>
  );
}

export function CanvasSpawnMenu({ menu, onClose, onSpawnAgent, onSpawnKind, onSpawnFile, onSpawnCommand, onSpawnTrigger }: Props) {
  const ref = useRef<HTMLDivElement | null>(null);
  const [pos, setPos] = useState({ x: menu.x, y: menu.y });

  // Clamp the menu inside the viewport once it's measured (so a right-click near
  // the bottom/right edge doesn't overflow off-screen).
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const pad = 8;
    const x = Math.min(menu.x, window.innerWidth - r.width - pad);
    const y = Math.min(menu.y, window.innerHeight - r.height - pad);
    setPos({ x: Math.max(pad, x), y: Math.max(pad, y) });
  }, [menu.x, menu.y]);

  // Esc closes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fid = menu.frameId;
  const pick = (fn: () => void) => () => { fn(); onClose(); };
  const agents = AGENTS.filter((a) => a.enabled);

  return createPortal(
    <>
      {/* Click-away / right-click-away catcher. */}
      <div
        className="fixed inset-0 z-[9998]"
        onClick={onClose}
        onContextMenu={(e) => { e.preventDefault(); onClose(); }}
      />
      <div
        ref={ref}
        className="fixed z-[9999] w-[220px] max-h-[70vh] overflow-y-auto py-1 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-lg shadow-2xl"
        style={{ left: pos.x, top: pos.y }}
        onContextMenu={(e) => e.preventDefault()}
      >
        <div className="px-2.5 pt-1.5 pb-1 text-[11px] text-[var(--color-fg2)] truncate select-none" title={menu.targetLabel}>
          Add to <span className="text-[var(--color-fg)] font-medium">{menu.targetLabel}</span>
        </div>

        <Section label="Agent" />
        {agents.map((a) => (
          <Item
            key={a.id}
            icon={<AgentIcon id={a.id} size={14} />}
            label={a.label}
            onClick={pick(() => onSpawnAgent(a.id, fid))}
          />
        ))}

        <Section label="Tool" />
        {OPEN_KINDS.map((o) => {
          const Icon = o.icon;
          return (
            <Item
              key={o.kind}
              icon={<Icon size={14} />}
              label={o.label}
              onClick={pick(() => onSpawnKind(o.kind, fid))}
            />
          );
        })}
        <Item
          icon={<FilePlus2 size={14} />}
          label="File…"
          onClick={pick(() => onSpawnFile(fid))}
        />
        <Item
          icon={<SquareTerminal size={14} />}
          label="Command button"
          onClick={pick(() => onSpawnCommand(fid))}
        />
        <Item
          icon={<Zap size={14} />}
          label="Trigger"
          onClick={pick(() => onSpawnTrigger(fid))}
        />
      </div>
    </>,
    document.body,
  );
}
