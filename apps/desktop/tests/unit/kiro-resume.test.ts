// kiro-resume — matcher, agent-config + env injection, per-tile resume (scan →
// --resume-id, fallback --resume), and retry-strip. Run: pnpm test:unit
import { test } from "node:test";
import assert from "node:assert/strict";

const { isKiro, makeKiroResumeTransforms, kiroAgentConfig } = await import(
  "../../src/main/kiro-resume.ts"
);

const spec = (cmd: string, args: string[] = [], extra: Record<string, unknown> = {}) => ({
  cwd: "/w",
  cmd,
  args,
  ...extra,
});

// A full deps bundle wiring the ephemeral home + HCP; `sessionScan` is injected so
// the tests never shell out to a real kiro-cli.
const DEPS = {
  execPath: "/x/electron",
  kiroHome: "/x/kiro-home",
  stopHookPath: "/x/kiro-stop.cjs",
  userpromptHookPath: "/x/up.cjs",
  hcpSock: "/x/hcp.sock",
  hcpToken: "tok",
  sessionScan: (cwd: string) => (cwd === "/w" ? "sid-newest" : undefined),
};

test("isKiro matches kiro-cli ONLY (path/args tolerant), never the bare kiro IDE binary", () => {
  assert.equal(isKiro({ cmd: "kiro-cli" }), true);
  assert.equal(isKiro({ cmd: "/usr/local/bin/kiro-cli" }), true);
  assert.equal(isKiro({ cmd: "kiro-cli chat --resume" }), true);
  assert.equal(isKiro({ cmd: "kiro" }), false);
  assert.equal(isKiro({ cmd: "/usr/bin/kiro" }), false);
  assert.equal(isKiro({ cmd: "claude" }), false);
});

// ── AGENT CONFIG ─────────────────────────────────────────────────────────────
test("kiroAgentConfig wires userPromptSubmit + stop hooks and trusts all tools", () => {
  const cfg = kiroAgentConfig(DEPS) as any;
  assert.equal(cfg.name, "hivemind");
  // Hooks use kiro's lowerCamel event keys (NOT claude's TitleCase).
  assert.ok(cfg.hooks.userPromptSubmit, "userPromptSubmit hook present");
  assert.ok(cfg.hooks.stop, "stop hook present");
  const stopCmd = cfg.hooks.stop[0].command as string;
  assert.match(stopCmd, /ELECTRON_RUN_AS_NODE=1/);
  assert.match(stopCmd, /kiro-stop\.cjs/);
  assert.match(stopCmd, /hcp\.sock/);
  // Trusted tools so an HCP worker doesn't stall on a per-tool approval prompt.
  assert.deepEqual(cfg.tools, ["*"]);
  assert.deepEqual(cfg.allowedTools, ["*"]);
  assert.equal(cfg.permissions.rules[0].effect, "allow");
  // Attribution rides env, not the shared command string.
  assert.doesNotMatch(stopCmd, /HIVEMIND_TILE=/);
});

test("kiroAgentConfig has empty hooks without execPath/hcpSock (still a valid config)", () => {
  const cfg = kiroAgentConfig({}) as any;
  assert.deepEqual(cfg.hooks, {});
  assert.equal(cfg.name, "hivemind");
  assert.deepEqual(cfg.allowedTools, ["*"]);
});

// ── SPAWN (agent selection + env) ────────────────────────────────────────────
test("transformSpecOnSpawn selects --agent hivemind after chat AND injects KIRO_HOME + HCP env", () => {
  const { transformSpecOnSpawn } = makeKiroResumeTransforms(DEPS);
  const out = transformSpecOnSpawn(spec("kiro-cli", []), "tile-7");
  assert.deepEqual(out.args, ["chat", "--agent", "hivemind"]);
  assert.equal(out.env?.KIRO_HOME, "/x/kiro-home");
  assert.equal(out.env?.HIVE_HCP_SOCK, "/x/hcp.sock");
  assert.equal(out.env?.HCP_TOKEN, "tok");
  assert.equal(out.env?.HIVEMIND_TILE, "tile-7");
});

test("transformSpecOnSpawn preserves an explicit chat + a caller-chosen --agent", () => {
  const { transformSpecOnSpawn } = makeKiroResumeTransforms(DEPS);
  const out = transformSpecOnSpawn(spec("kiro-cli", ["chat", "--agent", "custom"]), "t");
  // Caller already picked an agent — respect it, don't double-inject.
  assert.deepEqual(out.args, ["chat", "--agent", "custom"]);
});

test("transformSpecOnSpawn without kiroHome leaves args untouched (raw kiro, scrape-only)", () => {
  const { transformSpecOnSpawn } = makeKiroResumeTransforms({ hcpSock: "/x/s", hcpToken: "t" });
  const out = transformSpecOnSpawn(spec("kiro-cli", []), "t");
  assert.deepEqual(out.args, []); // no --agent injected without an owned home
  assert.equal(out.env?.HIVE_HCP_SOCK, "/x/s"); // env still injected
});

test("transformSpecOnSpawn is a no-op for non-kiro specs", () => {
  const { transformSpecOnSpawn } = makeKiroResumeTransforms(DEPS);
  const claude = spec("claude", []);
  assert.deepEqual(transformSpecOnSpawn(claude, "t"), claude);
});

// ── RESTORE (per-tile resume) ────────────────────────────────────────────────
test("transformSpecOnRestore resumes the newest scanned session via --resume-id (+ agent + env)", () => {
  const { transformSpecOnRestore } = makeKiroResumeTransforms(DEPS);
  const out = transformSpecOnRestore(spec("kiro-cli", []), "tile-1");
  // chat --agent hivemind --resume-id sid-newest
  assert.deepEqual(out.args, ["chat", "--agent", "hivemind", "--resume-id", "sid-newest"]);
  assert.equal(out.env?.KIRO_HOME, "/x/kiro-home");
  assert.equal(out.env?.HIVEMIND_TILE, "tile-1");
});

test("transformSpecOnRestore falls back to cwd-scoped --resume when the scan finds nothing", () => {
  const { transformSpecOnRestore } = makeKiroResumeTransforms({
    ...DEPS,
    sessionScan: () => undefined,
  });
  const out = transformSpecOnRestore(spec("kiro-cli", []), "t");
  assert.deepEqual(out.args, ["chat", "--agent", "hivemind", "--resume"]);
});

test("transformSpecOnRestore leaves an already-resuming spec's resume flags alone", () => {
  const { transformSpecOnRestore } = makeKiroResumeTransforms(DEPS);
  const already = transformSpecOnRestore(spec("kiro-cli", ["chat", "--resume-id", "abc"]), "t");
  assert.ok(already.args.includes("--resume-id"));
  assert.ok(!already.args.includes("sid-newest"), "did not add a second resume id");
  const bare = transformSpecOnRestore(spec("kiro-cli", ["chat", "--resume"]), "t");
  assert.ok(bare.args.includes("--resume"));
  assert.ok(!bare.args.includes("--resume-id"), "did not upgrade an explicit --resume");
});

test("transformSpecOnRestore is a no-op for non-kiro specs (incl. the bare kiro IDE binary)", () => {
  const { transformSpecOnRestore } = makeKiroResumeTransforms(DEPS);
  const claude = spec("claude", []);
  assert.deepEqual(transformSpecOnRestore(claude, "t"), claude);
  const ide = spec("kiro", []);
  assert.deepEqual(transformSpecOnRestore(ide, "t"), ide);
});

// ── RETRY (strip a stale resume) ─────────────────────────────────────────────
test("restoreRetryTransform strips --resume-id AND its value so a stale id respawns fresh", () => {
  const { restoreRetryTransform } = makeKiroResumeTransforms(DEPS);
  const out = restoreRetryTransform(
    spec("kiro-cli", ["chat", "--agent", "hivemind", "--resume-id", "sid-newest"]),
  );
  assert.deepEqual(out?.args, ["chat", "--agent", "hivemind"]);
});

test("restoreRetryTransform strips a bare --resume", () => {
  const { restoreRetryTransform } = makeKiroResumeTransforms(DEPS);
  const out = restoreRetryTransform(spec("kiro-cli", ["chat", "--agent", "hivemind", "--resume"]));
  assert.deepEqual(out?.args, ["chat", "--agent", "hivemind"]);
});

test("restoreRetryTransform returns null when there's nothing to strip / not kiro", () => {
  const { restoreRetryTransform } = makeKiroResumeTransforms(DEPS);
  assert.equal(restoreRetryTransform(spec("kiro-cli", ["chat", "--agent", "hivemind"])), null);
  assert.equal(restoreRetryTransform(spec("claude", ["--resume"])), null);
});
