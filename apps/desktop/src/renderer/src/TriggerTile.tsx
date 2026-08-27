/**
 * TriggerTile — the entry point of a canvas workflow. A small control tile:
 * mode badge (manual / schedule), a big "Run now" button (always available,
 * even in schedule mode — a manual override), and the last-run outcome. The
 * actual graph walk lives in workflow-engine.ts; this tile only shows RUN
 * STATE (`run`, streamed down from Canvas's triggerRuns map, mirroring how
 * CommandButtonTile is handed its main-process-owned run state) and fires
 * `onRun`/`onEdit`.
 */
import { Play, Square, Check, X as XIcon, Loader2, Zap, Clock, Settings2 } from "lucide-react";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import type { TriggerRunState } from "./workflow-engine";

interface Props {
  tileId: string;
  name: string;
  mode: "manual" | "schedule";
  everyMs?: number;
  run: TriggerRunState;
  onRun: () => void;
  onEdit: () => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

const STATUS_UI: Record<TriggerRunState["status"], { color: string; label: string }> = {
  idle: { color: "var(--color-fg3)", label: "Idle" },
  running: { color: "var(--color-brand)", label: "Running" },
  done: { color: "var(--color-ok)", label: "Done" },
  error: { color: "var(--color-err)", label: "Error" },
};

function StatusIcon({ status }: { status: TriggerRunState["status"] }) {
  switch (status) {
    case "running":
      return <Loader2 size={15} className="animate-spin" aria-hidden />;
    case "done":
      return <Check size={15} aria-hidden />;
    case "error":
      return <XIcon size={15} aria-hidden />;
    default:
      return <Play size={15} aria-hidden />;
  }
}

/** "every 30m" / "every 2h" — the compact schedule readout under the badge. */
function scheduleLabel(everyMs?: number): string {
  if (!everyMs || everyMs <= 0) return "not set";
  const mins = Math.round(everyMs / 60_000);
  if (mins < 60) return `every ${mins}m`;
  const hrs = mins / 60;
  return `every ${Number.isInteger(hrs) ? hrs : hrs.toFixed(1)}h`;
}

export function TriggerTile({ tileId: _tileId, name, mode, everyMs, run, onRun, onEdit, onClose, pinned, onTogglePin }: Props) {
  const running = run.status === "running";
  const ui = STATUS_UI[run.status];

  const detail = (() => {
    if (run.status === "running") return "running…";
    if (run.status === "error") return run.note ?? "failed";
    if (run.status === "done") return run.note ?? "done";
    return mode === "schedule" ? scheduleLabel(everyMs) : "manual";
  })();

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <Zap aria-hidden size={13} className="text-[var(--color-fg3)] shrink-0" />
        <span className="font-semibold text-[var(--color-fg)] truncate">{name || "Trigger"}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {mode === "schedule" && <Clock size={11} className="text-[var(--color-fg3)]" aria-label="scheduled" />}
          <button
            onClick={onEdit}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="edit trigger"
            title="edit"
          ><Settings2 size={11} /></button>
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
          <button
            onClick={onClose}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="close tile"
            title="close"
          >×</button>
        </span>
      </header>

      <div className="nodrag flex-1 min-h-0 flex flex-col items-stretch justify-center gap-2 p-3">
        <button
          onClick={onRun}
          disabled={running}
          className="group relative w-full flex-1 min-h-0 rounded-lg border transition-colors grid place-items-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]/40 disabled:cursor-default"
          style={{
            borderColor: ui.color,
            background: `color-mix(in srgb, ${ui.color} 10%, transparent)`,
          }}
          aria-label="run workflow now"
          title="Run now"
        >
          <span className="flex flex-col items-center gap-1.5" style={{ color: ui.color }}>
            {running ? (
              <span className="flex items-center gap-2">
                <Loader2 size={18} className="animate-spin" aria-hidden />
                <Square size={16} aria-hidden className="opacity-40" />
              </span>
            ) : (
              <StatusIcon status={run.status} />
            )}
            <span className="text-[12px] font-semibold">{running ? "Running…" : "Run now"}</span>
          </span>
        </button>

        <div className="flex items-center gap-2 px-0.5">
          <span
            aria-hidden
            className={`size-2.5 rounded-full shrink-0 ${running ? "animate-pulse" : ""}`}
            style={{ background: ui.color, boxShadow: `0 0 6px ${ui.color}` }}
          />
          <span className="text-[11px] font-medium" style={{ color: ui.color }}>{ui.label}</span>
          <span className="ml-auto text-[10.5px] text-[var(--color-fg3)] truncate">{detail}</span>
        </div>
      </div>
    </div>
  );
}
