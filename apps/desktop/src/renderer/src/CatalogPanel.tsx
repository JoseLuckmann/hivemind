/**
 * Agent Catalog — the personal agent marketplace, as an APPLICATION surface
 * (not a canvas tile). It has two parts that mirror an IDE:
 *
 *   - CatalogSidebar: the LEFT RAIL (same slot as LayersPanel — you toggle
 *     between "Layers" and "Catalog" there). Lists agents / skills / mcps as
 *     rows grouped by kind, with per-row CRUD, "associate skills/mcps to an
 *     agent", and "spawn this agent into a workspace".
 *   - CatalogEditor: fills the MAIN region (where the canvas is) and edits the
 *     selected resource's canonical file using the app's own EditorTile — the
 *     resource's dir is the editor's repoPath so the repo-relative editor
 *     reads/writes it unchanged; edits propagate to every summon (symlink).
 *
 * The catalog lives once in ~/.config/hivemind/catalog/. Data flows through the
 * TanStack hooks in queries.ts.
 */
import { useMemo, useState } from "react";
import { Bot, Sparkles, Plug, Plus, Pencil, Trash2, Rocket, Link2, X } from "lucide-react";
import {
  useCatalog,
  useCreateResource,
  useRemoveResource,
  useSetAssociations,
} from "./queries";
import { EditorTile } from "./EditorTile";
import type { CatalogResource, CatalogResourceKind, CatalogCli } from "../../shared/ipc";

/** A workspace an agent can be spawned into (a frame bound to a repo). */
export interface SpawnTarget {
  id: string;
  label: string;
  repoPath: string;
}

/** A resource selected for editing — its dir + canonical file basename. */
export interface CatalogSelection {
  name: string;
  kind: CatalogResourceKind;
  repoPath: string;
  file: string;
  label: string;
}

const KIND_META: Record<CatalogResourceKind, { icon: React.ReactNode; label: string }> = {
  agent: { icon: <Bot size={14} />, label: "Agents" },
  skill: { icon: <Sparkles size={14} />, label: "Skills" },
  mcp: { icon: <Plug size={14} />, label: "MCPs" },
};
const KIND_ORDER: CatalogResourceKind[] = ["agent", "skill", "mcp"];
const CLIS: CatalogCli[] = ["claude", "codex", "kiro"];

/** The canonical file (repo-relative to the resource dir) for a resource. */
function selectionFor(r: CatalogResource): CatalogSelection {
  const file = r.canonicalFile ? r.canonicalFile.slice(r.dir.length + 1) : "resource.yaml";
  return { name: r.name, kind: r.kind, repoPath: r.dir, file, label: `${r.kind}/${r.name}` };
}

// ── sidebar (left rail) ─────────────────────────────────────────────────────

export function CatalogSidebar({
  width,
  selected,
  onSelect,
  targets,
  onSpawn,
}: {
  width: number;
  selected: string | null;
  onSelect: (sel: CatalogSelection) => void;
  targets: SpawnTarget[];
  onSpawn: (opts: { agentName: string; cli: CatalogCli; repoPath: string }) => void;
}) {
  const catalog = useCatalog();
  const create = useCreateResource();
  const remove = useRemoveResource();
  const setAssoc = useSetAssociations();

  const [creating, setCreating] = useState<CatalogResourceKind | null>(null);
  const [assocFor, setAssocFor] = useState<string | null>(null);
  const [spawnFor, setSpawnFor] = useState<CatalogResource | null>(null);

  const grouped = useMemo(() => {
    const by: Record<CatalogResourceKind, CatalogResource[]> = { agent: [], skill: [], mcp: [] };
    for (const r of catalog.data ?? []) by[r.kind].push(r);
    return by;
  }, [catalog.data]);

  const skills = grouped.skill;
  const mcps = grouped.mcp;

  return (
    <aside
      className="shrink-0 flex flex-col min-h-0 border-r border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden"
      style={{ width }}
    >
      <div className="flex-1 overflow-auto py-1">
        {KIND_ORDER.map((kind) => {
          const items = grouped[kind];
          const meta = KIND_META[kind];
          return (
            <section key={kind} className="mb-1">
              <header className="flex items-center gap-1.5 px-3 h-8 text-[var(--color-fg3)] sticky top-0 bg-[var(--color-bg2)]">
                {meta.icon}
                <span className="u-eyebrow text-[10.5px]">{meta.label}</span>
                <span className="text-[10.5px] tabular-nums">{items.length}</span>
                <div className="flex-1" />
                <button
                  onClick={() => setCreating(kind)}
                  aria-label={`New ${kind}`}
                  title={`New ${kind}`}
                  className="grid place-items-center size-5 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer"
                >
                  <Plus size={13} />
                </button>
              </header>

              {creating === kind && (
                <NewRow
                  kind={kind}
                  busy={create.isPending}
                  onCancel={() => setCreating(null)}
                  onCreate={(name) =>
                    create.mutate({ kind, name }, { onSuccess: () => setCreating(null) })
                  }
                />
              )}

              {items.length === 0 && creating !== kind && (
                <p className="px-3 py-1 text-[11px] text-[var(--color-fg3)]">none yet</p>
              )}

              {items.map((r) => {
                const sel = selectionFor(r);
                const active = selected === `${r.kind}/${r.name}`;
                return (
                  <div key={r.name}>
                    <div
                      className={`group flex items-center gap-1.5 pl-3 pr-2 py-1 cursor-pointer ${
                        active ? "bg-[var(--color-bg3)]" : "hover:bg-[var(--color-bg2)]"
                      }`}
                      onClick={() => onSelect(sel)}
                    >
                      <span className="flex-1 min-w-0 truncate text-[12px] text-[var(--color-fg)]" title={r.title}>
                        {r.name}
                      </span>
                      {r.kind === "agent" && (
                        <>
                          <button
                            onClick={(e) => { e.stopPropagation(); setAssocFor(assocFor === r.name ? null : r.name); }}
                            title="Associate skills / mcps"
                            aria-label={`Associate resources with ${r.name}`}
                            className="grid place-items-center size-5 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer opacity-0 group-hover:opacity-100"
                          >
                            <Link2 size={12} />
                          </button>
                          <button
                            onClick={(e) => { e.stopPropagation(); setSpawnFor(r); }}
                            title="Spawn this agent into a workspace"
                            aria-label={`Spawn ${r.name}`}
                            disabled={targets.length === 0}
                            className="grid place-items-center size-5 rounded text-[var(--color-brand)] hover:bg-[var(--color-bg3)] cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed opacity-0 group-hover:opacity-100"
                          >
                            <Rocket size={12} />
                          </button>
                        </>
                      )}
                      <button
                        onClick={(e) => { e.stopPropagation(); onSelect(sel); }}
                        title="Edit"
                        aria-label={`Edit ${r.name}`}
                        className="grid place-items-center size-5 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer opacity-0 group-hover:opacity-100"
                      >
                        <Pencil size={12} />
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          if (confirm(`Remove ${r.kind}/${r.name}?`)) remove.mutate({ kind: r.kind, name: r.name });
                        }}
                        title="Remove"
                        aria-label={`Remove ${r.name}`}
                        className="grid place-items-center size-5 rounded text-[var(--color-fg3)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg3)] cursor-pointer opacity-0 group-hover:opacity-100"
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                    {r.kind === "agent" && assocFor === r.name && (
                      <AssociationEditor
                        agent={r}
                        skills={skills}
                        mcps={mcps}
                        busy={setAssoc.isPending}
                        onSave={(a) => setAssoc.mutate({ name: r.name, skills: a.skills, mcps: a.mcps }, { onSuccess: () => setAssocFor(null) })}
                        onClose={() => setAssocFor(null)}
                      />
                    )}
                    {r.kind === "agent" && assocFor !== r.name && (r.skills.length > 0 || r.mcps.length > 0) && (
                      <div className="pl-3 pr-2 pb-1 text-[9.5px] text-[var(--color-fg3)] truncate">
                        {[...r.skills.map((s) => `+${s}`), ...r.mcps.map((m) => `@${m}`)].join(" ")}
                      </div>
                    )}
                  </div>
                );
              })}
            </section>
          );
        })}
      </div>

      {spawnFor && (
        <SpawnDialog
          agent={spawnFor}
          targets={targets}
          onClose={() => setSpawnFor(null)}
          onSpawn={(cli, repoPath) => {
            onSpawn({ agentName: spawnFor.name, cli, repoPath });
            setSpawnFor(null);
          }}
        />
      )}
    </aside>
  );
}

// ── editor (main region) ────────────────────────────────────────────────────

export function CatalogEditor({ selection, onClose }: { selection: CatalogSelection | null; onClose: () => void }) {
  if (!selection) {
    return (
      <div className="flex-1 grid place-items-center bg-[var(--color-bg)] text-center px-8">
        <div className="max-w-[320px]">
          <Bot size={28} className="mx-auto text-[var(--color-fg3)] mb-3" />
          <p className="text-[13px] font-medium text-[var(--color-fg)]">Agent Catalog</p>
          <p className="text-[11.5px] text-[var(--color-fg2)] mt-1.5 leading-relaxed">
            Pick an agent, skill, or MCP on the left to edit it here. Create new ones with the
            <Plus size={11} className="inline mx-0.5 -mt-0.5" /> in each section. Associate skills with an
            agent, then spawn it into a workspace with its resources applied.
          </p>
        </div>
      </div>
    );
  }
  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--color-bg)]">
      <div className="flex items-center gap-2 px-4 h-10 border-b border-[var(--color-line2)] shrink-0 text-[12px] text-[var(--color-fg2)]">
        <Pencil size={13} className="text-[var(--color-fg3)]" />
        <span className="font-medium text-[var(--color-fg)]">{selection.label}</span>
        <div className="flex-1" />
        <button
          onClick={onClose}
          aria-label="Close editor"
          className="grid place-items-center size-6 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer"
        >
          <X size={15} />
        </button>
      </div>
      <div className="flex-1 min-h-0">
        <EditorTile
          key={`${selection.repoPath}:${selection.file}`}
          repoPath={selection.repoPath}
          tabs={[selection.file]}
          onCloseTab={() => {}}
          embedded
          singleFile
        />
      </div>
    </div>
  );
}

// ── shared subcomponents ────────────────────────────────────────────────────

function NewRow({ kind, busy, onCreate, onCancel }: {
  kind: CatalogResourceKind; busy: boolean; onCreate: (n: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-1 px-3 py-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) onCreate(name.trim());
          if (e.key === "Escape") onCancel();
        }}
        placeholder={`new-${kind}`}
        aria-label={`New ${kind} name`}
        className="flex-1 min-w-0 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded text-[11px] text-[var(--color-fg)] px-1.5 py-1 outline-none focus:border-[var(--color-brand)]"
      />
      <button
        onClick={() => name.trim() && onCreate(name.trim())}
        disabled={busy || !name.trim()}
        className="text-[10.5px] px-1.5 py-1 rounded text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer disabled:opacity-40"
      >
        Add
      </button>
      <button onClick={onCancel} aria-label="Cancel" className="grid place-items-center size-6 rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] cursor-pointer">
        <X size={13} />
      </button>
    </div>
  );
}

function AssociationEditor({ agent, skills, mcps, busy, onSave, onClose }: {
  agent: CatalogResource;
  skills: CatalogResource[];
  mcps: CatalogResource[];
  busy: boolean;
  onSave: (sel: { skills: string[]; mcps: string[] }) => void;
  onClose: () => void;
}) {
  const [selSkills, setSelSkills] = useState<Set<string>>(new Set(agent.skills));
  const [selMcps, setSelMcps] = useState<Set<string>>(new Set(agent.mcps));
  const toggle = (set: Set<string>, k: string) => {
    const next = new Set(set);
    next.has(k) ? next.delete(k) : next.add(k);
    return next;
  };
  return (
    <div className="mx-2 my-1 p-2 rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)]">
      <p className="text-[10px] text-[var(--color-fg3)] mb-1">Skills</p>
      {skills.length === 0 && <p className="text-[10px] text-[var(--color-fg3)]">none</p>}
      {skills.map((s) => (
        <label key={s.name} className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg)] py-0.5 cursor-pointer">
          <input type="checkbox" checked={selSkills.has(s.name)} onChange={() => setSelSkills((p) => toggle(p, s.name))} />
          {s.name}
        </label>
      ))}
      <p className="text-[10px] text-[var(--color-fg3)] mt-1.5 mb-1">MCPs</p>
      {mcps.length === 0 && <p className="text-[10px] text-[var(--color-fg3)]">none</p>}
      {mcps.map((m) => (
        <label key={m.name} className="flex items-center gap-1.5 text-[11px] text-[var(--color-fg)] py-0.5 cursor-pointer">
          <input type="checkbox" checked={selMcps.has(m.name)} onChange={() => setSelMcps((p) => toggle(p, m.name))} />
          {m.name}
        </label>
      ))}
      <div className="flex items-center gap-1.5 mt-2">
        <button
          onClick={() => onSave({ skills: [...selSkills], mcps: [...selMcps] })}
          disabled={busy}
          className="text-[10.5px] px-2 py-1 rounded text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer disabled:opacity-40"
        >
          Save
        </button>
        <button onClick={onClose} className="text-[10.5px] px-1.5 py-1 rounded text-[var(--color-fg2)] hover:bg-[var(--color-bg2)] cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  );
}

function SpawnDialog({ agent, targets, onClose, onSpawn }: {
  agent: CatalogResource;
  targets: SpawnTarget[];
  onClose: () => void;
  onSpawn: (cli: CatalogCli, repoPath: string) => void;
}) {
  const [cli, setCli] = useState<CatalogCli>("claude");
  const [repo, setRepo] = useState<string>(targets[0]?.repoPath ?? "");
  return (
    <div className="fixed inset-0 z-[70] grid place-items-center bg-black/40" onClick={onClose}>
      <div
        onClick={(e) => e.stopPropagation()}
        className="w-[380px] rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] p-4 shadow-2xl"
      >
        <h2 className="text-[13px] font-semibold text-[var(--color-fg)] mb-1">Spawn {agent.name}</h2>
        <p className="text-[11px] text-[var(--color-fg2)] mb-3">
          Its {agent.skills.length} skill(s) and {agent.mcps.length} mcp(s) will be applied to the workspace first.
        </p>
        <label className="block text-[11px] text-[var(--color-fg3)] mb-1">Agent CLI</label>
        <select
          value={cli}
          onChange={(e) => setCli(e.target.value as CatalogCli)}
          className="w-full mb-3 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md text-[12px] text-[var(--color-fg)] px-2 py-1.5 outline-none focus:border-[var(--color-brand)]"
        >
          {CLIS.map((c) => <option key={c} value={c}>{c}</option>)}
        </select>
        <label className="block text-[11px] text-[var(--color-fg3)] mb-1">Workspace</label>
        <select
          value={repo}
          onChange={(e) => setRepo(e.target.value)}
          className="w-full mb-4 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md text-[12px] text-[var(--color-fg)] px-2 py-1.5 outline-none focus:border-[var(--color-brand)]"
        >
          {targets.map((t) => <option key={t.id} value={t.repoPath}>{t.label}</option>)}
        </select>
        <div className="flex items-center justify-end gap-2">
          <button onClick={onClose} className="text-[12px] px-3 py-1.5 rounded-md text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] cursor-pointer">
            Cancel
          </button>
          <button
            onClick={() => repo && onSpawn(cli, repo)}
            disabled={!repo}
            className="inline-flex items-center gap-1.5 text-[12px] px-3 py-1.5 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer disabled:opacity-40"
          >
            <Rocket size={13} /> Spawn
          </button>
        </div>
      </div>
    </div>
  );
}
