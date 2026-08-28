/**
 * CatalogTile — the machine-global catalog of reusable *resources* (agents,
 * skills, mcps) as a first-class canvas tile. This is the "see + edit + summon"
 * surface: browse everything you've authored once, open a resource's canonical
 * file in the editor (edits propagate to every workspace that summoned it, since
 * summons are symlinks), create new ones, and **summon into a frame** — pick a
 * target frame + CLI and the resource projects into that workspace with the
 * right strategy (symlink for claude/kiro, marked-merge for codex).
 *
 * Presentational: Canvas injects the tile's own `repoPath`, the list of summon
 * `targets` (frames bound to a repo), and an `onEdit(path)` that opens the file
 * in an EditorTile. Data flows through the TanStack hooks in queries.ts.
 */
import { useMemo, useState } from "react";
import {
  Boxes,
  Bot,
  Sparkles,
  Plug,
  Plus,
  Pencil,
  Trash2,
  ArrowRightToLine,
  X,
} from "lucide-react";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import {
  useCatalog,
  useSummonList,
  useCreateResource,
  useRemoveResource,
  useSummon,
  useUnsummon,
} from "./queries";
import type { CatalogResource, CatalogResourceKind, CatalogCli } from "../../shared/ipc";

/** A place a resource can be summoned into — a frame bound to a repo. */
export interface SummonTarget {
  /** Frame id (for display/keys). */
  id: string;
  /** Human label (frame title). */
  label: string;
  /** The repo/worktree path the resource projects into. */
  repoPath: string;
}

interface Props {
  /** The tile's own frame repo (default summon target), or null if unbound. */
  repoPath: string | null;
  /** Frames the user can summon into (includes this tile's frame). */
  targets?: SummonTarget[];
  /** Open a resource's canonical file in an editor tile. */
  onEdit?: (path: string) => void;
  onClose: () => void;
  selected?: boolean;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

const KIND_ICON: Record<CatalogResourceKind, React.ReactNode> = {
  agent: <Bot size={13} />,
  skill: <Sparkles size={13} />,
  mcp: <Plug size={13} />,
};
const KIND_ORDER: CatalogResourceKind[] = ["agent", "skill", "mcp"];
const KIND_LABEL: Record<CatalogResourceKind, string> = {
  agent: "Agents",
  skill: "Skills",
  mcp: "MCPs",
};
const CLIS: CatalogCli[] = ["claude", "kiro", "codex"];

export function CatalogTile({
  repoPath,
  targets = [],
  onEdit,
  onClose,
  pinned,
  onTogglePin,
}: Props) {
  const catalog = useCatalog();
  const create = useCreateResource();
  const remove = useRemoveResource();

  // Summon target: default to this tile's frame, else the first target.
  const defaultTarget = repoPath ?? targets[0]?.repoPath ?? null;
  const [targetRepo, setTargetRepo] = useState<string | null>(defaultTarget);
  const [cli, setCli] = useState<CatalogCli>("claude");
  const [globalScope, setGlobalScope] = useState(false);
  const [creating, setCreating] = useState<CatalogResourceKind | null>(null);

  // The ledger key we read "already summoned" from: the global sentinel when in
  // global scope, else the selected repo. Mirrors core's GLOBAL_LEDGER_KEY.
  const ledgerRepo = globalScope ? "@global" : targetRepo;
  const summonList = useSummonList(ledgerRepo);
  const summon = useSummon();
  const unsummon = useUnsummon();

  // Which resource names are already summoned in the current target (by name).
  const summonedNames = useMemo(
    () => new Set((summonList.data?.summoned ?? []).map((e) => e.resource)),
    [summonList.data],
  );

  const grouped = useMemo(() => {
    const by: Record<CatalogResourceKind, CatalogResource[]> = { agent: [], skill: [], mcp: [] };
    for (const r of catalog.data ?? []) by[r.kind].push(r);
    return by;
  }, [catalog.data]);

  async function handleEdit(r: CatalogResource) {
    // The canonical file lives outside any workspace repo, so opening it in the
    // repo-relative EditorTile doesn't fit. Open it in the OS default editor —
    // edits hit the canonical file, so they propagate to every summon (symlink).
    const res = await window.hive.catalogOpen(r.kind, r.name);
    if (!res.ok && res.error) {
      // dev-bridge / no handler → hand the path to the injected onEdit fallback.
      if (onEdit && r.canonicalFile) onEdit(r.canonicalFile);
    }
  }

  return (
    <div className="flex flex-col h-full w-full bg-[var(--color-bg)] rounded-[inherit] overflow-hidden">
      {/* header */}
      <div className="hm-drag flex items-center gap-2 px-2.5 h-9 border-b border-[var(--color-line2)] shrink-0">
        <Boxes size={14} className="text-[var(--color-fg3)]" />
        <span className="text-[12px] font-medium text-[var(--color-fg)]">Catalog</span>
        <div className="flex-1" />
        {onTogglePin && <HeaderPinButton pinned={!!pinned} onToggle={onTogglePin} />}
        <button
          onClick={onClose}
          aria-label="Close catalog"
          className="nodrag grid place-items-center w-6 h-6 rounded-md text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer hm-soft"
        >
          <X size={14} />
        </button>
      </div>

      {/* summon-target toolbar */}
      <div className="nodrag flex items-center gap-2 px-2.5 py-1.5 border-b border-[var(--color-line2)] shrink-0 text-[11px]">
        <span className="text-[var(--color-fg3)]">Summon to</span>
        <select
          value={targetRepo ?? ""}
          onChange={(e) => setTargetRepo(e.target.value || null)}
          aria-label="Summon target frame"
          className="bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md text-[11.5px] text-[var(--color-fg)] px-1.5 py-1 outline-none cursor-pointer hm-soft focus:border-[var(--color-brand)] max-w-[160px]"
        >
          {targets.length === 0 && repoPath && <option value={repoPath}>this frame</option>}
          {targets.map((t) => (
            <option key={t.id} value={t.repoPath}>
              {t.label}
            </option>
          ))}
          {targets.length === 0 && !repoPath && <option value="">no frame</option>}
        </select>
        <select
          value={cli}
          onChange={(e) => setCli(e.target.value as CatalogCli)}
          aria-label="Target CLI"
          className="bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md text-[11.5px] text-[var(--color-fg)] px-1.5 py-1 outline-none cursor-pointer hm-soft focus:border-[var(--color-brand)]"
        >
          {CLIS.map((c) => (
            <option key={c} value={c}>
              {c}
            </option>
          ))}
        </select>
        <label className="inline-flex items-center gap-1 text-[var(--color-fg2)] cursor-pointer" title="Summon into the CLI's machine-global scope (~/.claude etc.) instead of this repo">
          <input
            type="checkbox"
            checked={globalScope}
            onChange={(e) => setGlobalScope(e.target.checked)}
            aria-label="Global scope"
            className="cursor-pointer"
          />
          global
        </label>
      </div>

      {/* body */}
      <div className="flex-1 overflow-auto px-2 py-2">
        {catalog.isLoading && (
          <div className="text-[11.5px] text-[var(--color-fg3)] px-1">Loading catalog…</div>
        )}
        {catalog.data && catalog.data.length === 0 && (
          <div className="text-[11.5px] text-[var(--color-fg2)] px-1 leading-relaxed">
            Your catalog is empty. Create an agent, skill, or MCP below — it lives once in{" "}
            <code>~/.config/hivemind/catalog/</code> and you summon it into any workspace.
          </div>
        )}

        {KIND_ORDER.map((kind) => (
          <section key={kind} className="mb-3">
            <header className="flex items-center gap-1.5 px-1 mb-1 text-[var(--color-fg3)]">
              {KIND_ICON[kind]}
              <span className="u-eyebrow text-[10.5px]">{KIND_LABEL[kind]}</span>
              <div className="flex-1" />
              <button
                onClick={() => setCreating(kind)}
                aria-label={`New ${kind}`}
                className="nodrag grid place-items-center w-5 h-5 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer hm-soft"
              >
                <Plus size={13} />
              </button>
            </header>

            {creating === kind && (
              <NewResourceRow
                kind={kind}
                busy={create.isPending}
                onCancel={() => setCreating(null)}
                onCreate={(name) => {
                  create.mutate(
                    { kind, name },
                    { onSuccess: () => setCreating(null) },
                  );
                }}
              />
            )}

            {grouped[kind].map((r) => {
              const isSummoned = summonedNames.has(r.name);
              return (
                <div
                  key={r.name}
                  className="group flex items-center gap-2 px-1.5 py-1 rounded-md hover:bg-[var(--color-bg2)] hm-soft"
                >
                  <span className="text-[12px] text-[var(--color-fg)] truncate flex-1" title={r.title}>
                    {r.name}
                    {r.tags.length > 0 && (
                      <span className="ml-1.5 text-[10px] text-[var(--color-fg3)]">
                        {r.tags.join(", ")}
                      </span>
                    )}
                  </span>

                  {isSummoned ? (
                    <button
                      onClick={() =>
                        targetRepo &&
                        unsummon.mutate({
                          name: r.name,
                          workspaceRoot: globalScope ? "@global" : targetRepo,
                          cli,
                          scope: globalScope ? "global" : "project",
                        })
                      }
                      className="nodrag text-[10.5px] px-1.5 py-0.5 rounded text-[var(--color-fg2)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer hm-soft"
                      title="Unsummon from the selected target"
                    >
                      summoned ✓
                    </button>
                  ) : (
                    <button
                      onClick={() =>
                        targetRepo &&
                        summon.mutate({
                          kind: r.kind,
                          name: r.name,
                          workspaceRoot: targetRepo,
                          cli,
                          scope: globalScope ? "global" : "project",
                        })
                      }
                      disabled={!targetRepo && !globalScope}
                      aria-label={`Summon ${r.name}`}
                      className="nodrag inline-flex items-center gap-1 text-[10.5px] px-1.5 py-0.5 rounded text-[var(--color-brand)] hover:bg-[var(--color-bg3)] cursor-pointer hm-soft disabled:opacity-40 disabled:cursor-not-allowed opacity-0 group-hover:opacity-100"
                      title="Summon into the selected target"
                    >
                      <ArrowRightToLine size={12} /> summon
                    </button>
                  )}

                  <button
                    onClick={() => handleEdit(r)}
                    aria-label={`Edit ${r.name}`}
                    className="nodrag grid place-items-center w-5 h-5 rounded text-[var(--color-fg3)] hover:text-[var(--color-fg)] hover:bg-[var(--color-bg3)] cursor-pointer hm-soft opacity-0 group-hover:opacity-100"
                    title="Edit the canonical file"
                  >
                    <Pencil size={12} />
                  </button>
                  <button
                    onClick={() => {
                      if (confirm(`Remove ${r.kind}/${r.name} from the catalog?`))
                        remove.mutate({ kind: r.kind, name: r.name });
                    }}
                    aria-label={`Remove ${r.name}`}
                    className="nodrag grid place-items-center w-5 h-5 rounded text-[var(--color-fg3)] hover:text-[var(--color-danger)] hover:bg-[var(--color-bg3)] cursor-pointer hm-soft opacity-0 group-hover:opacity-100"
                    title="Remove from catalog"
                  >
                    <Trash2 size={12} />
                  </button>
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </div>
  );
}

/** Inline "new resource" name input. */
function NewResourceRow({
  kind,
  busy,
  onCreate,
  onCancel,
}: {
  kind: CatalogResourceKind;
  busy: boolean;
  onCreate: (name: string) => void;
  onCancel: () => void;
}) {
  const [name, setName] = useState("");
  return (
    <div className="flex items-center gap-1.5 px-1.5 py-1 mb-1">
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
        className="text-[11px] px-2 py-1 rounded-md text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft disabled:opacity-40"
      >
        Create
      </button>
      <button
        onClick={onCancel}
        className="text-[11px] px-1.5 py-1 rounded-md text-[var(--color-fg2)] hover:bg-[var(--color-bg3)] cursor-pointer hm-soft"
      >
        Cancel
      </button>
    </div>
  );
}
