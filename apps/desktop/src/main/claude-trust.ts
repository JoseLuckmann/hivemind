/**
 * claude-trust — pre-accept Claude Code's per-directory "Do you trust the files
 * in this folder?" dialog for a tile's cwd.
 *
 * THE BUG THIS EXISTS FOR: on a folder claude hasn't seen before, `claude` opens
 * to a blocking workspace-trust screen ("❯ 1. Yes, I trust this folder  2. No,
 * exit") and waits for a keypress. Inside a hivemind tile the agent therefore
 * never reaches its input prompt — it sits "working" forever. `codex` has no such
 * screen, which is exactly why codex tiles work and claude tiles hang. The trust
 * screen is NOT bypassed by `--dangerously-skip-permissions` (anthropics/claude-
 * code#28506); acceptance is stored per-directory as `hasTrustDialogAccepted`
 * under `projects` in `~/.claude.json`.
 *
 * The user already expressed trust by opening that repo/worktree in hivemind and
 * spawning an agent into it, so we record that consent proactively — the same
 * write claude itself makes when the user picks "Yes". Pure merge: we read the
 * existing file, set ONLY `projects[dir].hasTrustDialogAccepted = true` (creating
 * the project entry if absent), and write it back untouched otherwise. Never
 * throws — a trust write is best-effort; if it fails the worst case is the old
 * behavior (the dialog appears).
 */
import path from "node:path";
import os from "node:os";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";

/** Path to the user's global claude config. Overridable via CLAUDE_CONFIG_DIR
 *  (claude's own env) so a custom config location is honored, else ~/.claude.json. */
export function claudeConfigPath(env: NodeJS.ProcessEnv = process.env): string {
  const dir = env.CLAUDE_CONFIG_DIR?.trim();
  if (dir) return path.join(dir, ".claude.json");
  return path.join(env.HOME || os.homedir(), ".claude.json");
}

/** Compute the merged config that marks `dir` trusted, given the current parsed
 *  config object (or null/invalid → start fresh). PURE — no I/O — so it's unit-
 *  testable. Returns null when nothing needs to change (already trusted), so the
 *  caller can skip the write. */
export function withTrustedDir(
  current: unknown,
  dir: string,
): Record<string, unknown> | null {
  const cfg: Record<string, unknown> =
    current && typeof current === "object" ? { ...(current as Record<string, unknown>) } : {};
  const projects: Record<string, Record<string, unknown>> =
    cfg.projects && typeof cfg.projects === "object"
      ? { ...(cfg.projects as Record<string, Record<string, unknown>>) }
      : {};
  const existing = projects[dir] && typeof projects[dir] === "object" ? projects[dir] : {};
  if (existing.hasTrustDialogAccepted === true) return null; // already trusted → no write
  projects[dir] = { ...existing, hasTrustDialogAccepted: true };
  cfg.projects = projects;
  return cfg;
}

/** Ensure `dir` is a trusted claude workspace so a spawned `claude` never blocks
 *  on the trust dialog. Best-effort + idempotent; swallows all errors. `dir` must
 *  be an ABSOLUTE local path (claude keys projects by absolute path). */
export function ensureClaudeTrust(dir: string, env: NodeJS.ProcessEnv = process.env): void {
  try {
    if (!dir || !path.isAbsolute(dir)) return;
    const file = claudeConfigPath(env);
    let current: unknown = null;
    if (existsSync(file)) {
      try { current = JSON.parse(readFileSync(file, "utf8")); } catch { current = null; }
    }
    const next = withTrustedDir(current, dir);
    if (!next) return; // already trusted
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* best-effort: if we can't write, the dialog reappears — no worse than before */
  }
}
