/**
 * Shared Command-Button types — the node-free contract used by both the main
 * runner and the renderer tile, so neither hand-maintains a copy. A Command
 * Button is a canvas tile that runs a saved bash script in the background (no
 * visible terminal) and surfaces a coarse lifecycle state as visual feedback.
 */

/** The lifecycle of one background script run.
 *  - idle:    never run this session, or reset — the resting state.
 *  - running: the script's process is alive.
 *  - done:    the last run exited 0 (success).
 *  - error:   the last run exited non-zero, was killed, or failed to spawn. */
export type CmdButtonStatus = "idle" | "running" | "done" | "error";

/** A snapshot of a button's runner state, streamed to the renderer on every
 *  transition (and returned by cmdGetState on (re)mount so a tile that opens
 *  mid-run — e.g. after a window reload — shows the live state). */
export interface CmdButtonState {
  status: CmdButtonStatus;
  /** Process exit code of the LAST finished run (null while running / never run
   *  / killed by signal). */
  exitCode: number | null;
  /** Signal that terminated the last run, if any (e.g. "SIGTERM" on stop). */
  signal: string | null;
  /** Epoch ms the current/last run started (null if never run). */
  startedAt: number | null;
  /** Epoch ms the last run finished (null while running / never run). */
  endedAt: number | null;
}

/** The resting default a fresh/never-run button reports. */
export const IDLE_CMD_STATE: CmdButtonState = {
  status: "idle",
  exitCode: null,
  signal: null,
  startedAt: null,
  endedAt: null,
};

/** Cap on captured output kept in memory per button, so a chatty script (e.g. a
 *  verbose deploy) can't grow the buffer without bound. Oldest bytes are dropped
 *  once exceeded — the tail is what matters for a quick "what happened" peek. */
export const CMD_OUTPUT_MAX_BYTES = 256 * 1024;
