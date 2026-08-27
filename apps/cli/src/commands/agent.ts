/**
 * `hive agent context`    → regenerate .hivemind/.agent.md
 * `hive agent detect`     → probe PATH for known agent CLIs, write to config.yaml
 */
import { defineCommand } from "citty";
import { spawnSync } from "node:child_process";
import {
  HiveError,
  readConfig,
  requireRoot,
  writeAgentContext,
  writeConfig,
} from "@hivemind/core";
import { err, ok } from "../format.js";

// Known agent CLIs, as { id → binary on PATH }. The id is the stable agent name
// recorded in config.yaml (and matched by --assignee); the binary is what we
// probe with `which`. They differ for kiro: the agent id is `kiro` but the CLI
// binary is `kiro-cli` (bare `kiro` is the Kiro IDE, a different program).
const KNOWN_AGENTS: Array<{ id: string; bin: string }> = [
  { id: "claude", bin: "claude" },
  { id: "codex", bin: "codex" },
  { id: "gemini", bin: "gemini" },
  { id: "opencode", bin: "opencode" },
  { id: "openclaw", bin: "openclaw" },
  { id: "hermes", bin: "hermes" },
  { id: "amp", bin: "amp" },
  { id: "cursor", bin: "cursor" },
  { id: "pi", bin: "pi" },
  { id: "droid", bin: "droid" },
  { id: "kiro", bin: "kiro-cli" },
];

const contextCmd = defineCommand({
  meta: { name: "context", description: "Regenerate .hivemind/.agent.md" },
  args: {
    state: { type: "string", description: "Include states (repeatable)" },
    json: { type: "boolean" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const states = args.state
        ? (Array.isArray(args.state) ? args.state : [args.state]).map(String)
        : undefined;
      const p = await writeAgentContext(
        root,
        states ? { includeStates: states as ("todo" | "in_progress" | "in_review")[] } : undefined
      );
      return ok(ctx, { path: p }, () => `✓ ${p} regenerated`);
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "agent_context_failed";
      return err(ctx, code, msg);
    }
  },
});

const detectCmd = defineCommand({
  meta: {
    name: "detect",
    description: "Probe PATH for known agent CLIs; record into config.yaml",
  },
  args: { json: { type: "boolean" } },
  async run({ args }) {
    const ctx = { json: !!args.json };
    try {
      const root = await requireRoot();
      const cfg = await readConfig(root);
      const detected: Record<string, { bin: string; model?: string }> = {};
      for (const { id, bin: binName } of KNOWN_AGENTS) {
        const which = spawnSync("which", [binName], { encoding: "utf8" });
        const bin = which.stdout.trim();
        if (which.status === 0 && bin) {
          detected[id] = { bin };
        }
      }
      cfg.agents = detected;
      await writeConfig(root, cfg);
      await writeAgentContext(root);
      return ok(ctx, detected, () => {
        const list = Object.entries(detected)
          .map(([k, v]) => `  ${k.padEnd(10)} ${v.bin}`)
          .join("\n");
        return `✓ detected ${Object.keys(detected).length} agent CLIs\n${list || "  (none)"}`;
      });
    } catch (e) {
      const msg = e instanceof HiveError ? e.message : (e as Error).message;
      const code = e instanceof HiveError ? e.code : "agent_detect_failed";
      return err(ctx, code, msg);
    }
  },
});

export const agentCmd = defineCommand({
  meta: { name: "agent", description: "Agent context and CLI detection" },
  subCommands: { context: contextCmd, detect: detectCmd },
});
