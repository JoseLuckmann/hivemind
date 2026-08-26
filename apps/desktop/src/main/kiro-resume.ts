/**
 * Kiro CLI session resume. kiro-cli stores sessions in a SQLite database at
 * ~/.kiro/, scoped by working directory. It exposes `--resume` to resume the
 * most recent session for the current cwd — no session id scanning needed (the
 * CLI resolves it internally). For explicit id-based resume, `--resume-id <ID>`
 * is available, but since kiro doesn't expose a scannable session store (SQLite,
 * not flat files), the simplest and most correct approach is `--resume` which
 * picks up the latest session for the cwd automatically.
 *
 * No spawn-time binding (kiro generates its own session id). No hook system
 * exposed. Status is screen-scrape only (agent-state.ts `detectKiro`).
 */
import { basename } from "node:path";
import type { SpawnSpec } from "./pty-session-manager.js";

export function isKiro(spec: { cmd: string }): boolean {
  const bin = basename(spec.cmd.trim().split(/\s+/)[0] ?? "");
  return bin === "kiro-cli" || bin === "kiro";
}

export interface KiroResumeTransforms {
  transformSpecOnRestore: (spec: SpawnSpec, id: string) => SpawnSpec;
  restoreRetryTransform: (spec: SpawnSpec) => SpawnSpec | null;
}

export function makeKiroResumeTransforms(): KiroResumeTransforms {
  return {
    transformSpecOnRestore: (spec) => {
      if (!isKiro(spec)) return spec;
      const args = spec.args ?? [];
      // Already has a resume flag — leave it alone.
      if (args.includes("--resume") || args.includes("--resume-id")) return spec;
      // kiro-cli chat --resume resumes the most recent session for the cwd.
      // If `chat` is already in the args, inject --resume after it; otherwise
      // prepend `chat --resume` (bare `kiro-cli` defaults to chat anyway, but
      // being explicit avoids ambiguity with other subcommands).
      const chatIdx = args.indexOf("chat");
      if (chatIdx >= 0) {
        const before = args.slice(0, chatIdx + 1);
        const after = args.slice(chatIdx + 1);
        return { ...spec, args: [...before, "--resume", ...after] };
      }
      return { ...spec, args: ["chat", "--resume", ...args] };
    },
    // If `kiro-cli chat --resume` dies fast (no session to resume), strip the
    // resume flag and respawn fresh so a missing session doesn't kill the tile.
    restoreRetryTransform: (spec) => {
      if (!isKiro(spec)) return null;
      const args = spec.args ?? [];
      const i = args.indexOf("--resume");
      if (i < 0) return null;
      return { ...spec, args: [...args.slice(0, i), ...args.slice(i + 1)] };
    },
  };
}
