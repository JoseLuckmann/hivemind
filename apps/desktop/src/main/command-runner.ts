/**
 * Command-Button runner — the main-process registry that actually executes a
 * Command Button's bash script in the background. Deliberately NOT a PTY: these
 * buttons run fire-and-forget scripts (e.g. `make deploy stage=dev …`) whose
 * output the user doesn't normally watch — so a plain `child_process.spawn` of
 * `/bin/bash -c <script>` is the right, cheap primitive (no node-pty, no
 * daemon, no scrollback replay). State (idle/running/done/error) is the payload
 * that matters; it's tracked here and streamed to the renderer, keyed by tileId.
 *
 * One process per button at a time — clicking a running button is a no-op (the
 * renderer disables it; this is the belt-and-braces guard). Output is buffered
 * (bounded) so a future "show output" affordance can read it without a live
 * terminal. The env mirrors the user-shell env we resolve at startup (so
 * `make`, `aws`, nvm-node, tokens, … all resolve), minus Electron-internal vars
 * (same reasoning as sanitizeShellEnv for user terminals).
 */
import { spawn, type ChildProcess } from "node:child_process";
import { sanitizeShellEnv } from "./shell-env.js";
import {
  type CmdButtonState,
  type CmdButtonStatus,
  IDLE_CMD_STATE,
  CMD_OUTPUT_MAX_BYTES,
} from "../shared/command-button.js";

interface Runner {
  proc: ChildProcess | null;
  state: CmdButtonState;
  /** Captured stdout+stderr (interleaved), tail-trimmed to CMD_OUTPUT_MAX_BYTES. */
  output: string;
}

const runners = new Map<string, Runner>();

/** Emitter injected by main/index.ts so this module stays free of `electron`
 *  (keeps it unit-testable and mirrors how agent-notify-core is wired). Pushes a
 *  state snapshot to the renderer over `cmd:state:${tileId}`. */
type Emit = (tileId: string, state: CmdButtonState) => void;
let emit: Emit = () => {};
export function setCmdStateEmitter(fn: Emit): void {
  emit = fn;
}

function getOrInit(tileId: string): Runner {
  let r = runners.get(tileId);
  if (!r) {
    r = { proc: null, state: { ...IDLE_CMD_STATE }, output: "" };
    runners.set(tileId, r);
  }
  return r;
}

function transition(tileId: string, r: Runner, patch: Partial<CmdButtonState>): void {
  r.state = { ...r.state, ...patch };
  emit(tileId, r.state);
}

/** True iff the button's script process is currently alive. */
export function isCmdRunning(tileId: string): boolean {
  return runners.get(tileId)?.state.status === "running";
}

/** Current state snapshot (idle default if the button was never run). */
export function getCmdState(tileId: string): CmdButtonState {
  return runners.get(tileId)?.state ?? { ...IDLE_CMD_STATE };
}

/** Captured output tail of the last/current run ("" if never run). */
export function getCmdOutput(tileId: string): string {
  return runners.get(tileId)?.output ?? "";
}

/** Start the script in the background. No-op (returns {started:false}) if a run
 *  is already in flight for this button. `cwd` defaults to the process cwd when
 *  omitted; a bad cwd surfaces as an `error` state (spawn error), never a throw. */
export function runCmd(
  tileId: string,
  script: string,
  cwd?: string,
): { started: boolean } {
  const r = getOrInit(tileId);
  if (r.state.status === "running") return { started: false };
  if (!script.trim()) {
    transition(tileId, r, { status: "error", exitCode: null, signal: null, endedAt: Date.now() });
    r.output = "hivemind: empty script — nothing to run\n";
    return { started: false };
  }

  // Fresh run: clear the previous output tail + reset finish markers.
  r.output = "";
  transition(tileId, r, {
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: Date.now(),
    endedAt: null,
  });

  const env = sanitizeShellEnv({ ...process.env } as Record<string, string>);
  let proc: ChildProcess;
  try {
    // `bash -c` runs the whole script string as one command; the user writes
    // arbitrary bash (pipes, &&, multiline). Non-login/non-interactive is fine —
    // PATH + tokens come from the resolved shell env patched into process.env at
    // startup (shell-env.ts), not from sourcing rc files here.
    proc = spawn("/bin/bash", ["-c", script], {
      cwd: cwd || process.cwd(),
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (err) {
    r.output = `hivemind: failed to spawn — ${(err as Error).message}\n`;
    transition(tileId, r, { status: "error", exitCode: null, signal: null, endedAt: Date.now() });
    return { started: false };
  }

  r.proc = proc;

  const append = (chunk: Buffer) => {
    r.output += chunk.toString("utf8");
    if (r.output.length > CMD_OUTPUT_MAX_BYTES) {
      r.output = r.output.slice(r.output.length - CMD_OUTPUT_MAX_BYTES);
    }
  };
  proc.stdout?.on("data", append);
  proc.stderr?.on("data", append);

  proc.on("error", (err) => {
    // Fired e.g. when the cwd doesn't exist / bash is missing. Treat as error.
    r.output += `hivemind: ${err.message}\n`;
    r.proc = null;
    transition(tileId, r, { status: "error", exitCode: null, signal: null, endedAt: Date.now() });
  });

  proc.on("exit", (code, signal) => {
    r.proc = null;
    // exit 0 (and no terminating signal) = done; anything else = error. A
    // user-requested stop kills with SIGTERM → surfaces as error (the run did
    // not complete), which is the honest state.
    const ok = code === 0 && !signal;
    const status: CmdButtonStatus = ok ? "done" : "error";
    transition(tileId, r, {
      status,
      exitCode: code,
      signal: signal ?? null,
      endedAt: Date.now(),
    });
  });

  return { started: true };
}

/** Stop a running script (SIGTERM). No-op if nothing is running. The exit
 *  handler transitions the state (→ error, since the run was interrupted). */
export function stopCmd(tileId: string): void {
  const r = runners.get(tileId);
  if (r?.proc) r.proc.kill("SIGTERM");
}

/** Reset a button to idle (clears output + finish markers). No-op while
 *  running — you must stop first. Lets the user clear a stale done/error badge. */
export function resetCmd(tileId: string): void {
  const r = runners.get(tileId);
  if (!r || r.state.status === "running") return;
  r.output = "";
  transition(tileId, r, { ...IDLE_CMD_STATE });
}

/** Drop a button's runner entirely (tile closed). Kills any live process so a
 *  closed button never leaves an orphaned deploy running unseen. */
export function disposeCmd(tileId: string): void {
  const r = runners.get(tileId);
  if (r?.proc) r.proc.kill("SIGKILL");
  runners.delete(tileId);
}

/** Kill every running button (app quit). Best-effort. */
export function killAllCmds(): void {
  for (const r of runners.values()) {
    if (r.proc) r.proc.kill("SIGKILL");
  }
  runners.clear();
}
