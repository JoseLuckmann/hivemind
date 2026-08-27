/**
 * The kiro-cli `stop` hook source — emitted to disk as `hcp-kiro-stop-hook.cjs`,
 * run by kiro-cli when an agent FINISHES A TURN. It reports the finished turn to
 * the HCP socket so a driver blocked in agent.read wakes deterministically.
 *
 * WHY A KIRO-SPECIFIC STOP HOOK (not the shared claude/droid one): kiro-cli's
 * `stop` payload is `{ hook_event_name, cwd, assistant_response }` — it carries
 * the reply text INLINE and has NO `transcript_path` (verified against kiro-cli
 * 2.19.2; kiro's transcript JSONL is also its own `{kind,data}` schema, not the
 * Anthropic format the shared scripts parse). So kiro rides the SAME inline-text
 * turn path pi uses: forward `assistant_response` as the turn `text`, which the
 * turn-tracker stores and agent.read returns directly (see turn-tracker.ts `text`
 * + index.ts `onEvent` "turn" handler). Does NOT block the stop.
 *
 * Built on the shared {@link eventHookSource} skeleton (connect / write-one-event
 * / fail-open); only the topic + stdin mapping is local.
 */
import { eventHookSource } from "./event-hook-source.js";

export function kiroStopHookSource(): string {
  return eventHookSource(
    "turn",
    // Always send a turn edge (a turn is a turn even with an empty reply); carry
    // the reply inline as `text` — kiro has no transcript path.
    `return { tileId: tileId, text: (evt && typeof evt.assistant_response === "string") ? evt.assistant_response : "" };`,
  );
}
