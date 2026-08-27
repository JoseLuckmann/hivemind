/**
 * Kiro CLI (`kiro-cli`) provider transforms: session resume AND
 * deterministic-signal hook injection. kiro-cli ships the SAME hook vocabulary as
 * Claude Code — `userPromptSubmit`, `stop`, `preToolUse`, `postToolUse`,
 * `agentSpawn` — declared in a custom AGENT CONFIG (`<KIRO_HOME>/agents/<name>.json`)
 * and selected with `chat --agent <name>` (verified against kiro-cli 2.19.2). So
 * kiro is a first-class hook provider, not scrape-only: we inject a hivemind agent
 * whose `userPromptSubmit`→working and `stop`→turn/idle hooks make status
 * deterministic and let agent.read / workflow.run gather a clean reply.
 *
 * INLINE-TEXT REPLY (not transcript): kiro's `stop` payload carries the reply
 * INLINE as `assistant_response` and has NO `transcript_path`, and kiro's own
 * transcript JSONL isn't the Anthropic format the shared claude/droid scripts
 * parse. So kiro uses a KIRO-SPECIFIC stop hook (hcp/kiro-stop-hook-source.ts)
 * that forwards `assistant_response` as the turn `text` — the same inline-text
 * path pi uses. It reuses the SHARED userPromptSubmit hook verbatim (that one
 * ignores its payload; it only needs the turn-start edge).
 *
 * INJECTION SEAM — kiro has no inline `--settings` flag (claude does). Hooks live
 * in the agent config file, and `KIRO_HOME` relocates the whole ~/.kiro home, so
 * hivemind points kiro at an EPHEMERAL per-install home (symlinks to the real
 * ~/.kiro for auth/settings/sessions + our own `agents/hivemind.json`) — the
 * user's real ~/.kiro is never touched. See hcp/kiro-home.ts for the seeding.
 * Because that home (and thus the agent config) is SHARED across kiro tiles,
 * per-tile attribution rides the spawn ENV (`HIVEMIND_TILE`), which the hook
 * scripts read.
 *
 * PERMISSIVE TOOLS: an HCP worker must not stall on kiro's per-tool approval
 * prompt, so the injected agent trusts all tools (`tools:["*"]`,
 * `allowedTools:["*"]`, a permissive `permissions` rule). A human-driven tile
 * that spawns raw (no `--agent hivemind`) still gets the normal prompts, and the
 * scrape detector's `blocked` branch surfaces them.
 *
 * RESUME — PER-TILE where possible: unlike the bare `--resume` (cwd-scoped: two
 * tiles in one cwd both restore the newest), kiro-cli exposes a scannable session
 * store via `chat --list-sessions --format json` (keyed by cwd, sorted by
 * updatedAt). On restore we resolve the newest sessionId for the tile cwd and
 * respawn `chat --resume-id <id>`, falling back to `--resume` if the scan yields
 * nothing. Two tiles in one cwd still collide on the newest id — the same
 * tradeoff pi/codex make — but the scan makes id-based resume possible.
 *
 * MATCHES `kiro-cli` ONLY. Do NOT alias bare `kiro`: that's a different binary —
 * the Kiro IDE (a VS Code fork). The app only ever spawns `kiro-cli`, so an alias
 * couldn't help; it could only misfire.
 */
import { basename } from "node:path";
import { spawnSync } from "node:child_process";
import type { SpawnSpec } from "./pty-session-manager.js";
import { shq } from "./claude-resume.js";
import { KIRO_AGENT_NAME } from "./hcp/kiro-home.js";

export function isKiro(spec: { cmd: string }): boolean {
  return basename(spec.cmd.trim().split(/\s+/)[0] ?? "") === "kiro-cli";
}

export interface KiroResumeDeps {
  /** Node/electron-as-node binary that runs the hook scripts (process.execPath). */
  execPath?: string;
  /** The ephemeral KIRO_HOME target (per install). Set → hooks fire via our agent. */
  kiroHome?: string;
  /** The KIRO-SPECIFIC stop hook script (forwards assistant_response inline). */
  stopHookPath?: string;
  /** The SHARED userPromptSubmit hook script (turn-start → working; verbatim). */
  userpromptHookPath?: string;
  /** HCP control-plane socket + capability token (injected into the agent env). */
  hcpSock?: string;
  hcpToken?: string;
  /** The kiro-cli binary used for the `--list-sessions` scan on restore. Defaults
   *  to the spawn spec's own command. Overridable for tests. */
  kiroBin?: string;
  /** Injected `--list-sessions` scanner (tests). Returns the newest sessionId for
   *  a cwd, or undefined. Defaults to {@link newestKiroSessionForCwd}. */
  sessionScan?: (cwd: string, bin: string, kiroHome?: string) => string | undefined;
}

/**
 * The hivemind agent config written to `<KIRO_HOME>/agents/hivemind.json`. Wires
 * kiro's lifecycle hooks to hivemind's HCP hook scripts and trusts all tools so a
 * spawned worker doesn't stall on an approval prompt. Commands carry NO tileId
 * (the config is shared across kiro tiles) — attribution rides the spawn env
 * HIVEMIND_TILE, which the scripts read. Returns undefined-shaped hooks (empty)
 * if the hook deps aren't wired; the config is still valid (just scrape-only).
 */
export function kiroAgentConfig(deps: KiroResumeDeps): Record<string, unknown> {
  const hooks: Record<string, unknown[]> = {};
  if (deps.execPath && deps.hcpSock) {
    const cmd = (hookPath: string) =>
      `ELECTRON_RUN_AS_NODE=1 ${shq(deps.execPath!)} ${shq(hookPath)} ${shq(deps.hcpSock!)}`;
    if (deps.userpromptHookPath) {
      // Turn START → working (deterministic; pairs with stop's turn END → idle).
      hooks.userPromptSubmit = [{ command: cmd(deps.userpromptHookPath) }];
    }
    if (deps.stopHookPath) {
      // Turn END → idle + a `turn` event carrying the inline reply → clean gather.
      hooks.stop = [{ command: cmd(deps.stopHookPath) }];
    }
  }
  return {
    name: KIRO_AGENT_NAME,
    description: "hivemind-managed agent: deterministic HCP lifecycle hooks + trusted tools.",
    prompt: null,
    // The worker inherits the repo's .mcp.json (hive tools) via includeMcpJson,
    // and HIVE_HCP_SOCK in its env lets that hive MCP drive the canvas — same as
    // claude/droid. No mcpServers baked here.
    mcpServers: {},
    includeMcpJson: true,
    // Trust every tool so an HCP worker runs unattended (no per-tool prompt stall).
    tools: ["*"],
    allowedTools: ["*"],
    toolsSettings: {},
    resources: [],
    hooks,
    // Permission rules mirror the trusted-tools intent for the v3 permission model
    // (harmless on 2.x, which keys off allowedTools). Allow all capabilities.
    permissions: { rules: [{ capability: "all", effect: "allow" }] },
  };
}

/** Env injected into a spawned kiro: the ephemeral KIRO_HOME (so it loads OUR
 *  agent + hooks without touching ~/.kiro) + the HCP socket/token/tile-id (so its
 *  hooks + the hive MCP reach the control plane, attributed to this tile). */
function kiroEnv(deps: KiroResumeDeps, spec: SpawnSpec, id: string): Record<string, string> | undefined {
  if (!deps.kiroHome && !(deps.hcpSock && deps.hcpToken)) return spec.env;
  const env: Record<string, string> = { ...spec.env };
  if (deps.kiroHome) env.KIRO_HOME = deps.kiroHome;
  if (deps.hcpSock && deps.hcpToken) {
    env.HIVE_HCP_SOCK = deps.hcpSock;
    env.HCP_TOKEN = deps.hcpToken;
    env.HIVEMIND_TILE = id; // hooks + the agent's own hive MCP attribute to this tile
    env.HIVE_AGENT_DEPTH = spec.env?.HIVE_AGENT_DEPTH ?? "0";
  }
  return env;
}

/** Ensure the spawn drives `chat --agent <hivemind>` so our hook-wired agent is
 *  active. Only when a KIRO_HOME (with our agent) is configured — otherwise leave
 *  the args untouched (raw kiro, scrape-only). Idempotent: never double-adds. */
function withHivemindAgent(deps: KiroResumeDeps, args: string[]): string[] {
  if (!deps.kiroHome) return args; // no injected agent to select
  let out = args.slice();
  // Ensure an explicit `chat` subcommand (bare kiro-cli defaults to chat, but we
  // must have a stable anchor to place flags after).
  if (!out.includes("chat")) out = ["chat", ...out];
  if (out.includes("--agent")) return out; // caller already picked an agent — respect it
  const chatIdx = out.indexOf("chat");
  return [...out.slice(0, chatIdx + 1), "--agent", KIRO_AGENT_NAME, ...out.slice(chatIdx + 1)];
}

/**
 * Newest kiro-cli sessionId whose `cwd` matches, or undefined. Shells out to
 * `kiro-cli chat --list-sessions --format json` (kiro's own scannable store),
 * which emits `[{ cwd, sessions: [{ sessionId, updatedAt, … }], … }]` sorted
 * newest-first. Best-effort: any failure (binary missing, non-JSON, timeout)
 * returns undefined so restore falls back to `--resume`.
 */
export function newestKiroSessionForCwd(
  cwd: string,
  bin: string,
  kiroHome?: string,
): string | undefined {
  try {
    const env = { ...process.env } as Record<string, string>;
    if (kiroHome) env.KIRO_HOME = kiroHome;
    const r = spawnSync(bin, ["chat", "--list-sessions", "--format", "json"], {
      cwd, env, encoding: "utf8", timeout: 5000, maxBuffer: 8 * 1024 * 1024,
    });
    if (r.status !== 0 || !r.stdout) return undefined;
    const envelopes = JSON.parse(r.stdout) as Array<{
      cwd?: string; sessions?: Array<{ sessionId?: string; updatedAt?: string }>;
    }>;
    const forCwd = envelopes.find((e) => e.cwd === cwd) ?? envelopes[0];
    const sessions = forCwd?.sessions ?? [];
    if (sessions.length === 0) return undefined;
    // Sort newest-first by updatedAt (defensive — kiro already sorts, but don't
    // rely on order); take the first with a sessionId.
    const sorted = [...sessions].sort((a, b) =>
      String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")),
    );
    return sorted.find((s) => s.sessionId)?.sessionId;
  } catch {
    return undefined;
  }
}

export interface KiroResumeTransforms {
  transformSpecOnSpawn: (spec: SpawnSpec, id: string) => SpawnSpec;
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makeKiroResumeTransforms(deps: KiroResumeDeps = {}): KiroResumeTransforms {
  const scan = deps.sessionScan ?? newestKiroSessionForCwd;
  return {
    // Fresh spawn: select our hook-wired agent + inject the home/HCP env so the
    // deterministic hooks fire for THIS tile. No resume flag (that's restore).
    transformSpecOnSpawn: (spec, id) => {
      if (!isKiro(spec)) return spec;
      return { ...spec, env: kiroEnv(deps, spec, id), args: withHivemindAgent(deps, spec.args ?? []) };
    },
    transformSpecOnRestore: (spec, id) => {
      if (!isKiro(spec)) return spec;
      const withAgent = { ...spec, env: kiroEnv(deps, spec, id), args: withHivemindAgent(deps, spec.args ?? []) };
      const args = withAgent.args ?? [];
      // Already resuming (explicit id or bare) — leave the resume flags alone.
      if (args.includes("--resume") || args.includes("--resume-id")) return withAgent;
      const bin = deps.kiroBin ?? basename(spec.cmd.trim().split(/\s+/)[0] ?? "kiro-cli");
      const sessId = scan(withAgent.cwd, bin, deps.kiroHome);
      // Per-tile id resume if the scan found one; else fall back to cwd-scoped
      // `--resume` (kiro resolves the newest session for the cwd internally).
      // Appended after the agent selection — kiro-cli is flag-order-independent,
      // and appending keeps `chat --agent <name>` intact and readable.
      const resumeArgs = sessId ? ["--resume-id", sessId] : ["--resume"];
      return { ...withAgent, args: [...args, ...resumeArgs] };
    },
    // If the resumed session is stale/missing and kiro dies fast, strip the resume
    // flags (and the --resume-id value) so a bad id doesn't kill the tile.
    restoreRetryTransform: (spec) => {
      if (!isKiro(spec)) return null;
      const args = spec.args ?? [];
      const idIdx = args.indexOf("--resume-id");
      if (idIdx >= 0) {
        return { ...spec, args: [...args.slice(0, idIdx), ...args.slice(idIdx + 2)] };
      }
      const rIdx = args.indexOf("--resume");
      if (rIdx >= 0) {
        return { ...spec, args: [...args.slice(0, rIdx), ...args.slice(rIdx + 1)] };
      }
      return null;
    },
  };
}
