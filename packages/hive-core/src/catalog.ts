/**
 * Agent Catalog — a single machine-global home for reusable *resources*
 * (agent contracts, skills, MCP server definitions) that you author once and
 * `summon` into any workspace on demand. Design: docs/design/agent-catalog.md.
 *
 * Layout (alongside registry.json, honoring $XDG_CONFIG_HOME):
 *
 *   ~/.config/hivemind/catalog/
 *   ├── agents/<name>/  { agent.md,  resource.yaml }
 *   ├── skills/<name>/  { SKILL.md,  resource.yaml }
 *   ├── mcps/<name>/    { resource.yaml (holds the mcpServers fragment) }
 *   └── summons.json    <- ledger: workspaceRoot -> projections (OUT of the repo)
 *
 * Projection model (P0 = claude only):
 *   - agent  -> symlink  <repo>/.claude/agents/<name>.md      -> catalog agent.md
 *   - skill  -> symlink  <repo>/.claude/skills/<name>         -> catalog skill dir
 *   - mcp    -> marked merge into <repo>/.mcp.json mcpServers (reversible)
 *
 * Summoned material is never committed: we ensure `.gitignore` lines in the
 * target repo. The ledger lives OUT of the target repo so it stays 100% clean.
 */

import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import YAML from "yaml";
import { z } from "zod";
import { HiveError } from "./storage.js";

// ── paths ────────────────────────────────────────────────────────────────

/** Root of the catalog dir, honoring `$XDG_CONFIG_HOME` (same base as the
 *  workspace registry, so CLI + app + MCP all agree). */
export function catalogRoot(): string {
  const base = process.env.XDG_CONFIG_HOME?.trim() || path.join(os.homedir(), ".config");
  return path.join(base, "hivemind", "catalog");
}

/** Ledger file path (out of any target repo). */
export function ledgerPath(): string {
  return path.join(catalogRoot(), "summons.json");
}

// ── kinds & schemas ────────────────────────────────────────────────────────

export const ResourceKindZ = z.enum(["agent", "skill", "mcp"]);
export type ResourceKind = z.infer<typeof ResourceKindZ>;

/** The subdirectory each kind lives under in the catalog. */
const KIND_DIR: Record<ResourceKind, string> = {
  agent: "agents",
  skill: "skills",
  mcp: "mcps",
};

/** Which CLIs a resource can be summoned into. P0 fully supports `claude`;
 *  the others are recorded for P1 projectors. */
export const CliZ = z.enum(["claude", "kiro", "codex"]);
export type Cli = z.infer<typeof CliZ>;

/** A single MCP server fragment (command/args/env or url/headers). Kept loose
 *  on purpose — different CLIs accept slightly different shapes; we merge it
 *  verbatim into the target's mcpServers map under the resource name. */
export const McpServerZ = z.record(z.string(), z.unknown());

/** `resource.yaml` — the small manifest beside each canonical file. */
export const ResourceManifestZ = z.object({
  kind: ResourceKindZ,
  /** Human title for pickers; defaults to the name. */
  title: z.string().optional(),
  tags: z.array(z.string()).default([]),
  /** CLIs this resource declares support for. Empty = all supported. */
  clis: z.array(CliZ).default([]),
  /** For kind=mcp: the server fragment merged into the target mcpServers map. */
  mcpServer: McpServerZ.optional(),
  /** For kind=agent: names of catalog skills associated with this agent, so
   *  summoning/spawning the agent also brings its skills. */
  skills: z.array(z.string()).default([]),
  /** For kind=agent: names of catalog mcps associated with this agent. */
  mcps: z.array(z.string()).default([]),
});
export type ResourceManifest = z.infer<typeof ResourceManifestZ>;

/** A resource as loaded from disk (manifest + resolved paths). */
export interface Resource {
  name: string;
  kind: ResourceKind;
  title: string;
  tags: string[];
  clis: Cli[];
  /** Absolute path to the resource's directory in the catalog. */
  dir: string;
  /** Absolute path to the canonical editable file (agent.md / SKILL.md), or
   *  null for mcp resources (which have no standalone file). */
  canonicalFile: string | null;
  mcpServer?: Record<string, unknown>;
  /** agent-only: associated catalog skill/mcp names. */
  skills: string[];
  mcps: string[];
}

// ── ledger schema ──────────────────────────────────────────────────────────

export const SummonModeZ = z.enum(["symlink", "merge", "copy"]);
export type SummonMode = z.infer<typeof SummonModeZ>;

export const SummonEntryZ = z.object({
  resource: z.string(),
  kind: ResourceKindZ,
  cli: CliZ,
  mode: SummonModeZ,
  /** project (into a repo) or global (the CLI's ~/. dir). Defaults to project
   *  for ledgers written before P3. */
  scope: z.enum(["project", "global"]).default("project"),
  /** Absolute paths this projection created/touched (symlink path, or the
   *  JSON/TOML file for a merge). Used by unsummon to reverse exactly. */
  targets: z.array(z.string()),
  summonedAt: z.string(),
});
export type SummonEntry = z.infer<typeof SummonEntryZ>;

const LedgerZ = z.object({
  version: z.literal(1),
  /** workspaceRoot (repo path) -> its projections. */
  workspaces: z.record(z.string(), z.array(SummonEntryZ)),
});
type Ledger = z.infer<typeof LedgerZ>;

// ── atomic write helper (same technique as writeConfig) ─────────────────────

async function writeFileAtomic(p: string, data: string): Promise<void> {
  await fs.mkdir(path.dirname(p), { recursive: true });
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data, "utf8");
  await fs.rename(tmp, p);
}

// ── name validation ──────────────────────────────────────────────────────

const NAME_RE = /^[a-z0-9][a-z0-9-]*$/;

/** Validate a resource name (safe as a path segment; lowercase kebab). */
export function assertValidName(name: string): void {
  if (!NAME_RE.test(name)) {
    throw new HiveError(
      "bad_name",
      `resource name must be lowercase kebab-case (got: ${name})`,
    );
  }
}

// ── catalog CRUD ───────────────────────────────────────────────────────────

/** The canonical filename for a resource of the given kind (null for mcp). */
function canonicalFileName(kind: ResourceKind): string | null {
  if (kind === "agent") return "agent.md";
  if (kind === "skill") return "SKILL.md";
  return null; // mcp lives entirely in resource.yaml
}

function resourceDir(kind: ResourceKind, name: string): string {
  return path.join(catalogRoot(), KIND_DIR[kind], name);
}

/** Read + parse the manifest for a resource dir. */
async function readManifest(dir: string): Promise<ResourceManifest> {
  const raw = await fs.readFile(path.join(dir, "resource.yaml"), "utf8");
  return ResourceManifestZ.parse(YAML.parse(raw));
}

/** Load one resource by kind+name. Throws HiveError("not_found") if absent. */
export async function getResource(kind: ResourceKind, name: string): Promise<Resource> {
  const dir = resourceDir(kind, name);
  let manifest: ResourceManifest;
  try {
    manifest = await readManifest(dir);
  } catch {
    throw new HiveError("not_found", `resource ${kind}/${name} not found in catalog`);
  }
  const fileName = canonicalFileName(kind);
  return {
    name,
    kind,
    title: manifest.title ?? name,
    tags: manifest.tags,
    clis: manifest.clis.length > 0 ? manifest.clis : [...CliZ.options],
    dir,
    canonicalFile: fileName ? path.join(dir, fileName) : null,
    mcpServer: manifest.mcpServer,
    skills: manifest.skills,
    mcps: manifest.mcps,
  };
}

/** Update an agent's associated skills/mcps in its manifest. Only meaningful
 *  for kind=agent. Idempotent; rewrites resource.yaml preserving other fields. */
export async function setAgentAssociations(
  name: string,
  assoc: { skills?: string[]; mcps?: string[] },
): Promise<Resource> {
  const dir = resourceDir("agent", name);
  let manifest: ResourceManifest;
  try {
    manifest = await readManifest(dir);
  } catch {
    throw new HiveError("not_found", `agent ${name} not found in catalog`);
  }
  const next: ResourceManifest = {
    ...manifest,
    skills: assoc.skills ?? manifest.skills,
    mcps: assoc.mcps ?? manifest.mcps,
  };
  await writeFileAtomic(path.join(dir, "resource.yaml"), YAML.stringify(ResourceManifestZ.parse(next)));
  return getResource("agent", name);
}

/** Resolve a resource by name alone, searching all kinds. Errors if the name
 *  is ambiguous across kinds or missing. */
export async function resolveResource(name: string): Promise<Resource> {
  const found: Resource[] = [];
  for (const kind of ResourceKindZ.options) {
    try {
      found.push(await getResource(kind, name));
    } catch {
      /* not this kind */
    }
  }
  if (found.length === 0) {
    throw new HiveError("not_found", `no catalog resource named "${name}"`);
  }
  if (found.length > 1) {
    const kinds = found.map((r) => r.kind).join(", ");
    throw new HiveError(
      "ambiguous",
      `"${name}" exists as multiple kinds (${kinds}); specify one`,
    );
  }
  return found[0]!;
}

/** List every resource in the catalog, sorted by kind then name. */
export async function listResources(): Promise<Resource[]> {
  const out: Resource[] = [];
  for (const kind of ResourceKindZ.options) {
    const base = path.join(catalogRoot(), KIND_DIR[kind]);
    let names: string[];
    try {
      names = (await fs.readdir(base, { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
    } catch {
      continue; // kind dir doesn't exist yet
    }
    for (const name of names.sort()) {
      try {
        out.push(await getResource(kind, name));
      } catch {
        /* skip malformed */
      }
    }
  }
  return out;
}

/** Create a new resource, scaffolding a canonical file + manifest. Refuses to
 *  clobber an existing one. Returns the created Resource. */
export async function createResource(opts: {
  kind: ResourceKind;
  name: string;
  title?: string;
  tags?: string[];
  clis?: Cli[];
  mcpServer?: Record<string, unknown>;
}): Promise<Resource> {
  assertValidName(opts.name);
  const dir = resourceDir(opts.kind, opts.name);
  try {
    await fs.stat(dir);
    throw new HiveError("exists", `resource ${opts.kind}/${opts.name} already exists`);
  } catch (e) {
    if (e instanceof HiveError) throw e;
    /* absent → good */
  }

  await fs.mkdir(dir, { recursive: true });

  const manifest: ResourceManifest = {
    kind: opts.kind,
    title: opts.title ?? opts.name,
    tags: opts.tags ?? [],
    clis: opts.clis ?? [],
    skills: [],
    mcps: [],
    ...(opts.kind === "mcp"
      ? { mcpServer: opts.mcpServer ?? { command: "echo", args: ["configure me"] } }
      : {}),
  };
  await writeFileAtomic(
    path.join(dir, "resource.yaml"),
    YAML.stringify(ResourceManifestZ.parse(manifest)),
  );

  const fileName = canonicalFileName(opts.kind);
  if (fileName) {
    await writeFileAtomic(path.join(dir, fileName), scaffoldFor(opts.kind, opts.name));
  }

  return getResource(opts.kind, opts.name);
}

/** A minimal starter body so authoring is fill-in-the-blanks. */
function scaffoldFor(kind: ResourceKind, name: string): string {
  if (kind === "skill") {
    return [
      "---",
      `name: ${name}`,
      `description: TODO one-line description of when to use this skill`,
      "---",
      "",
      `# ${name}`,
      "",
      "## When to use",
      "",
      "TODO",
      "",
      "## Procedure",
      "",
      "TODO",
      "",
    ].join("\n");
  }
  // agent
  return [
    "---",
    `name: ${name}`,
    `description: TODO one-line description of this agent's role`,
    "---",
    "",
    `# ${name}`,
    "",
    "TODO: the agent's system prompt / contract.",
    "",
  ].join("\n");
}

/** Delete a resource from the catalog. Does NOT unsummon existing projections
 *  (callers should unsummon first). Idempotent-ish: errors if missing. */
export async function removeResource(kind: ResourceKind, name: string): Promise<void> {
  const dir = resourceDir(kind, name);
  try {
    await fs.rm(dir, { recursive: true, force: true });
  } catch {
    throw new HiveError("not_found", `resource ${kind}/${name} not found`);
  }
}

// ── ledger ─────────────────────────────────────────────────────────────────

async function readLedger(): Promise<Ledger> {
  try {
    const raw = await fs.readFile(ledgerPath(), "utf8");
    const parsed = LedgerZ.safeParse(JSON.parse(raw));
    if (parsed.success) return parsed.data;
  } catch {
    /* missing or corrupt → fresh */
  }
  return { version: 1, workspaces: {} };
}

async function writeLedger(led: Ledger): Promise<void> {
  await writeFileAtomic(ledgerPath(), JSON.stringify(led, null, 2) + "\n");
}

/** Entries recorded for a given workspace root (empty if none). */
/** Resolve a ledger key: the global sentinel passes through unchanged, a repo
 *  path is normalized to an absolute path. */
function resolveLedgerKey(key: string): string {
  return key === GLOBAL_LEDGER_KEY ? GLOBAL_LEDGER_KEY : path.resolve(key);
}

export async function ledgerFor(workspaceRoot: string): Promise<SummonEntry[]> {
  const led = await readLedger();
  return led.workspaces[resolveLedgerKey(workspaceRoot)] ?? [];
}

async function recordSummon(workspaceRoot: string, entry: SummonEntry): Promise<void> {
  const key = resolveLedgerKey(workspaceRoot);
  const led = await readLedger();
  const list = led.workspaces[key] ?? [];
  // Replace any prior projection of the same resource+cli+scope (idempotent
  // re-summon; project and global of the same resource coexist).
  const filtered = list.filter(
    (e) => !(e.resource === entry.resource && e.cli === entry.cli && e.scope === entry.scope),
  );
  filtered.push(entry);
  led.workspaces[key] = filtered;
  await writeLedger(led);
}

async function forgetSummon(
  workspaceRoot: string,
  resource: string,
  cli: Cli,
): Promise<SummonEntry | null> {
  const key = resolveLedgerKey(workspaceRoot);
  const led = await readLedger();
  const list = led.workspaces[key] ?? [];
  const idx = list.findIndex((e) => e.resource === resource && e.cli === cli);
  if (idx < 0) return null;
  const [removed] = list.splice(idx, 1);
  if (list.length > 0) led.workspaces[key] = list;
  else delete led.workspaces[key];
  await writeLedger(led);
  return removed ?? null;
}

// ── gitignore automation ─────────────────────────────────────────────────

const GITIGNORE_HEADER =
  "# hivemind: summoned agent-catalog resources (symlinks/merges — not versioned)";

/** Append any missing ignore lines for a CLI to `<repo>/.gitignore`. Idempotent.
 *  `gitignoreLinesFor(cli)` supplies the CLI-specific paths. */
export async function ensureGitignore(workspaceRoot: string, cli: Cli = "claude"): Promise<boolean> {
  const giPath = path.join(workspaceRoot, ".gitignore");
  let gi = "";
  try {
    gi = await fs.readFile(giPath, "utf8");
  } catch {
    /* none yet */
  }
  const have = new Set(gi.split("\n").map((l) => l.trim()));
  const wanted = [GITIGNORE_HEADER, ...gitignoreLinesFor(cli)];
  const missing = wanted.filter((l) => !have.has(l.trim()));
  if (missing.length === 0) return false;
  const prefix = gi.length === 0 || gi.endsWith("\n") ? gi : gi + "\n";
  await fs.writeFile(giPath, prefix + missing.join("\n") + "\n", "utf8");
  return true;
}

// ── projection: per-CLI on-disk layout ────────────────────────────────────
//
// Confirmed layouts (docs): claude reads .claude/{agents,skills} + .mcp.json;
// kiro reads .kiro/{agents,skills} + .kiro/settings/mcp.json and — crucially —
// CLI 3.0 accepts a Markdown agent file (frontmatter=config, body=prompt), so
// the canonical agent.md/SKILL.md symlink into kiro unchanged; codex has NO
// per-agent/skill files (it reads AGENTS.md) and stores MCP as TOML in
// config.toml, so both project as reversible marked merges.
//
// Every CLI also has a GLOBAL scope in $HOME (~/.claude, ~/.kiro, ~/.codex),
// so a resource can be projected machine-wide (scope="global") instead of into
// one repo (scope="project"). Kiro honors $KIRO_HOME for its global dir.

/** Where a summon projects: into one repo, or the CLI's machine-global dir. */
export const SummonScopeZ = z.enum(["project", "global"]);
export type SummonScope = z.infer<typeof SummonScopeZ>;

/** The CLI's machine-global config dir (the `.claude`/`.kiro`/`.codex` parent
 *  contents live directly under it). Kiro honors $KIRO_HOME. Reads $HOME
 *  directly (not the start-time-cached os.homedir()) so it always reflects the
 *  current environment. */
function homeDir(): string {
  return process.env.HOME?.trim() || os.homedir();
}
export function cliGlobalRoot(cli: Cli): string {
  const home = homeDir();
  if (cli === "kiro") {
    const kh = process.env.KIRO_HOME?.trim();
    return kh || path.join(home, ".kiro");
  }
  if (cli === "codex") return path.join(home, ".codex");
  return path.join(home, ".claude");
}

/** Symlink projection target for agent/skill. `scope` picks the repo's dotdir
 *  (project) or the CLI's global dir. Returns null for kinds that don't
 *  symlink (mcp, or codex anything). */
function symlinkTarget(
  workspaceRoot: string,
  cli: Cli,
  r: Resource,
  scope: SummonScope,
): string | null {
  if (cli === "codex") return null; // codex: no symlinked resources
  // project: <repo>/.claude|.kiro ; global: ~/.claude | $KIRO_HOME
  const base = scope === "global" ? cliGlobalRoot(cli) : path.join(workspaceRoot, cli === "kiro" ? ".kiro" : ".claude");
  if (r.kind === "agent") return path.join(base, "agents", `${r.name}.md`);
  if (r.kind === "skill") return path.join(base, "skills", r.name);
  return null;
}

/** The .gitignore lines to ensure for a given CLI (so summoned refs/merges
 *  aren't committed). */
function gitignoreLinesFor(cli: Cli): string[] {
  switch (cli) {
    case "claude":
      return [".claude/agents/", ".claude/skills/"];
    case "kiro":
      return [".kiro/agents/", ".kiro/skills/"];
    case "codex":
      // AGENTS.md is often committed by the user; only the codex MCP config is
      // ours to ignore. AGENTS.md merges are marker-wrapped, not gitignored.
      return [".codex/"];
  }
}

/** Create/replace a symlink at `linkPath` pointing to `target`. Idempotent —
 *  if the correct symlink already exists it's a no-op. Refuses to overwrite a
 *  NON-symlink (a real file the user authored). */
async function ensureSymlink(linkPath: string, target: string): Promise<void> {
  await fs.mkdir(path.dirname(linkPath), { recursive: true });
  try {
    const st = await fs.lstat(linkPath);
    if (st.isSymbolicLink()) {
      const cur = await fs.readlink(linkPath);
      if (path.resolve(path.dirname(linkPath), cur) === path.resolve(target)) return;
      await fs.rm(linkPath);
    } else {
      throw new HiveError(
        "occupied",
        `${linkPath} exists and is not a symlink — refusing to overwrite a local resource`,
      );
    }
  } catch (e) {
    if (e instanceof HiveError) throw e;
    /* absent → create below */
  }
  await fs.symlink(path.resolve(target), linkPath);
}

/** Copy a file or directory from `src` to `dest` (recursive). Used by `--copy`
 *  and forced for remote targets where a symlink into the local catalog can't
 *  resolve. Overwrites an existing copy (idempotent re-summon). Refuses to
 *  clobber a symlink we don't own is unnecessary here — copy targets are ours. */
async function copyRecursive(src: string, dest: string): Promise<void> {
  await fs.mkdir(path.dirname(dest), { recursive: true });
  await fs.rm(dest, { recursive: true, force: true });
  await fs.cp(src, dest, { recursive: true });
}

// ── mcp merge into a JSON mcpServers map (claude .mcp.json / kiro mcp.json) ──

interface McpJson {
  mcpServers?: Record<string, unknown>;
}

/** The JSON file that holds `mcpServers` for a CLI, or null if that CLI uses
 *  TOML (codex). `scope` picks the repo's file or the CLI's global file. */
function mcpJsonPath(workspaceRoot: string, cli: Cli, scope: SummonScope): string | null {
  if (cli === "claude") {
    return scope === "global"
      ? path.join(homeDir(), ".claude.json") // claude's global mcp config
      : path.join(workspaceRoot, ".mcp.json");
  }
  if (cli === "kiro") {
    return scope === "global"
      ? path.join(cliGlobalRoot("kiro"), "settings", "mcp.json")
      : path.join(workspaceRoot, ".kiro", "settings", "mcp.json");
  }
  return null; // codex → TOML
}

async function mergeMcpJson(mcpPath: string, r: Resource): Promise<void> {
  let doc: McpJson = {};
  try {
    doc = JSON.parse(await fs.readFile(mcpPath, "utf8")) as McpJson;
  } catch {
    /* fresh */
  }
  doc.mcpServers = { ...(doc.mcpServers ?? {}), [r.name]: r.mcpServer };
  await writeFileAtomic(mcpPath, JSON.stringify(doc, null, 2) + "\n");
}

async function unmergeMcpJson(mcpPath: string, name: string): Promise<void> {
  let doc: McpJson;
  try {
    doc = JSON.parse(await fs.readFile(mcpPath, "utf8")) as McpJson;
  } catch {
    return;
  }
  if (doc.mcpServers && name in doc.mcpServers) {
    delete doc.mcpServers[name];
    await writeFileAtomic(mcpPath, JSON.stringify(doc, null, 2) + "\n");
  }
}

// ── codex: marker-wrapped merges (AGENTS.md prose + config.toml TOML) ────────
//
// Codex has no per-resource files. An agent/skill projects as a marker-wrapped
// section in AGENTS.md; an mcp projects as a marker-wrapped `[mcp_servers.<n>]`
// block in .codex/config.toml. Markers make both idempotent & reversible.

function codexMarkers(name: string): { start: string; end: string } {
  return {
    start: `<!-- hivemind:resource:${name}:start -->`,
    end: `<!-- hivemind:resource:${name}:end -->`,
  };
}
function tomlMarkers(name: string): { start: string; end: string } {
  return {
    start: `# hivemind:resource:${name}:start`,
    end: `# hivemind:resource:${name}:end`,
  };
}

/** Replace-or-append a marker-wrapped block in `text`. */
function upsertBlock(text: string, start: string, end: string, body: string): string {
  const block = `${start}\n${body}\n${end}`;
  const re = new RegExp(`${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}`);
  if (re.test(text)) return text.replace(re, block);
  const prefix = text.length === 0 || text.endsWith("\n") ? text : text + "\n";
  return prefix + (prefix.length ? "\n" : "") + block + "\n";
}

/** Remove a marker-wrapped block from `text` (idempotent). */
function removeBlock(text: string, start: string, end: string): string {
  const re = new RegExp(`\\n?${escapeRe(start)}[\\s\\S]*?${escapeRe(end)}\\n?`);
  return text.replace(re, "\n").replace(/\n{3,}/g, "\n\n");
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Serialize a single MCP server fragment as a codex `[mcp_servers.<name>]`
 *  TOML table. Supports the common subset: command/args/env/url/headers.
 *  Kept intentionally small — the mcpServer fragment is authored by the user. */
function tomlMcpBlock(name: string, server: Record<string, unknown>): string {
  const lines: string[] = [`[mcp_servers.${tomlKey(name)}]`];
  const env = server.env as Record<string, unknown> | undefined;
  const headers = server.headers as Record<string, unknown> | undefined;
  for (const [k, v] of Object.entries(server)) {
    if (k === "env" || k === "headers") continue;
    lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  if (env && typeof env === "object") {
    lines.push(`[mcp_servers.${tomlKey(name)}.env]`);
    for (const [k, v] of Object.entries(env)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  if (headers && typeof headers === "object") {
    lines.push(`[mcp_servers.${tomlKey(name)}.http_headers]`);
    for (const [k, v] of Object.entries(headers)) lines.push(`${tomlKey(k)} = ${tomlValue(v)}`);
  }
  return lines.join("\n");
}

/** A TOML bare key if it's simple, else a quoted key. */
function tomlKey(k: string): string {
  return /^[A-Za-z0-9_-]+$/.test(k) ? k : JSON.stringify(k);
}

/** Serialize a JSON value as TOML (strings, numbers, booleans, string arrays). */
function tomlValue(v: unknown): string {
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) return `[${v.map((x) => tomlValue(x)).join(", ")}]`;
  return JSON.stringify(String(v));
}

async function mergeCodexProse(workspaceRoot: string, r: Resource, scope: SummonScope): Promise<string> {
  const p =
    scope === "global"
      ? path.join(cliGlobalRoot("codex"), "AGENTS.md")
      : path.join(workspaceRoot, "AGENTS.md");
  let text = "";
  try {
    text = await fs.readFile(p, "utf8");
  } catch {
    /* fresh */
  }
  const { start, end } = codexMarkers(r.name);
  const body = r.canonicalFile
    ? await fs.readFile(r.canonicalFile, "utf8")
    : `(${r.kind} ${r.name})`;
  const heading = `## ${r.kind}: ${r.name}\n\n${body.trim()}`;
  await writeFileAtomic(p, upsertBlock(text, start, end, heading));
  return p;
}

async function mergeCodexToml(workspaceRoot: string, r: Resource, scope: SummonScope): Promise<string> {
  const p =
    scope === "global"
      ? path.join(cliGlobalRoot("codex"), "config.toml")
      : path.join(workspaceRoot, ".codex", "config.toml");
  let text = "";
  try {
    text = await fs.readFile(p, "utf8");
  } catch {
    /* fresh */
  }
  const { start, end } = tomlMarkers(r.name);
  const block = tomlMcpBlock(r.name, r.mcpServer ?? {});
  await writeFileAtomic(p, upsertBlock(text, start, end, block));
  return p;
}

async function unmergeCodex(entry: SummonEntry): Promise<void> {
  for (const p of entry.targets) {
    let text: string;
    try {
      text = await fs.readFile(p, "utf8");
    } catch {
      continue;
    }
    const { start, end } = p.endsWith(".toml")
      ? tomlMarkers(entry.resource)
      : codexMarkers(entry.resource);
    await writeFileAtomic(p, removeBlock(text, start, end));
  }
}

// ── summon / unsummon ────────────────────────────────────────────────────

export interface SummonResult {
  resource: string;
  kind: ResourceKind;
  cli: Cli;
  mode: SummonMode;
  scope: SummonScope;
  targets: string[];
  gitignoreChanged: boolean;
}

/** Ledger key for global summons — not tied to any repo. */
export const GLOBAL_LEDGER_KEY = "@global";

/** Summon a resource into a workspace (or the CLI's global scope) for a CLI.
 *  Projection strategy per (cli × kind): claude/kiro symlink agents/skills &
 *  merge mcp into their JSON; codex marker-merges agent/skill prose into
 *  AGENTS.md & mcp into config.toml. `scope="global"` targets the CLI's ~/. dir
 *  (no gitignore — not a repo). `copy=true` copies instead of symlinking
 *  (forced for remote targets, since a symlink into the local catalog can't
 *  resolve on another host). Ensures .gitignore for project scope; records the
 *  ledger. Idempotent. */
export async function summon(opts: {
  resource: Resource;
  workspaceRoot: string;
  cli?: Cli;
  scope?: SummonScope;
  copy?: boolean;
}): Promise<SummonResult> {
  const cli = opts.cli ?? "claude";
  const scope = opts.scope ?? "project";
  const r = opts.resource;
  const wsRoot = path.resolve(opts.workspaceRoot);
  // A remote (ssh://) target can't resolve a local symlink → force copy.
  const isRemote = /^ssh:\/\//.test(opts.workspaceRoot);
  const wantCopy = !!opts.copy || isRemote;

  let mode: SummonMode;
  const targets: string[] = [];

  if (r.kind === "mcp") {
    if (!r.mcpServer) {
      throw new HiveError("bad_mcp", `mcp resource ${r.name} has no mcpServer fragment`);
    }
    mode = "merge";
    if (cli === "codex") {
      targets.push(await mergeCodexToml(wsRoot, r, scope));
    } else {
      const p = mcpJsonPath(wsRoot, cli, scope);
      if (!p) throw new HiveError("unsupported_cli", `cli ${cli} has no mcp json path`);
      await mergeMcpJson(p, r);
      targets.push(p);
    }
  } else if (cli === "codex") {
    // codex has no agent/skill files → marker-merge into AGENTS.md
    mode = "merge";
    targets.push(await mergeCodexProse(wsRoot, r, scope));
  } else {
    // claude / kiro → symlink (or copy) the canonical file (agent) or dir (skill)
    if (!r.canonicalFile) {
      throw new HiveError("bad_resource", `${r.kind}/${r.name} has no canonical file`);
    }
    const link = symlinkTarget(wsRoot, cli, r, scope);
    if (!link) throw new HiveError("unsupported_cli", `cli ${cli} can't symlink ${r.kind}`);
    const src = r.kind === "skill" ? r.dir : r.canonicalFile;
    if (wantCopy) {
      mode = "copy";
      await copyRecursive(src, link);
    } else {
      mode = "symlink";
      await ensureSymlink(link, src);
    }
    targets.push(link);
  }

  // gitignore only makes sense for a project scope (global isn't a repo).
  const gitignoreChanged = scope === "project" ? await ensureGitignore(wsRoot, cli) : false;

  const ledgerKey = scope === "global" ? GLOBAL_LEDGER_KEY : wsRoot;
  await recordSummon(ledgerKey, {
    resource: r.name,
    kind: r.kind,
    cli,
    mode,
    scope,
    targets,
    summonedAt: new Date().toISOString(),
  });

  return { resource: r.name, kind: r.kind, cli, mode, scope, targets, gitignoreChanged };
}

/** Summon an agent together with its associated skills + mcps (from the agent's
 *  manifest) into a workspace for a CLI. This powers the "spawn an agent and
 *  bring its resources" journey. Returns each projection's result. Missing
 *  associated resources are skipped (they may have been deleted). */
export async function summonAgentBundle(opts: {
  agent: Resource;
  workspaceRoot: string;
  cli?: Cli;
  scope?: SummonScope;
  copy?: boolean;
}): Promise<SummonResult[]> {
  const { agent, workspaceRoot, cli, scope, copy } = opts;
  const results: SummonResult[] = [];
  results.push(await summon({ resource: agent, workspaceRoot, cli, scope, copy }));
  for (const skillName of agent.skills) {
    try {
      const skill = await getResource("skill", skillName);
      results.push(await summon({ resource: skill, workspaceRoot, cli, scope, copy }));
    } catch {
      /* associated skill gone from catalog — skip */
    }
  }
  for (const mcpName of agent.mcps) {
    try {
      const mcp = await getResource("mcp", mcpName);
      results.push(await summon({ resource: mcp, workspaceRoot, cli, scope, copy }));
    } catch {
      /* associated mcp gone — skip */
    }
  }
  return results;
}

/** Reverse a summon: remove the symlink/copy, strip the merged mcp server, or
 *  remove the marker-wrapped codex block — then drop the ledger entry.
 *  Idempotent — returns false if nothing was recorded. */
export async function unsummon(opts: {
  resourceName: string;
  workspaceRoot: string;
  cli?: Cli;
  scope?: SummonScope;
}): Promise<boolean> {
  const cli = opts.cli ?? "claude";
  const scope = opts.scope ?? "project";
  const wsRoot = path.resolve(opts.workspaceRoot);
  const ledgerKey = scope === "global" ? GLOBAL_LEDGER_KEY : wsRoot;
  const entry = await forgetSummon(ledgerKey, opts.resourceName, cli);
  if (!entry) return false;

  if (entry.cli === "codex") {
    await unmergeCodex(entry);
  } else if (entry.mode === "merge") {
    for (const t of entry.targets) await unmergeMcpJson(t, opts.resourceName);
  } else {
    for (const t of entry.targets) {
      try {
        const st = await fs.lstat(t);
        // Symlinks: remove the link. Copies: remove the copied file/dir. Never
        // touch a plain non-symlink unless we recorded it as a copy (ours).
        if (st.isSymbolicLink()) await fs.rm(t);
        else if (entry.mode === "copy") await fs.rm(t, { recursive: true, force: true });
      } catch {
        /* already gone */
      }
    }
  }
  return true;
}

// ── summon list: global (summoned) vs local (own) ──────────────────────────

export interface SummonView {
  /** Resources summoned into this workspace (references to catalog). */
  summoned: SummonEntry[];
  /** Local resources the repo authored itself (real files, not catalog links). */
  local: { kind: ResourceKind; name: string; path: string }[];
}

/** Detect, in `workspaceRoot`, what's summoned (from the ledger) vs. local
 *  (real files under {.claude,.kiro}/{agents,skills} that are NOT symlinks
 *  into the catalog). */
export async function summonList(workspaceRoot: string): Promise<SummonView> {
  const wsRoot = path.resolve(workspaceRoot);
  const summoned = await ledgerFor(wsRoot);
  const summonedTargets = new Set(summoned.flatMap((e) => e.targets.map((t) => path.resolve(t))));
  const cat = path.resolve(catalogRoot());

  const local: SummonView["local"] = [];
  const seen = new Set<string>();

  for (const base of [".claude", ".kiro"]) {
    // agents: files under <base>/agents/*.md
    const agentsDir = path.join(wsRoot, base, "agents");
    for (const ent of await safeReaddir(agentsDir)) {
      if (!ent.name.endsWith(".md")) continue;
      const p = path.join(agentsDir, ent.name);
      const name = ent.name.replace(/\.md$/, "");
      if (seen.has(`agent/${name}`)) continue;
      if (await isLocalResource(p, summonedTargets, cat)) {
        local.push({ kind: "agent", name, path: p });
        seen.add(`agent/${name}`);
      }
    }
    // skills: dirs under <base>/skills/*
    const skillsDir = path.join(wsRoot, base, "skills");
    for (const ent of await safeReaddir(skillsDir)) {
      const p = path.join(skillsDir, ent.name);
      if (seen.has(`skill/${ent.name}`)) continue;
      if (await isLocalResource(p, summonedTargets, cat)) {
        local.push({ kind: "skill", name: ent.name, path: p });
        seen.add(`skill/${ent.name}`);
      }
    }
  }

  return { summoned, local };
}

/** A path is "local" (repo-authored) when it isn't in the ledger targets and
 *  isn't a symlink resolving into the catalog dir. */
async function isLocalResource(
  p: string,
  summonedTargets: Set<string>,
  catalogDir: string,
): Promise<boolean> {
  if (summonedTargets.has(path.resolve(p))) return false;
  try {
    const st = await fs.lstat(p);
    if (st.isSymbolicLink()) {
      const tgt = path.resolve(path.dirname(p), await fs.readlink(p));
      if (tgt.startsWith(catalogDir + path.sep) || tgt === catalogDir) return false;
    }
  } catch {
    return false;
  }
  return true;
}

async function safeReaddir(dir: string): Promise<{ name: string }[]> {
  try {
    return (await fs.readdir(dir, { withFileTypes: true })).map((d) => ({ name: d.name }));
  } catch {
    return [];
  }
}
