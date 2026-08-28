/**
 * CatalogPanel — the personal agent marketplace, as an APPLICATION panel (not a
 * canvas tile). It's a full-screen overlay opened by a button, like Settings.
 *
 * The journey it serves:
 *   - Click a button → see every agent / skill / mcp you've authored.
 *   - Create a new agent / skill / mcp; edit an existing one (opens its
 *     canonical file in your OS editor — edits propagate to every summon).
 *   - Associate skills (and mcps) with an agent — a checkbox matrix that writes
 *     the agent's manifest.
 *   - Spawn an agent (claude / codex / …) into a workspace WITH its associated
 *     resources applied (summon-bundle → then launch the CLI).
 *
 * The catalog lives once in ~/.config/hivemind/catalog/; this panel is the CRUD
 * surface over it. Data flows through the TanStack hooks in queries.ts.
 */
import { useMemo, useState } from "react";
import { X, Bot, Sparkles, Plug, Plus, Pencil, Trash2, Rocket, Link2 } from "lucide-react";
import {
  useCatalog,
  useCreateResource,
  useRemoveResource,
  useSetAssociations,
} from "./queries";
import type { CatalogResource, CatalogResourceKind, CatalogCli } from "../../shared/ipc";

/** A workspace an agent can be spawned into (a frame bound to a repo). */
export interface SpawnTarget {
  id: string;
  label: string;
  repoPath: string;
}

interface Props {
  open: boolean;
  onClose: () => void;
  /** Frames the user can spawn an agent into. */
  targets: SpawnTarget[];
  /** Spawn a catalog agent into a frame's workspace with its resources applied.
   *  App wires this to: summon-bundle → launch the CLI in that frame. */
  onSpawn: (opts: { agentName: string; cli: CatalogCli; repoPath: string }) => void;
}

const KIND_META: Record<CatalogResourceKind, { icon: React.ReactNode; label: string }> = {
  agent: { icon: <Bot size={15} />, label: "Agents" },
  skill: { icon: <Sparkles size={15} />, label: "Skills" },
  mcp: { icon: <Plug size={15} />, label: "MCPs" },
};
const CLIS: CatalogCli[] = ["claude", "codex", "kiro"];

export function CatalogPanel({ open, onClose, targets, onSpawn }: Props) {
  const catalog = useCatalog();
  const create = useCreateResource();
  const remove = useRemoveResource();
  const setAssoc = useSetAssociations();

  const [creating, setCreating] = useState<CatalogResourceKind | null>(null);
  const [assocFor, setAssocFor] = useState<string | null>(null);
  const [spawnFor, setSpawnFor] = useState<CatalogResource | null>(null);

  const { agents, skills, mcps } = useMemo(() => {
    const a: CatalogResource[] = [], s: CatalogResource[] = [], m: CatalogResource[] = [];
    for (const r of catalog.data ?? []) {
      if (r.kind === "agent") a.push(r);
      else if (r.kind === "skill") s.push(r);
      else m.push(r);
    }
    return { agents: a, skills: s, mcps: m };
  }, [catalog.data]);

  if (!open) return null;

  async function edit(r: CatalogResource) {
    await window.hive.catalogOpen(r.kind, r.name);
  }

  return (
    <div className="fixed inset-0 z-[60] flex flex-col bg-[var(--color-bg)]">
      {/* header */}
      <header className="flex items-center gap-3 px-5 h-14 border-b border-[var(--color-line)] shrink-0">
        <Bot size={18} className="text-[var(--color-brand)]" />
        <div className="flex flex-col">
          <h1 className="text-[15px] font-semibold text-[var(--color-fg)] leading-none">Agent Catalog</h1>
          <span className="text-[11px] text-[var(--color-fg3)] mt-0.5">
            Your reusable agents, skills & MCPs — authored once, summoned anywhere.
          </span>
        </div>
        <div className="flex-1" />
        <button
          onClick={onClose}
          aria-label="Close catalog"
          className="grid place-items-center size-8 rounded-lg text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer transition-colors"
        >
          <X size={18} />
        </button>
      </header>

      {/* body: three columns */}
      <div className="flex-1 min-h-0 grid grid-cols-3 divide-x divide-[var(--color-line2)] overflow-hidden">
        <Column
          kind="agent"
          items={agents}
          creating={creating === "agent"}
          onStartCreate={() => setCreating("agent")}
          onCancelCreate={() => setCreating(null)}
          createBusy={create.isPending}
          onCreate={(name) => create.mutate({ kind: "agent", name }, { onSuccess: () => setCreating(null) })}
          onEdit={edit}
          onRemove={(r) => confirm(`Remove agent/${r.name}?`) && remove.mutate({ kind: r.kind, name: r.name })}
          renderExtra={(r) => (
            <div className="flex items-center gap-1">
              <button
                onClick={() => setAssocFor(assocFor === r.name ? null : r.name)}
                title="Associate skills / mcps"
                aria-label={`Associate resources with ${r.name}`}
                className="grid place-items-center size-6 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer"
              >
                <Link2 size={13} />
              </button>
              <button
                onClick={() => setSpawnFor(r)}
                title="Spawn this agent into a workspace"
                aria-label={`Spawn ${r.name}`}
                disabled={targets.length === 0}
                className="grid place-items-center size-6 rounded text-[var(--color-brand)] hover:bg-[var(--color-bg3)] cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed"
              >
                <Rocket size={13} />
              </button>
            </div>
          )}
          renderBelow={(r) =>
            assocFor === r.name ? (
              <AssociationEditor
                agent={r}
                skills={skills}
                mcps={mcps}
                busy={setAssoc.isPending}
                onSave={(sel) =>
                  setAssoc.mutate(
                    { name: r.name, skills: sel.skills, mcps: sel.mcps },
                    { onSuccess: () => setAssocFor(null) },
                  )
                }
                onClose={() => setAssocFor(null)}
              />
            ) : r.skills.length > 0 || r.mcps.length > 0 ? (
              <div className="px-2 pb-1.5 text-[10px] text-[var(--color-fg3)]">
                {[...r.skills.map((s) => `skill:${s}`), ...r.mcps.map((m) => `mcp:${m}`)].join("  ·  ")}
              </div>
            ) : null
          }
        />
        <Column
          kind="skill"
          items={skills}
          creating={creating === "skill"}
          onStartCreate={() => setCreating("skill")}
          onCancelCreate={() => setCreating(null)}
          createBusy={create.isPending}
          onCreate={(name) => create.mutate({ kind: "skill", name }, { onSuccess: () => setCreating(null) })}
          onEdit={edit}
          onRemove={(r) => confirm(`Remove skill/${r.name}?`) && remove.mutate({ kind: r.kind, name: r.name })}
        />
        <Column
          kind="mcp"
          items={mcps}
          creating={creating === "mcp"}
          onStartCreate={() => setCreating("mcp")}
          onCancelCreate={() => setCreating(null)}
          createBusy={create.isPending}
          onCreate={(name) => create.mutate({ kind: "mcp", name }, { onSuccess: () => setCreating(null) })}
          onEdit={edit}
          onRemove={(r) => confirm(`Remove mcp/${r.name}?`) && remove.mutate({ kind: r.kind, name: r.name })}
        />
      </div>

      {spawnFor && (
        <SpawnDialog
          agent={spawnFor}
          targets={targets}
          onClose={() => setSpawnFor(null)}
          onSpawn={(cli, repoPath) => {
            onSpawn({ agentName: spawnFor.name, cli, repoPath });
            setSpawnFor(null);
            onClose();
          }}
        />
      )}
    </div>
  );
}

/** One kind's column: header + create + list. */
function Column({
  kind, items, creating, onStartCreate, onCancelCreate, createBusy, onCreate,
  onEdit, onRemove, renderExtra, renderBelow,
}: {
  kind: CatalogResourceKind;
  items: CatalogResource[];
  creating: boolean;
  onStartCreate: () => void;
  onCancelCreate: () => void;
  createBusy: boolean;
  onCreate: (name: string) => void;
  onEdit: (r: CatalogResource) => void;
  onRemove: (r: CatalogResource) => void;
  renderExtra?: (r: CatalogResource) => React.ReactNode;
  renderBelow?: (r: CatalogResource) => React.ReactNode;
}) {
  const meta = KIND_META[kind];
  return (
    <section className="flex flex-col min-h-0 overflow-hidden">
      <header className="flex items-center gap-2 px-4 h-11 border-b border-[var(--color-line2)] shrink-0 text-[var(--color-fg2)]">
        {meta.icon}
        <span className="text-[12.5px] font-medium text-[var(--color-fg)]">{meta.label}</span>
        <span className="text-[11px] text-[var(--color-fg3)] tabular-nums">{items.length}</span>
        <div className="flex-1" />
        <button
          onClick={onStartCreate}
          aria-label={`New ${kind}`}
          className="grid place-items-center size-6 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer"
        >
          <Plus size={15} />
        </button>
      </header>
      <div className="flex-1 overflow-auto p-2">
        {creating && (
          <NewRow kind={kind} busy={createBusy} onCreate={onCreate} onCancel={onCancelCreate} />
        )}
        {items.length === 0 && !creating && (
          <p className="px-2 py-3 text-[11.5px] text-[var(--color-fg3)] leading-relaxed">
            No {kind}s yet. Click <Plus size={11} className="inline -mt-0.5" /> to create one.
          </p>
        )}
        {items.map((r) => (
          <div key={r.name} className="rounded-md hover:bg-[var(--color-bg2)]">
            <div className="group flex items-center gap-2 px-2 py-1.5">
              <span className="flex-1 min-w-0 truncate text-[12.5px] text-[var(--color-fg)]" title={r.title}>
                {r.name}
                {r.tags.length > 0 && (
                  <span className="ml-1.5 text-[10px] text-[var(--color-fg3)]">{r.tags.join(", ")}</span>
                )}
              </span>
              {renderExtra?.(r)}
              <button
                onClick={() => onEdit(r)}
                aria-label={`Edit ${r.name}`}
                title="Edit canonical file"
                className="grid place-items-center size-6 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer opacity-0 group-hover:opacity-100"
              >
                <Pencil size={13} />
              </button>
              <button
                onClick={() => onRemove(r)}
                aria-label={`Remove ${r.name}`}
                title="Remove from catalog"
                className="grid place-items-center size-6 rounded text-[var(--color-fg3)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg3)] cursor-pointer opacity-0 group-hover:opacity-100"
              >
                <Trash2 size={13} />
              </button>
            </div>
            {renderBelow?.(r)}
          </div>
        ))}
      </div>
    </section>
  );
}

/** Inline name input for creating a resource. */
function NewRow({ kind, busy, onCreate, onCancel }: {
  kind: CatalogResourceKind; busy: boolean; onCreate: (n: string) => void; onCancel: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-1.5 px-2 py-1.5 mb-1">
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && name.trim()) onCreate(name.trim());
          if (e.key === "Escape") onCancel();
        }}
        placeholder={`new-${kind}-name`}
        aria-label={`New ${kind} name`}
        className="flex-1 bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md text-[11.5px] text-[var(--color-fg)] px-2 py-1 outline-none focus:border-[var(--color-brand)]"
      />
      <button
        onClick={() => name.trim() && onCreate(name.trim())}
        disabled={busy || !name.trim()}
        className="text-[11px] px-2 py-1 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer disabled:opacity-40"
      >
        Create
      </button>
      <button onClick={onCancel} className="text-[11px] px-1.5 py-1 rounded-md text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] cursor-pointer">
        Cancel
      </button>
    </div>
  );
}

/** Checkbox matrix to associate skills + mcps with an agent. */
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
    <div className="mx-2 mb-2 p-2 rounded-md border border-[var(--color-line2)] bg-[var(--color-bg3)]">
      <p className="text-[10.5px] text-[var(--color-fg3)] mb-1.5">Skills for {agent.name}</p>
      {skills.length === 0 && <p className="text-[10.5px] text-[var(--color-fg3)]">no skills yet</p>}
      {skills.map((s) => (
        <label key={s.name} className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-fg)] py-0.5 cursor-pointer">
          <input type="checkbox" checked={selSkills.has(s.name)} onChange={() => setSelSkills((p) => toggle(p, s.name))} />
          {s.name}
        </label>
      ))}
      <p className="text-[10.5px] text-[var(--color-fg3)] mt-2 mb-1.5">MCPs for {agent.name}</p>
      {mcps.length === 0 && <p className="text-[10.5px] text-[var(--color-fg3)]">no mcps yet</p>}
      {mcps.map((m) => (
        <label key={m.name} className="flex items-center gap-1.5 text-[11.5px] text-[var(--color-fg)] py-0.5 cursor-pointer">
          <input type="checkbox" checked={selMcps.has(m.name)} onChange={() => setSelMcps((p) => toggle(p, m.name))} />
          {m.name}
        </label>
      ))}
      <div className="flex items-center gap-1.5 mt-2">
        <button
          onClick={() => onSave({ skills: [...selSkills], mcps: [...selMcps] })}
          disabled={busy}
          className="text-[11px] px-2 py-1 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer disabled:opacity-40"
        >
          Save
        </button>
        <button onClick={onClose} className="text-[11px] px-1.5 py-1 rounded-md text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] cursor-pointer">
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Pick a CLI + target workspace, then spawn the agent (with its resources). */
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
