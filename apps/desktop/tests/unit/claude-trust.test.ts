import { test } from "node:test";
import assert from "node:assert/strict";
import { withTrustedDir, claudeConfigPath } from "../../src/main/claude-trust.ts";

test("withTrustedDir marks a brand-new dir trusted on an empty config", () => {
  const next = withTrustedDir(null, "/repo/a");
  assert.ok(next);
  assert.equal((next!.projects as any)["/repo/a"].hasTrustDialogAccepted, true);
});

test("withTrustedDir preserves other top-level keys and other projects", () => {
  const current = {
    userID: "u123",
    numStartups: 7,
    projects: {
      "/repo/other": { hasTrustDialogAccepted: false, allowedTools: ["Bash"] },
    },
  };
  const next = withTrustedDir(current, "/repo/a")!;
  // untouched top-level
  assert.equal(next.userID, "u123");
  assert.equal(next.numStartups, 7);
  // other project preserved verbatim
  assert.deepEqual((next.projects as any)["/repo/other"], {
    hasTrustDialogAccepted: false,
    allowedTools: ["Bash"],
  });
  // target now trusted
  assert.equal((next.projects as any)["/repo/a"].hasTrustDialogAccepted, true);
});

test("withTrustedDir keeps an existing project's OTHER fields, flips only the flag", () => {
  const current = {
    projects: {
      "/repo/a": { hasTrustDialogAccepted: false, mcpServers: { x: 1 }, allowedTools: ["Read"] },
    },
  };
  const next = withTrustedDir(current, "/repo/a")!;
  assert.deepEqual((next.projects as any)["/repo/a"], {
    hasTrustDialogAccepted: true,
    mcpServers: { x: 1 },
    allowedTools: ["Read"],
  });
});

test("withTrustedDir returns null (no write needed) when already trusted", () => {
  const current = { projects: { "/repo/a": { hasTrustDialogAccepted: true } } };
  assert.equal(withTrustedDir(current, "/repo/a"), null);
});

test("withTrustedDir tolerates a malformed config (non-object) by starting fresh", () => {
  const next = withTrustedDir("not-an-object", "/repo/a")!;
  assert.equal((next.projects as any)["/repo/a"].hasTrustDialogAccepted, true);
});

test("withTrustedDir tolerates a non-object projects field", () => {
  const next = withTrustedDir({ projects: "garbage" }, "/repo/a")!;
  assert.equal((next.projects as any)["/repo/a"].hasTrustDialogAccepted, true);
});

test("claudeConfigPath honors CLAUDE_CONFIG_DIR, else HOME/.claude.json", () => {
  assert.equal(claudeConfigPath({ CLAUDE_CONFIG_DIR: "/custom/dir" } as any), "/custom/dir/.claude.json");
  assert.equal(claudeConfigPath({ HOME: "/home/u" } as any), "/home/u/.claude.json");
});
