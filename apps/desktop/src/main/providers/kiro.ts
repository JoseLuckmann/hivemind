/**
 * The kiro (kiro-cli) provider. Kiro stores sessions in a local SQLite database
 * (~/.kiro/) scoped by working directory. It has no hook system and no
 * pre-assignable session id, so status is screen-scrape only (detectKiro in
 * agent-state.ts). On restore, kiro-cli's `--resume` flag picks up the most
 * recent session for the tile's cwd automatically — no manual session file
 * scanning required. This adapter wraps the unit-tested kiro-resume transforms.
 */
import { basename } from "node:path";
import { makeKiroResumeTransforms } from "../kiro-resume.js";
import type { AgentProvider } from "./types.js";

export const kiroProvider: AgentProvider = {
  id: "kiro",
  matches: (cmd) => {
    const bin = basename((cmd ?? "").trim().split(/\s+/)[0] ?? "");
    return bin === "kiro-cli" || bin === "kiro";
  },
  resume: () => makeKiroResumeTransforms(),
};
