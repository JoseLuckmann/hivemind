/**
 * Seed the EPHEMERAL kiro-cli KIRO_HOME overlay. kiro-cli reads its whole home
 * (agents, settings, skills, steering, sessions, session-index) from ~/.kiro, and
 * honors `KIRO_HOME` to relocate it wholesale — the exact FACTORY_HOME_OVERRIDE
 * seam droid uses. hivemind points kiro-cli at this hivemind-owned home (per
 * install) so it can inject a custom agent config (`agents/hivemind.json`) that
 * wires our deterministic-signal hooks + permissive tool rules, WITHOUT touching
 * the user's real ~/.kiro.
 *
 * The home must still look complete to kiro — auth/settings, the user's steering
 * and skills, AND crucially the `sessions/` + `session-index/` stores so
 * `--resume-id`/`--list-sessions` still find real history. So we SYMLINK every
 * child of the real ~/.kiro into `<kiroHome>` EXCEPT `agents/` (which we own: a
 * real dir holding just our hivemind.json — symlinking the whole dir would make
 * our config invisible, and per-file symlinks into it would let a stray write
 * corrupt the user's real agents). Reads/writes to sessions, settings, steering
 * flow through the symlinks into the canonical store, so login + resume stay
 * shared with the user's normal kiro usage; only agents/hivemind.json is ours.
 *
 * Idempotent: safe to call on every daemon start. Never deletes the real ~/.kiro.
 * Best-effort — a failure just means kiro falls back to its normal home (hooks
 * off; the screen-scrape detector still drives status).
 *
 * Caveat: if kiro replaces a symlinked top-level file via atomic write+rename
 * (e.g. a settings file), the new real file lands in the overlay and the
 * canonical file goes stale until the next re-seed. Acceptable — a re-seed
 * restores the link, and settings rarely change mid-session.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import {
  mkdirSync, readdirSync, symlinkSync, lstatSync, readlinkSync, writeFileSync, rmSync,
} from "node:fs";

// The one child hivemind OWNS in the overlay — a REAL directory (not a symlink to
// the user's ~/.kiro/agents) holding just our injected agent config. Everything
// else is symlinked to the canonical store.
const OWNED_DIR = "agents";
/** The agent selected via `kiro-cli chat --agent <name>` for hivemind tiles. */
export const KIRO_AGENT_NAME = "hivemind";

export interface SeedKiroHomeOpts {
  /** The KIRO_HOME target dir (populated with symlinks + our agents/ dir). */
  kiroHome: string;
  /** The hivemind.json agent-config contents (from kiroAgentConfig). */
  agentConfig: unknown;
  /** Override the real ~/.kiro dir (tests). Default ~/.kiro. */
  realKiro?: string;
}

/** Symlink every child of the real ~/.kiro into <kiroHome> except `agents/`, then
 *  write our `agents/hivemind.json`. Returns the KIRO_HOME value to export. */
export function seedKiroHome(opts: SeedKiroHomeOpts): string {
  const real = opts.realKiro ?? join(homedir(), ".kiro");
  mkdirSync(opts.kiroHome, { recursive: true });

  let children: import("node:fs").Dirent[] = [];
  try { children = readdirSync(real, { withFileTypes: true }); }
  catch { /* no real ~/.kiro yet (fresh kiro install) — just write our agent */ }

  for (const c of children) {
    if (c.name === OWNED_DIR) continue; // hivemind owns agents/ (written below)
    const link = join(opts.kiroHome, c.name);
    const target = join(real, c.name);
    try {
      // Already the right symlink? leave it. Wrong/stale link? replace it. A real
      // file/dir kiro wrote into the overlay? leave it (don't clobber).
      const st = lstatSync(link);
      if (st.isSymbolicLink()) {
        if (readlinkSync(link) === target) continue;
        rmSync(link, { force: true });
      } else {
        continue;
      }
    } catch { /* not present → create below */ }
    try { symlinkSync(target, link); } catch { /* best-effort */ }
  }

  // Our owned agents/ dir: a real directory holding just hivemind.json. We do NOT
  // symlink the user's real agents in — kiro discovers global agents from this
  // dir, and `--agent hivemind` only needs ours. (The user's project-local
  // `.kiro/agents/` are still discovered from the cwd, unaffected.)
  const agentsDir = join(opts.kiroHome, OWNED_DIR);
  try {
    // If a stale symlink sits where our real dir must be, drop it first.
    const st = lstatSync(agentsDir);
    if (st.isSymbolicLink()) rmSync(agentsDir, { force: true });
  } catch { /* not present */ }
  try {
    mkdirSync(agentsDir, { recursive: true });
    writeFileSync(join(agentsDir, `${KIRO_AGENT_NAME}.json`), JSON.stringify(opts.agentConfig, null, 2));
  } catch { /* best-effort */ }

  return opts.kiroHome;
}
