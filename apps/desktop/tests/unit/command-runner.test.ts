// command-runner — the main-process background script runner for Command Button
// tiles. Runs real short bash scripts and asserts the idle→running→done/error
// lifecycle + the state emitted over the injected emitter. Uses node:test with
// the tsx loader (same as the other main-module tests).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  runCmd, stopCmd, resetCmd, getCmdState, getCmdOutput, disposeCmd, setCmdStateEmitter,
} from "../../src/main/command-runner.ts";
import type { CmdButtonState } from "../../src/shared/command-button.ts";

/** Wait until the runner reaches a terminal (done/error) state for `tileId`,
 *  or reject after `ms`. Polls getCmdState — the emitter is also exercised via
 *  the captured `emitted` array in the tests that install one. */
function waitForFinish(tileId: string, ms = 4000): Promise<CmdButtonState> {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const s = getCmdState(tileId);
      if (s.status === "done" || s.status === "error") { resolve(s); return; }
      if (Date.now() - started > ms) { reject(new Error(`timeout in ${s.status}`)); return; }
      setTimeout(tick, 20);
    };
    tick();
  });
}

test("never-run button reports idle", () => {
  assert.equal(getCmdState("cmd-unseen").status, "idle");
  assert.equal(getCmdOutput("cmd-unseen"), "");
  disposeCmd("cmd-unseen");
});

test("a succeeding script goes running → done (exit 0) and captures output", async () => {
  const id = "cmd-ok";
  const emitted: CmdButtonState[] = [];
  setCmdStateEmitter((tid, s) => { if (tid === id) emitted.push({ ...s }); });

  const { started } = runCmd(id, "echo hello-from-cmd");
  assert.equal(started, true);
  assert.equal(getCmdState(id).status, "running");

  const final = await waitForFinish(id);
  assert.equal(final.status, "done");
  assert.equal(final.exitCode, 0);
  assert.equal(final.signal, null);
  assert.match(getCmdOutput(id), /hello-from-cmd/);
  // The emitter saw both transitions (running then done).
  assert.ok(emitted.some((s) => s.status === "running"));
  assert.ok(emitted.some((s) => s.status === "done"));

  setCmdStateEmitter(() => {});
  disposeCmd(id);
});

test("a failing script goes running → error with the exit code", async () => {
  const id = "cmd-fail";
  runCmd(id, "exit 3");
  const final = await waitForFinish(id);
  assert.equal(final.status, "error");
  assert.equal(final.exitCode, 3);
  disposeCmd(id);
});

test("an empty script is refused and reports error without spawning", () => {
  const id = "cmd-empty";
  const { started } = runCmd(id, "   ");
  assert.equal(started, false);
  assert.equal(getCmdState(id).status, "error");
  disposeCmd(id);
});

test("clicking a running button again is a no-op (one process at a time)", async () => {
  const id = "cmd-busy";
  const first = runCmd(id, "sleep 0.4");
  assert.equal(first.started, true);
  const second = runCmd(id, "echo nope");
  assert.equal(second.started, false); // already running
  await waitForFinish(id);
  disposeCmd(id);
});

test("stop kills a running script → error state", async () => {
  const id = "cmd-stop";
  runCmd(id, "sleep 5");
  assert.equal(getCmdState(id).status, "running");
  stopCmd(id);
  const final = await waitForFinish(id);
  assert.equal(final.status, "error");
  // Killed by signal (SIGTERM) — surfaced honestly, not as "done".
  assert.ok(final.signal === "SIGTERM" || final.exitCode !== 0);
  disposeCmd(id);
});

test("reset returns a done/error button to idle; is a no-op while running", async () => {
  const id = "cmd-reset";
  runCmd(id, "true");
  await waitForFinish(id);
  assert.equal(getCmdState(id).status, "done");
  resetCmd(id);
  assert.equal(getCmdState(id).status, "idle");
  assert.equal(getCmdOutput(id), "");

  // No-op while running.
  runCmd(id, "sleep 0.3");
  resetCmd(id);
  assert.equal(getCmdState(id).status, "running");
  await waitForFinish(id);
  disposeCmd(id);
});

test("cwd override runs the script in that directory", async () => {
  const id = "cmd-cwd";
  runCmd(id, "pwd", "/tmp");
  const final = await waitForFinish(id);
  assert.equal(final.status, "done");
  assert.match(getCmdOutput(id), /\/tmp/);
  disposeCmd(id);
});

test("a bad cwd surfaces as error, never a throw", async () => {
  const id = "cmd-badcwd";
  assert.doesNotThrow(() => runCmd(id, "echo x", "/nonexistent-dir-xyz-123"));
  const final = await waitForFinish(id);
  assert.equal(final.status, "error");
  disposeCmd(id);
});
