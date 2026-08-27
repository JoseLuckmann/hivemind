/**
 * workflow-scheduler — arms/cancels the recurring timer for a `schedule`-mode
 * trigger tile. v1 is a plain fixed interval (no cron expression — see
 * docs/canvas-workflows.md), so this is a `setInterval` per armed trigger,
 * keyed by tile id, with an injectable clock (mirrors
 * main/hcp/subagent-reaper.ts's SubagentReaper — same `.unref()`-friendly,
 * idempotent arm/cancel shape, just recurring instead of one-shot).
 *
 * Lives in the renderer (not main) because the trigger graph + schedule
 * config are renderer/localStorage state (canvas-persistence.ts) — there is
 * no main-process visibility into it. `.unref()` isn't meaningful in a
 * renderer process (no Node event-loop keepalive semantics), so the clock
 * just wraps window.setInterval/clearInterval directly.
 */
export interface SchedulerClock {
  set: (cb: () => void, ms: number) => ReturnType<typeof setInterval>;
  clear: (t: ReturnType<typeof setInterval>) => void;
}

const realClock: SchedulerClock = {
  set: (cb, ms) => setInterval(cb, ms),
  clear: (t) => clearInterval(t),
};

export class WorkflowScheduler {
  private timers = new Map<string, ReturnType<typeof setInterval>>();
  private intervals = new Map<string, number>();

  constructor(
    private readonly onFire: (triggerId: string) => void,
    private readonly clock: SchedulerClock = realClock,
  ) {}

  /** (Re)arm a trigger's recurring fire. Idempotent — re-arming with the SAME
   *  interval is a no-op (avoids resetting the phase every unrelated render);
   *  a CHANGED interval replaces the timer. `everyMs <= 0` cancels instead. */
  arm(triggerId: string, everyMs: number): void {
    if (!everyMs || everyMs <= 0) { this.cancel(triggerId); return; }
    if (this.intervals.get(triggerId) === everyMs) return;
    this.cancel(triggerId);
    this.intervals.set(triggerId, everyMs);
    this.timers.set(triggerId, this.clock.set(() => this.onFire(triggerId), everyMs));
  }

  /** Stop a trigger's recurring fire (manual mode, deleted, or reconfigured
   *  away from schedule). No-op if none armed. */
  cancel(triggerId: string): void {
    const t = this.timers.get(triggerId);
    if (t !== undefined) this.clock.clear(t);
    this.timers.delete(triggerId);
    this.intervals.delete(triggerId);
  }

  /** Drop every armed timer (component unmount). */
  cancelAll(): void {
    for (const id of [...this.timers.keys()]) this.cancel(id);
  }

  /** Is a trigger currently armed? (test/introspection aid.) */
  armed(triggerId: string): boolean {
    return this.timers.has(triggerId);
  }

  /** Every currently-armed trigger id — lets a caller cancel timers for
   *  triggers that no longer exist (closed tile) without tracking that set
   *  itself. */
  armedIds(): string[] {
    return [...this.timers.keys()];
  }
}
