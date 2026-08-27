// kiro-home — seeds the ephemeral KIRO_HOME overlay (symlinks to the real
// ~/.kiro + a hivemind-owned agents/hivemind.json).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, lstatSync, readlinkSync, realpathSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const { seedKiroHome, KIRO_AGENT_NAME } = await import("../../src/main/hcp/kiro-home.ts");

function fakeKiro(): string {
  const real = mkdtempSync(join(tmpdir(), "real-kiro-"));
  writeFileSync(join(real, "settings.json"), "{}");
  mkdirSync(join(real, "sessions"));
  mkdirSync(join(real, "session-index"));
  mkdirSync(join(real, "steering"));
  mkdirSync(join(real, "agents")); // the user's real agents dir — must NOT leak in
  writeFileSync(join(real, "agents", "userthing.json"), JSON.stringify({ name: "userthing" }));
  return real;
}

const CFG = { name: KIRO_AGENT_NAME, hooks: { stop: [{ command: "x" }] } };

test("symlinks every real child EXCEPT agents/, and writes our agents/<name>.json", () => {
  const real = fakeKiro();
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: CFG });

  // settings + sessions + session-index + steering are symlinks to the real store
  // (so auth/resume/steering stay shared).
  assert.equal(lstatSync(join(home, "settings.json")).isSymbolicLink(), true);
  assert.equal(realpathSync(join(home, "sessions")), realpathSync(join(real, "sessions")));
  assert.equal(realpathSync(join(home, "session-index")), realpathSync(join(real, "session-index")));
  assert.equal(readlinkSync(join(home, "steering")), join(real, "steering"));

  // agents/ is a REAL hivemind-owned dir, NOT a symlink to the user's agents.
  assert.equal(lstatSync(join(home, "agents")).isSymbolicLink(), false);
  // Our config is present…
  const ours = JSON.parse(readFileSync(join(home, "agents", `${KIRO_AGENT_NAME}.json`), "utf8"));
  assert.equal(ours.name, KIRO_AGENT_NAME);
  assert.deepEqual(ours.hooks, { stop: [{ command: "x" }] });
});

test("does NOT leak the user's real agents into the overlay", () => {
  const real = fakeKiro();
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: CFG });
  // The user's agent config must not be reachable through the overlay's agents/.
  assert.throws(() => readFileSync(join(home, "agents", "userthing.json"), "utf8"));
});

test("idempotent: re-seeding leaves links intact and refreshes the agent config", () => {
  const real = fakeKiro();
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: { name: KIRO_AGENT_NAME, v: 1 } });
  seedKiroHome({ kiroHome: home, realKiro: real, agentConfig: { name: KIRO_AGENT_NAME, v: 2 } });
  assert.equal(readlinkSync(join(home, "settings.json")), join(real, "settings.json"));
  const ours = JSON.parse(readFileSync(join(home, "agents", `${KIRO_AGENT_NAME}.json`), "utf8"));
  assert.equal(ours.v, 2);
});

test("tolerates a missing real ~/.kiro (fresh install) — still writes our agent", () => {
  const home = mkdtempSync(join(tmpdir(), "kiro-home-"));
  seedKiroHome({ kiroHome: home, realKiro: join(tmpdir(), "no-such-kiro-xyz"), agentConfig: CFG });
  const ours = JSON.parse(readFileSync(join(home, "agents", `${KIRO_AGENT_NAME}.json`), "utf8"));
  assert.equal(ours.name, KIRO_AGENT_NAME);
});
