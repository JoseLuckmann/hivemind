/**
 * `hive summon` / `hive unsummon` — project a catalog resource into a workspace
 * (P0: claude). Symlinks agents/skills, merges mcp, auto-gitignores, and records
 * an out-of-repo ledger. `hive summon list` shows global (summoned) vs local
 * (repo-authored) resources in the current workspace.
 *
 * Target resolution (`--to`): a registry prefix, or a repo/worktree path.
 * Default target is the current workspace (parent of the nearest .hivemind/).
 */
import { defineCommand } from "citty";
import path from "node:path";
import { promises as fs } from "node:fs";
import {
  findRoot,
  resolveResource,
  resolveWorkspaceByPrefix,
  summon,
  summonList,
  unsummon,
  type Cli,
} from "@hivemind/core";
import { err, ok } from "../format.js";

const VALID_CLIS: Cli[] = ["claude", "kiro", "codex"];

/** Validate a --cli flag; defaults to claude. Calls err() (which exits) on bad input. */
function parseCli(v: unknown, ctx: { json: boolean }): Cli {
  if (v === undefined) return "claude";
  const s = String(v);
  if ((VALID_CLIS as string[]).includes(s)) return s as Cli;
  return err(ctx, "bad_cli", `--cli must be one of ${VALID_CLIS.join(" | ")} (got: ${s})`);
}

/** Resolve the target repo dir from `--to` (prefix or path) or the cwd. */
async function resolveTarget(to: string | undefined): Promise<string | null> {
  if (to) {
    // A registered workspace prefix?
    const ws = await resolveWorkspaceByPrefix(to.toUpperCase());
    if (ws) return ws.repo;
    // Else treat as a path (repo dir or a dir under it).
    const abs = path.resolve(to);
    try {
      if ((await fs.stat(abs)).isDirectory()) {
        const root = await findRoot(abs);
        return root ? path.dirname(root) : abs;
      }
    } catch {
      return null;
    }
    return null;
  }
  const root = await findRoot(process.cwd());
  return root ? path.dirname(root) : null;
}

async function runSummonList(ctx: { json: boolean }, to: string | undefined): Promise<void> {
  const repo = await resolveTarget(to);
  if (!repo) return err(ctx, "no_workspace", "no target workspace found");
  const view = await summonList(repo);
  return ok(ctx, view, () => {
    const lines: string[] = [];
    lines.push("Summoned (global references):");
    if (view.summoned.length === 0) lines.push("  (none)");
    else for (const e of view.summoned) lines.push(`  ${e.kind.padEnd(5)}  ${e.resource}  [${e.cli}, ${e.mode}]`);
    lines.push("");
    lines.push("Local (this repo):");
    if (view.local.length === 0) lines.push("  (none)");
    else for (const l of view.local) lines.push(`  ${l.kind.padEnd(5)}  ${l.name}`);
    return lines.join("\n");
  });
}

export const summonCmd = defineCommand({
  meta: {
    name: "summon",
    description: "Summon a catalog resource into a workspace (claude). `summon list` shows what's here.",
  },
  args: {
    name: { type: "positional", description: "Resource name, or `list`", required: false },
    to: { type: "string", description: "Target workspace (prefix or path); default cwd" },
    cli: { type: "string", description: "Target CLI: claude (default) | kiro | codex" },
    global: { type: "boolean", description: "Summon into the CLI's machine-global scope (~/.claude etc.)" },
    copy: { type: "boolean", description: "Copy files instead of symlinking (forced for remote targets)" },
    json: { type: "boolean", description: "Emit JSON" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    // `hive summon list` — a positional pseudo-subcommand (kept as a positional
    // so `hive summon <name>` doesn't trip citty's unknown-command guard).
    if (String(args.name) === "list") {
      return runSummonList(ctx, args.to ? String(args.to) : undefined);
    }
    if (!args.name) {
      return err(ctx, "missing_name", "usage: hive summon <resource> [--to <ws>] [--cli claude|kiro|codex] [--global] [--copy]  |  hive summon list");
    }
    const cli = parseCli(args.cli, ctx);
    const scope = args.global ? "global" : "project";
    try {
      // Global scope doesn't need a repo (it targets ~/.<cli>); still resolve a
      // workspace for project scope. For global, cwd is a harmless ledger anchor.
      const repo =
        (await resolveTarget(args.to ? String(args.to) : undefined)) ??
        (scope === "global" ? process.cwd() : null);
      if (!repo) return err(ctx, "no_workspace", "no target workspace found (pass --to <prefix|path>)");
      const resource = await resolveResource(String(args.name));
      const res = await summon({ resource, workspaceRoot: repo, cli, scope, copy: !!args.copy });
      return ok(ctx, { ...res, workspace: repo }, () =>
        [
          `✓ summoned ${res.kind}/${res.resource} into ${res.scope === "global" ? `${res.cli} global scope` : repo}`,
          `  cli:   ${res.cli}`,
          `  scope: ${res.scope}`,
          `  mode:  ${res.mode}`,
          `  target: ${res.targets.join(", ")}`,
          res.gitignoreChanged ? `  .gitignore updated (not versioned)` : ``,
        ].filter(Boolean).join("\n"),
      );
    } catch (e) {
      return err(ctx, (e as { code?: string }).code ?? "summon_failed", (e as Error).message);
    }
  },
});

export const unsummonCmd = defineCommand({
  meta: {
    name: "unsummon",
    description: "Remove a summoned resource from a workspace",
  },
  args: {
    name: { type: "positional", description: "Resource name", required: true },
    from: { type: "string", description: "Target workspace (prefix or path); default cwd" },
    cli: { type: "string", description: "Target CLI: claude (default) | kiro | codex" },
    global: { type: "boolean", description: "Remove from the CLI's machine-global scope" },
    json: { type: "boolean", description: "Emit JSON" },
  },
  async run({ args }) {
    const ctx = { json: !!args.json };
    const cli = parseCli(args.cli, ctx);
    const scope = args.global ? "global" : "project";
    try {
      const repo =
        (await resolveTarget(args.from ? String(args.from) : undefined)) ??
        (scope === "global" ? process.cwd() : null);
      if (!repo) return err(ctx, "no_workspace", "no target workspace found");
      const removed = await unsummon({ resourceName: String(args.name), workspaceRoot: repo, cli, scope });
      return ok(ctx, { removed, scope }, () =>
        removed
          ? `✓ unsummoned ${args.name} (${scope})`
          : `nothing to unsummon (${args.name} not summoned here)`,
      );
    } catch (e) {
      return err(ctx, (e as { code?: string }).code ?? "unsummon_failed", (e as Error).message);
    }
  },
});
