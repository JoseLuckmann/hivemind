/**
 * The kiro (kiro-cli) provider. kiro-cli ships the Claude-Code hook vocabulary in
 * a custom agent config, so — given an ephemeral KIRO_HOME home seeded with
 * hivemind's `agents/hivemind.json` (ctx.kiroHome) — it emits the deterministic
 * turn/status signals: `userPromptSubmit`/`stop` drive working/idle AND `stop`'s
 * inline `assistant_response` lets agent.read / workflow.run gather a clean reply
 * via the turn-tracker (the same inline-text path pi uses). The renderer
 * screen-scrape (`detectKiro`) stays as the fallback for sessions started before
 * injection. On restore it resolves the newest session for the tile cwd (via
 * `--list-sessions`) and respawns `chat --resume-id <id>` (fallback `--resume`).
 * This adapter wraps the unit-tested kiro-resume transforms and reuses their
 * `isKiro` matcher (single source of truth — `kiro-cli` only, never the bare
 * `kiro` IDE binary).
 */
import { isKiro, makeKiroResumeTransforms } from "../kiro-resume.js";
import type { AgentProvider } from "./types.js";

export const kiroProvider: AgentProvider = {
  id: "kiro",
  matches: (cmd) => isKiro({ cmd: cmd ?? "" }),
  resume: (ctx) =>
    makeKiroResumeTransforms({
      execPath: ctx.execPath,
      kiroHome: ctx.kiroHome,
      stopHookPath: ctx.kiroStopHookPath,
      userpromptHookPath: ctx.userpromptHookPath,
      hcpSock: ctx.hcpSock,
      hcpToken: ctx.hcpToken,
    }),
};
