# Agent Catalog — Design

**Status:** proposed. **Date:** 2026-08-27.

A **catalog** is a single, machine-global collection of reusable *agentic
resources* — agent contracts, skills, and MCP server definitions — that you author
and edit **once**, then **summon** into any workspace on demand. The workspace
gets the resources in each CLI's expected on-disk layout (`.claude/`, `.kiro/`,
`.codex/`, `.mcp.json`), **by reference wherever possible** and **never
git-committed**. One canonical place; edits propagate; nothing to manage when it
scales.

This mirrors what `.hivemind/` already does for *issues*: keep the source of
truth as plain files in one place, and let the CLI/app/MCP project them where
they're needed.

---

## Goals (from the request)

- **One canonical home** for agents, skills, MCPs — versioned once, edited easily.
- **See the catalog** and edit resources without hunting through repos.
- **Summon a resource into a workspace** — local dir, git worktree, or (later) remote.
- **In a workspace, see both** the summoned "global" resources and the repo's own
  local ones.
- **Adopt each CLI's most common layout** and prefer *references* over copies.
- **Summoned material is not git-committed** — automate the ignore.
- **Stay simple as it scales** — no per-repo bookkeeping by hand.

Non-goals (for this design): the drawing/board tile (deferred), publishing/
sharing catalogs between machines, and a full permissions model.

---

## Design driver: two projection strategies, pick per CLI

The request is "as little file copying as possible." Every target CLI resolves
its agentic resources from **two scopes**: a per-project dir and a **global** dir in
`$HOME`. That gives us two ways to make a canonical resource visible to a CLI:

> **A. Global install (zero per-workspace files).** Symlink (or register) the
> catalog resource into the CLI's *global* scope once — `~/.claude/skills/<n>`,
> `~/.kiro/agents/<n>.json`, etc. Every workspace that uses that CLI then sees
> the resource with **no files in the repo at all**. This is the cleanest possible
> answer to "don't pollute / don't version," but it's machine-wide (not
> scoped to chosen workspaces).
>
> **B. Per-workspace symlink (scoped, still no copy).** Symlink the catalog
> resource into the *project* scope — `<repo>/.claude/skills/<n>` →
> `~/.config/hivemind/catalog/skills/<n>`. Scoped to exactly the repos you
> summon into; the file content still lives once in the catalog. Requires a
> `.gitignore` line so the symlink isn't committed.

Both avoid duplicating content. **Default = B (per-workspace symlink)** because
"summon *into a workspace*" is inherently scoped, and worktrees/branches want
different sets. **A is offered as `--global`** for the "I always want this
everywhere" resources. **Copy (`--copy`) is the fallback** for surfaces where
symlinks don't work (remote SSH frames, MCP fragments — see below).

The confirmed per-CLI layout the projector targets:

| kind | claude | kiro | codex |
|---|---|---|---|
| **agent** | `.claude/agents/<n>.md` · `~/.claude/agents/` | `.kiro/agents/<n>.json` · `~/.kiro/agents/` | *(no agent files — see note)* |
| **skill** | `.claude/skills/<n>/SKILL.md` · `~/.claude/skills/` | `.kiro/skills/<n>/` · `~/.kiro/skills/` | *(no native skills — projected as steering/instructions)* |
| **mcp** | `.mcp.json` `mcpServers` (merge) | `.kiro/settings/mcp.json` `mcpServers` (merge) · `~/.kiro/settings/mcp.json` | `.codex/config.toml` / `~/.codex/config.toml` `mcp_servers` (TOML, merge, trusted only) |

Sources: Claude Code `.claude` docs; Kiro *Configuration scopes* (file-paths
table); Codex *Configuration Reference* + *MCP* docs.

**Codex note.** Codex has no per-resource "agent" or "skill" files; it reads
`AGENTS.md` walking from repo root and MCP servers from TOML. So for Codex a
summoned *agent/skill* projects into an `AGENTS.md` section (marker-wrapped, same
idempotent technique the repo already uses for the `hivemind:agentic` block),
and MCP projects into `config.toml` as `mcp_servers`. This is the one case that
is *always a merge*, never a symlink.

---

## Where the catalog lives

Alongside the workspace registry the codebase already owns
(`registry.ts` → `~/.config/hivemind/registry.json`, honoring `$XDG_CONFIG_HOME`,
shared by CLI + app + MCP):

```
~/.config/hivemind/catalog/
├── catalog.yaml                 # index: resources, kind, tags, supported CLIs, summon defaults
├── agents/
│   └── reviewer/
│       ├── agent.md             # canonical contract (YAML frontmatter + body)
│       └── resource.yaml        # kind: agent, cli support, per-CLI overrides
├── skills/
│   └── hive-work/
│       ├── SKILL.md             # canonical (already the repo's format)
│       └── resource.yaml
└── mcps/
    └── postgres/
        └── resource.yaml        # kind: mcp, holds the mcpServers fragment
```

- **This directory is the only thing you version** — point your own git repo at
  `~/.config/hivemind/catalog/` if you want history. Nothing here is tied to a
  project repo.
- `resource.yaml` is the small manifest that lets a resource declare which CLIs it
  supports and any per-CLI naming/overrides. It keeps `agent.md`/`SKILL.md`
  pure so they stay valid for the target CLI as-is.
- The canonical `agent.md`/`SKILL.md` files are authored in the **Claude format**
  (most common, richest), and the projector *translates* to Kiro's `agent.json`
  / Codex `AGENTS.md` when summoning to those CLIs. Translation is a documented,
  testable transform per kind × CLI.

### `catalog.yaml` (index) — sketch

```yaml
version: 1
resources:
  reviewer:
    kind: agent
    title: "Code Reviewer"
    tags: [review, quality]
    clis: [claude, kiro]          # codex via AGENTS.md projection
    path: agents/reviewer
  hive-work:
    kind: skill
    tags: [workflow]
    clis: [claude, kiro]
    path: skills/hive-work
  postgres:
    kind: mcp
    tags: [db]
    clis: [claude, kiro, codex]
    path: mcps/postgres
```

The index is a **cache/convenience** — like `registry.json`, the resource
directories on disk are authoritative, and the index is rebuildable by scanning
them.

---

## Summon — how a resource lands in a workspace

`hive summon <resource> --to <workspace> [--cli claude|kiro|codex|all] [--global] [--copy]`

Resolution & projection:

1. **Resolve the target.** `--to` accepts a registry prefix, a repo path, or a
   branch/worktree path — reusing `resolveWorkspaceByPrefix` /
   `listWorkspaces()` that already exist. From the app, reuse the HCP
   frame-picker (`frame:` by id / repo / title) so "send to a workspace, branch,
   or whatever" is the same target model as `hive_spawn_agent`.
2. **Pick CLIs.** Default to the CLIs the resource declares (`clis:`), or `--cli`
   to force one. `--cli all` projects to every supported CLI at once.
3. **Project per (resource.kind × cli):**
   - *agent/skill, symlinkable target* → `symlink` project-scope path →
     catalog path. (`--global` symlinks the global-scope path instead.)
   - *mcp, or codex anything* → **marked merge** into the target JSON/TOML.
     Reuse `installHiveMcp`'s merge approach; wrap our keys so `unsummon` can
     remove exactly what we added and nothing else.
   - *`--copy` or remote target* → copy the files instead of symlinking.
4. **Ignore automatically.** Ensure `.gitignore` in the target repo carries the
   right lines (extending the existing ignore+exception pattern the repo already
   uses: `.claude/*` + `!` exceptions). So summoned material is never committed.
5. **Record the projection** in a per-workspace ledger so `unsummon` and
   `summon list` are exact (see below).

`hive unsummon <resource> --from <workspace>` reverses it: remove the symlink, or
strip the marked merge block, and drop the ledger entry. Idempotent.

### The projection ledger — **decided: out-of-repo**

To make summon/unsummon exact and to answer "what's global vs local here,"
record each projection. **Decision: the ledger lives out of the target repo**
(keeps the repo 100% clean, per the "don't pollute" goal):

- **`~/.config/hivemind/catalog/summons.json`** — global map
  `workspaceRoot → [{ resource, cli, mode: symlink|merge|copy, targets: [...] }]`.
  Keeps the target repo clean (no hivemind bookkeeping file in it), consistent
  with "don't pollute the repo."
- (rejected) a dotfile inside the target repo — pollutes the repo, defeats the
  goal.

### `summon list` — seeing global vs local in a workspace

In the current workspace, list two groups:

- **Summoned (global):** entries from the ledger for this workspace root — these
  are references to catalog resources.
- **Local (own):** resources that physically live in the repo's `.claude/agents`,
  `.claude/skills`, `.kiro/agents`, etc. and are *not* symlinks into the catalog
  (i.e. real files the repo authored).

Detection is a `lstat`: a symlink whose target is under the catalog dir = a
summoned reference; a regular file/dir = a local resource. This directly satisfies
"in the workspace I can see the global agents and the ones in the directory
itself."

---

## The view/edit journey (a first-class requirement)

"See and edit with an easy journey" is a primary goal, not a nice-to-have. The
design makes it fall out of the symlink choice:

- **Edit once, everywhere.** Because a summon is a *symlink to the canonical
  file*, opening a summoned agent/skill in a workspace's `EditorTile` edits the
  **catalog original** — the change propagates to every workspace that summoned
  it. There is no "sync" step and no divergent copies to reconcile.
- **One place to browse.** The Catalog tile (and `hive catalog list`) is the
  single index of every agent/skill/mcp, with tags and a "summoned in N frames"
  badge — so you always know what exists and where it's active.
- **One click to edit.** `hive catalog edit <name>` opens the canonical file in
  `$EDITOR`; the Catalog tile's edit button opens it in the `EditorTile`. Both
  point at the same canonical path.
- **Scaffolding is guided.** `hive catalog new agent|skill|mcp <name>` writes a
  templated skeleton (frontmatter + section headers) so authoring a new one is
  fill-in-the-blanks, not from scratch.

This journey is why the Catalog tile (P2) and `catalog edit` (P0) are in scope
even though summoning could technically work headless — being able to *see and
edit easily* is the point.

## Surfaces

### CLI (mirrors the existing `hive add` / `hive new` style)

```
hive catalog list                       # show catalog: resources, kind, tags, where summoned
hive catalog new agent|skill|mcp <name> # scaffold a canonical resource
hive catalog edit <resource>               # open the canonical file ($EDITOR)
hive catalog rm <resource>

hive summon <resource> [--to <ws>] [--cli ...] [--global] [--copy]
hive unsummon <resource> [--from <ws>]
hive summon list                        # in cwd workspace: summoned(global) + local(own)
```

### App (a Catalog tile, mirroring IssuesTile)

- A **Catalog tile** listing resources grouped by kind, with tags and a "summoned
  in N frames" badge.
- **Edit** opens the canonical file in the existing `EditorTile`. Because edits
  hit the canonical file (symlink target), they propagate to every workspace
  that summoned it — the "edit once" property.
- **Summon → frame** uses the same frame target model as HCP `hive_spawn_agent`
  (`frame:` by id / repo name / title), so you drag/point a resource at any
  frame — local, worktree, or remote — and it projects with the right strategy.
- A new `LayerKind` + a tool-island entry / spawn key for the tile.

---

## Why this stays simple at scale

- **One canonical copy.** Symlinks (default) and marked merges mean content is
  never duplicated; editing the canonical file is the only edit.
- **Reversible & idempotent.** Marked merges + a ledger make summon/unsummon
  exact — the same guarantee `installHiveMcp` already provides for `.mcp.json`.
- **No repo pollution.** Auto-`.gitignore` + an out-of-repo ledger keep target
  repos clean; nothing summoned is committed.
- **Reuses three existing mechanisms.** The global config dir + registry, the
  idempotent template installers, and the HCP frame-picker. Little new surface,
  mostly wiring.

---

## Open questions / risks

1. **Symlinks + worktrees / remote SSH frames. ✅ resolved.** Symlinks into a
   per-worktree `.claude/` work locally; **remote (`ssh://`) targets force
   `--copy`** (a local symlink can't resolve on another host). A quick empirical
   check confirmed CLIs follow a symlinked *skill directory* fine, so symlink
   stays the default for local project + global scopes.
2. **Codex translation fidelity.** Projecting an agent/skill into `AGENTS.md`
   loses the structured "subagent" semantics Claude/Kiro have. Acceptable — for
   Codex these become instructions/steering — but should be documented so the
   user isn't surprised the resource behaves differently there.
3. **Kiro agent format is JSON, Claude/skills are Markdown.** The canonical form
   is Markdown; summoning to Kiro requires an `agent.md → agent.json` transform.
   Keep the transform per kind×CLI, unit-tested, and lossy-by-declaration
   (document which fields map).
4. **Naming vs the runtime "agent" registry — decided: "resources".**
   `agents.tsx` already defines "agent" as *which CLI binary spawns*. The
   catalog's "agent" is a *contract document*, so to avoid collision the umbrella
   term is **"resources"** (kinds: `agent` / `skill` / `mcp`). This aligns with
   Kiro, which itself calls these `resources` in its agent config. This doc uses
   "resource" for the umbrella and "agent/skill/mcp" for the kinds.
5. **Global (`--global`) vs per-workspace default. ✅ resolved.** `--global` is
   machine-wide and stays **opt-in**; the default is project-scoped. Global
   summons are tracked under a `@global` ledger key so they never mix with a
   repo's entries.

---

## Phasing

- **P0 — catalog storage + CLI (no UI). ✅ implemented.** `catalog/` layout, `resource.yaml`,
  `catalog.yaml` index; `hive catalog list/new/edit`; `hive summon/unsummon` for
  **claude**, symlink + auto-gitignore + ledger; `summon list`. Unit tests
  for merge/ledger/gitignore idempotency.
- **P1 — kiro + codex projectors. ✅ implemented.** Kiro CLI 3.0 accepts a
  **Markdown** agent file (frontmatter=config, body=prompt), so the canonical
  `agent.md`/`SKILL.md` **symlink into `.kiro/{agents,skills}` unchanged** — no
  `agent.md → agent.json` transform needed (revises the original assumption).
  Kiro MCP merges into `.kiro/settings/mcp.json`. Codex has no per-resource
  files, so agent/skill project as **marker-wrapped `AGENTS.md` sections** and
  MCP as marker-wrapped `[mcp_servers.<name>]` blocks in `.codex/config.toml`
  (a minimal TOML emitter for the common command/args/env/url/headers subset).
  All three selectable via `--cli`.
- **P2 — Catalog tile + Summon-to-frame** in the app, reusing EditorTile and the
  HCP frame-picker.
- **P3 — polish. ✅ implemented.** `--global` scope projects into the CLI's
  machine-wide dir (`~/.claude`, `$KIRO_HOME`/`~/.kiro`, `~/.codex`; claude MCP →
  `~/.claude.json`), recorded under a `@global` ledger key, no gitignore.
  `--copy` copies instead of symlinking, and is forced automatically for
  `ssh://` (remote-frame) targets. The Catalog tile exposes a **global** toggle.
  Project + global summons of the same resource coexist (ledger dedups on
  resource+cli+scope).
