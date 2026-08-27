/**
 * CommandButtonTile — a canvas "button" tile that runs a saved bash script in
 * the background (no terminal) and shows a coarse lifecycle state as visual
 * feedback: a status light + label that reads idle · running · done · error.
 *
 * The command + cwd are persisted config (on the TileInstance, owned by Canvas);
 * the RUN STATE lives in the main process (command-runner.ts) and is streamed
 * here over `cmd:state:<tileId>`. On (re)mount we read the current state via
 * cmdGetState so a button that opens mid-run — e.g. after a window reload —
 * shows the live state instead of a stale idle. On unmount we DON'T dispose (the
 * run should survive a remount from a view-mode switch); Canvas disposes on real
 * close via cmdDispose.
 *
 * The big surface is the run/stop control: click to run when idle/done/error,
 * click to stop while running. A small ⚙ edits the config; the header × closes.
 */
import { useEffect, useState, useCallback, useRef } from "react";
import { Play, Square, Check, X as XIcon, Loader2, Terminal, Settings2, RotateCcw, ScrollText } from "lucide-react";
import type { CmdButtonState, CmdButtonStatus } from "../../shared/ipc";
import { IDLE_CMD_STATE } from "../../shared/command-button";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";

interface Props {
  tileId: string;
  /** Display name (from the tile label / user rename). */
  name: string;
  /** The saved bash script. Empty until the button is configured. */
  script: string;
  /** Effective cwd (frame/workspace folder, or an explicit override). */
  cwd: string | null;
  /** Open the edit modal for this button. */
  onEdit: () => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

/** Per-status visual vocabulary — color token + icon + short label. Kept in one
 *  place so the light, the ring, and the label never drift apart. */
const STATUS_UI: Record<CmdButtonStatus, { color: string; label: string }> = {
  idle: { color: "var(--color-fg3)", label: "Idle" },
  running: { color: "var(--color-brand)", label: "Running" },
  done: { color: "var(--color-ok)", label: "Done" },
  error: { color: "var(--color-err)", label: "Error" },
};

function StatusIcon({ status }: { status: CmdButtonStatus }) {
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

export function CommandButtonTile({ tileId, name, script, cwd, onEdit, onClose, pinned, onTogglePin }: Props) {
  const [state, setState] = useState<CmdButtonState>(IDLE_CMD_STATE);
  // Whether the captured stdout+stderr panel is open, and its current contents.
  // Output lives in the main process (command-runner) and is pulled on demand
  // via cmdGetOutput — we poll while the panel is open + the script is running.
  const [showOutput, setShowOutput] = useState(false);
  const [output, setOutput] = useState("");
  const outputBoxRef = useRef<HTMLPreElement | null>(null);

  // Read the live state on mount (survives a window reload / remount) and
  // subscribe for transitions. The subscription is keyed to this tile's channel.
  useEffect(() => {
    let alive = true;
    window.hive.cmdGetState(tileId).then((s) => { if (alive) setState(s); }).catch(() => {});
    const unsub = window.hive.onCmdState(tileId, (s) => setState(s));
    return () => { alive = false; unsub(); };
  }, [tileId]);

  const configured = script.trim().length > 0;
  const running = state.status === "running";

  // Pull the captured output when the panel opens, and keep it fresh while a run
  // is in flight (there is no live stream channel — a short poll is enough for a
  // debug view). Also refresh once when the run ends so the tail is complete.
  useEffect(() => {
    if (!showOutput) return;
    let alive = true;
    const pull = () => {
      window.hive.cmdGetOutput(tileId).then((o) => { if (alive) setOutput(o); }).catch(() => {});
    };
    pull();
    if (!running) return () => { alive = false; };
    const id = setInterval(pull, 500);
    return () => { alive = false; clearInterval(id); };
  }, [showOutput, running, tileId, state.status]);

  // Keep the output view pinned to the newest line while it streams.
  useEffect(() => {
    if (!showOutput) return;
    const el = outputBoxRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, showOutput]);

  const onPrimary = useCallback(() => {
    if (!configured) { onEdit(); return; }
    if (running) { window.hive.cmdStop(tileId); return; }
    window.hive.cmdRun(tileId, script, cwd ?? undefined).catch(() => {});
  }, [configured, running, tileId, script, cwd, onEdit]);

  const ui = STATUS_UI[state.status];

  // A short human-readable outcome line under the button. Keeps the tile
  // informative without a full terminal: exit code on error, duration on done.
  const detail = (() => {
    if (state.status === "running") return "running…";
    if (state.status === "done" && state.startedAt && state.endedAt) {
      return `done in ${((state.endedAt - state.startedAt) / 1000).toFixed(1)}s`;
    }
    if (state.status === "error") {
      if (state.signal) return `stopped (${state.signal})`;
      if (state.exitCode != null) return `exit ${state.exitCode}`;
      return "failed";
    }
    return configured ? "ready" : "not configured";
  })();

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <Terminal aria-hidden size={13} className="text-[var(--color-fg3)] shrink-0" />
        <span className="font-semibold text-[var(--color-fg)] truncate">{name || "Command"}</span>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* Reset a done/error badge back to idle (hidden while running). */}
          {(state.status === "done" || state.status === "error") && (
            <button
              onClick={() => window.hive.cmdReset(tileId)}
              className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
              aria-label="reset status"
              title="reset"
            ><RotateCcw size={11} /></button>
          )}
          <button
            onClick={() => setShowOutput((v) => !v)}
            className={`nodrag size-4 grid place-items-center rounded hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] ${showOutput ? "text-[var(--color-brand)]" : "text-[var(--color-fg3)]"}`}
            aria-label="show output"
            aria-pressed={showOutput}
            title="show output"
          ><ScrollText size={11} /></button>
          <button
            onClick={onEdit}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="edit command"
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
          onClick={onPrimary}
          className={`group relative w-full rounded-lg border transition-colors grid place-items-center cursor-pointer focus:outline-none focus:ring-2 focus:ring-[var(--color-brand)]/40 ${showOutput ? "shrink-0 py-3" : "flex-1 min-h-0"}`}
          style={{
            borderColor: ui.color,
            background: `color-mix(in srgb, ${ui.color} 10%, transparent)`,
          }}
          aria-label={running ? "stop script" : configured ? "run script" : "configure command"}
          title={configured ? (running ? "Stop" : "Run") : "Configure this button"}
        >
          <span className="flex flex-col items-center gap-1.5" style={{ color: ui.color }}>
            {/* When running, the big control is a Stop; otherwise the status icon. */}
            {running ? (
              <span className="flex items-center gap-2">
                <Loader2 size={18} className="animate-spin" aria-hidden />
                <Square size={16} aria-hidden className="opacity-80" />
              </span>
            ) : (
              <StatusIcon status={state.status} />
            )}
            <span className="text-[12px] font-semibold">
              {!configured ? "Configure…" : running ? "Stop" : "Run"}
            </span>
          </span>
        </button>

        <div className="flex items-center gap-2 px-0.5">
          {/* The status light — the persistent, glanceable state. */}
          <span
            aria-hidden
            className={`size-2.5 rounded-full shrink-0 ${running ? "animate-pulse" : ""}`}
            style={{ background: ui.color, boxShadow: `0 0 6px ${ui.color}` }}
          />
          <span className="text-[11px] font-medium" style={{ color: ui.color }}>{ui.label}</span>
          <span className="ml-auto text-[10.5px] text-[var(--color-fg3)] truncate">{detail}</span>
        </div>

        {/* Captured stdout+stderr — a lightweight debug view (no full terminal).
            Toggled from the header; polled while running. */}
        {showOutput && (
          <div className="flex flex-col min-h-0 flex-1 rounded-lg border border-[var(--color-line)] bg-[var(--color-bg)] overflow-hidden">
            <div className="flex items-center gap-2 px-2 h-6 border-b border-[var(--color-line)] bg-[var(--color-bg3)] text-[10px] font-mono text-[var(--color-fg3)] shrink-0">
              <span>output</span>
              <button
                onClick={() => window.hive.cmdGetOutput(tileId).then(setOutput).catch(() => {})}
                className="ml-auto hover:text-[var(--color-fg)]"
                title="refresh"
              >refresh</button>
            </div>
            <pre
              ref={outputBoxRef}
              className="flex-1 min-h-0 overflow-auto m-0 p-2 text-[10.5px] leading-[1.45] font-mono text-[var(--color-fg2)] whitespace-pre-wrap break-words select-text"
            >{output || (running ? "waiting for output…" : "no output yet")}</pre>
          </div>
        )}
      </div>
    </div>
  );
}
