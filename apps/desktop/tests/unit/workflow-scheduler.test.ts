// workflow-scheduler — recurring per-trigger timer for schedule-mode triggers.
// Same fake-clock shape as subagent-reaper.test.ts, adapted for setInterval.
import { test } from "node:test";
import assert from "node:assert/strict";

const { WorkflowScheduler } = await import("../../src/renderer/src/workflow-scheduler.ts");

function fakeClock() {
  let seq = 0;
  const pending = new Map<number, () => void>();
  return {
    clock: {
      set: (cb: () => void) => { const id = ++seq; pending.set(id, cb); return id as unknown as ReturnType<typeof setInterval>; },
      clear: (t: ReturnType<typeof setInterval>) => { pending.delete(t as unknown as number); },
    },
    fireAll: () => { for (const [, cb] of [...pending]) cb(); },
    pendingCount: () => pending.size,
  };
}

test("arm fires onFire when the timer ticks", () => {
  const fired: string[] = [];
  const { clock, fireAll } = fakeClock();
  const s = new WorkflowScheduler((id) => fired.push(id), clock);
  s.arm("trig1", 60_000);
  assert.equal(s.armed("trig1"), true);
  fireAll();
  assert.deepEqual(fired, ["trig1"]);
});

test("re-arming with the SAME interval is a no-op (doesn't reset the timer)", () => {
  const { clock, pendingCount } = fakeClock();
  const s = new WorkflowScheduler(() => {}, clock);
  s.arm("trig1", 60_000);
  s.arm("trig1", 60_000);
  s.arm("trig1", 60_000);
  assert.equal(pendingCount(), 1);
});

test("re-arming with a CHANGED interval replaces the timer", () => {
  const { clock, pendingCount } = fakeClock();
  const s = new WorkflowScheduler(() => {}, clock);
  s.arm("trig1", 60_000);
  s.arm("trig1", 120_000);
  assert.equal(pendingCount(), 1); // old one cleared, one new one set
});

test("arm with everyMs <= 0 cancels instead of scheduling", () => {
  const { clock } = fakeClock();
  const s = new WorkflowScheduler(() => {}, clock);
  s.arm("trig1", 60_000);
  s.arm("trig1", 0);
  assert.equal(s.armed("trig1"), false);
});

test("cancel stops future fires", () => {
  const fired: string[] = [];
  const { clock, fireAll } = fakeClock();
  const s = new WorkflowScheduler((id) => fired.push(id), clock);
  s.arm("trig1", 60_000);
  s.cancel("trig1");
  fireAll();
  assert.deepEqual(fired, []);
});

test("triggers are tracked independently", () => {
  const fired: string[] = [];
  const { clock, fireAll } = fakeClock();
  const s = new WorkflowScheduler((id) => fired.push(id), clock);
  s.arm("a", 60_000);
  s.arm("b", 60_000);
  s.cancel("a");
  fireAll();
  assert.deepEqual(fired, ["b"]);
});

test("armedIds lists exactly the currently-armed triggers", () => {
  const { clock } = fakeClock();
  const s = new WorkflowScheduler(() => {}, clock);
  s.arm("a", 60_000);
  s.arm("b", 60_000);
  s.cancel("a");
  assert.deepEqual(s.armedIds(), ["b"]);
});

test("cancelAll drops every armed timer", () => {
  const fired: string[] = [];
  const { clock, fireAll } = fakeClock();
  const s = new WorkflowScheduler((id) => fired.push(id), clock);
  s.arm("a", 60_000);
  s.arm("b", 60_000);
  s.cancelAll();
  fireAll();
  assert.deepEqual(fired, []);
  assert.deepEqual(s.armedIds(), []);
});
