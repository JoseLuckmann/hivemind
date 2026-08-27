/**
 * IssuesTile — the issue tracker as a first-class CANVAS tile.
 *
 * Linear/Plane-grade shell: a FilterBar (search + state/label/assignee filters)
 * with a toolbar (group-by, Board/List view switch, New), over a BoardView or
 * ListView. The board supports drag-between-columns ONLY when the tile is focused
 * (`selected`), so it never fights canvas drag-to-pan (the original reason DnD was
 * left out). Cards open the full IssuePeek; "work" spawns claude + delivers the
 * work prompt. Per-tile view + group-by persist in localStorage.
 */
import { useMemo, useState, useEffect, useRef } from "react";
import { GripVertical, Inbox, FolderGit2, Settings } from "lucide-react";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import { useTileFont, FontStepper, handleFontKey } from "./tile-font";
import type { IssueSummary } from "@hivemind/core/types";
import { useIssues, useSyncConfig } from "./queries";
import { FilterBar, emptyFilters, applyFilters, type Filters } from "./components/FilterBar";
import { ViewSwitcher, type ViewKind } from "./components/ViewSwitcher";
import { BoardView } from "./issues/BoardView";
import { ListView } from "./issues/ListView";
import { GROUP_BY_LABEL, GROUP_BY_ORDER, type GroupBy } from "./issues/grouping";

/** Centered, teaching empty/placeholder state. */
function TileEmpty({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex-1 grid place-items-center px-6 text-center">
      <div className="flex flex-col items-center gap-2 max-w-[240px]">
        <div className="text-[var(--color-fg3)]">{icon}</div>
        <div className="text-[12.5px] font-medium text-[var(--color-fg)]">{title}</div>
        <p className="text-[11.5px] text-[var(--color-fg2)] leading-relaxed">{hint}</p>
        {action && (
          <button
            onClick={action.onClick}
            className="mt-1 inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg text-[11.5px] font-medium text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft"
          >
            {action.label}
          </button>
        )}
      </div>
    </div>
  );
}

function GroupByMenu({ value, onChange }: { value: GroupBy; onChange: (g: GroupBy) => void }) {
  return (
    <label className="nodrag inline-flex items-center gap-1 text-[11px] text-[var(--color-fg2)]">
      <span className="text-[var(--color-fg3)]">Group</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as GroupBy)}
        aria-label="Group issues by"
        className="bg-[var(--color-bg3)] border border-[var(--color-line2)] rounded-md text-[11.5px] text-[var(--color-fg)] px-2 py-1 outline-none cursor-pointer hm-soft focus:border-[var(--color-brand)]"
      >
        {GROUP_BY_ORDER.map((g) => (
          <option key={g} value={g}>
            {GROUP_BY_LABEL[g]}
          </option>
        ))}
      </select>
    </label>
  );
}

interface Props {
  root: string | null;
  onClose?: () => void;
  /** Tile focus — gates board drag-and-drop so it doesn't fight canvas pan. */
  selected?: boolean;
  /** Pin state + toggle (injected via node data) — docked in the header. */
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

const viewKey = (root: string) => `hm:issues:view:${root}`;
const groupKey = (root: string) => `hm:issues:group:${root}`;
/** One-shot marker: we auto-seed the "my tasks" filter only the FIRST time a
 *  board with a known current user opens, so clearing the filter afterwards
 *  sticks instead of snapping back on the next render/mount. */
const mineSeededKey = (root: string) => `hm:issues:mine-seeded:${root}`;
const readLS = <T extends string>(k: string, fallback: T): T => {
  try {
    return (localStorage.getItem(k) as T) || fallback;
  } catch {
    return fallback;
  }
};

export function IssuesTile({ root, onClose, selected = false, pinned, onTogglePin }: Props) {
  const font = useTileFont(`issues:${root ?? "none"}`, 13);
  const { data: issues = [], isLoading } = useIssues(root);
  const { data: syncConfig } = useSyncConfig(root);
  const [filters, setFilters] = useState<Filters>(emptyFilters);
  const [view, setView] = useState<ViewKind>(() => (root ? readLS<ViewKind>(viewKey(root), "board") : "board"));
  const [groupBy, setGroupBy] = useState<GroupBy>(() => (root ? readLS<GroupBy>(groupKey(root), "state") : "state"));

  const setViewP = (v: ViewKind) => {
    setView(v);
    if (root) try { localStorage.setItem(viewKey(root), v); } catch { /* ignore */ }
  };
  const setGroupP = (g: GroupBy) => {
    setGroupBy(g);
    if (root) try { localStorage.setItem(groupKey(root), g); } catch { /* ignore */ }
  };

  const filtered = useMemo(() => applyFilters(issues, filters), [issues, filters]);

  // The current user, per this board's sync config (Azure `assignedTo`). Used to
  // default the board to "my tasks".
  const currentUser = useMemo(() => {
    const a = syncConfig?.settings?.assignedTo;
    return typeof a === "string" && a ? a : null;
  }, [syncConfig]);

  // Default the board to the current user's tasks, ONCE per board. Only seeds
  // when that user actually has issues here (so we don't hide everything on a
  // board where the assignee ids don't match), and records a marker so a manual
  // Clear afterwards is respected.
  const seededRef = useRef(false);
  useEffect(() => {
    if (!root || seededRef.current || !currentUser || issues.length === 0) return;
    let already = false;
    try { already = localStorage.getItem(mineSeededKey(root)) === "1"; } catch { /* ignore */ }
    if (already) { seededRef.current = true; return; }
    const mineCount = issues.filter((i) => i.assignee?.id === currentUser).length;
    if (mineCount > 0) {
      setFilters((f) => (f.assignees.size === 0 ? { ...f, assignees: new Set([currentUser]) } : f));
    }
    try { localStorage.setItem(mineSeededKey(root), "1"); } catch { /* ignore */ }
    seededRef.current = true;
  }, [root, currentUser, issues]);

  const workOn = async (issue: IssueSummary) => {
    // Ensure the repo has the hive MCP + work skill (idempotent), then hand the
    // task off to Canvas, which spawns the RIGHT agent in the task's WORKSPACE
    // and delivers a prompt carrying the task reference. The agent is the one
    // assigned to the task (issue.assignee when it's an agent), else the canvas
    // default. Canvas resolves the workspace frame from `root`.
    const repoDir = root ? root.replace(/\/\.hivemind\/?$/, "") : null;
    if (repoDir) {
      try { await window.hive.installAgentic(repoDir); } catch { /* best-effort */ }
    }
    const agent = issue.assignee?.type === "agent" ? issue.assignee.id : undefined;
    const model = issue.assignee?.type === "agent" ? issue.assignee.model : undefined;
    window.dispatchEvent(
      new CustomEvent("hivemind:work-on-issue", {
        detail: { root, id: issue.id, title: issue.title, agent, model },
      }),
    );
  };

  return (
    <div
      className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]"
      onKeyDownCapture={(e) => handleFontKey(e, font)}
    >
      <div className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <GripVertical aria-hidden size={13} className="text-[var(--color-fg3)] -ml-1 shrink-0" />
        <span className="font-semibold text-[var(--color-fg)]">Issues</span>
        <span className="ml-1 text-[var(--color-fg3)] tabular-nums">{issues.length}</span>
        <span className="ml-auto">
          <FontStepper {...font} />
        </span>
        <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
        <button
          className="nodrag size-5 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] cursor-pointer"
          aria-label="close tile"
          title="close"
          onClick={onClose}
        >
          <svg width="12" height="12" viewBox="0 0 14 14" aria-hidden><path d="M3 3l8 8M11 3l-8 8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" /></svg>
        </button>
      </div>

      {!root ? (
        <TileEmpty
          icon={<FolderGit2 size={26} strokeWidth={1.5} />}
          title="No workspace"
          hint="Open a project with a .hivemind/ folder to start tracking issues."
        />
      ) : isLoading ? (
        <div className="flex-1 grid place-items-center text-[11.5px] text-[var(--color-fg2)]">
          <span className="flex items-center gap-2"><span className="hm-spinner" aria-hidden />Loading issues…</span>
        </div>
      ) : (
        <>
          <FilterBar
            issues={issues}
            filters={filters}
            onChange={setFilters}
            rightSlot={
              <>
                <GroupByMenu value={groupBy} onChange={setGroupP} />
                <ViewSwitcher value={view} onChange={setViewP} views={["board", "list"]} />
                <button
                  onClick={() =>
                    root && window.dispatchEvent(new CustomEvent("hivemind:sync-settings", { detail: { root } }))
                  }
                  className="nodrag relative size-7 grid place-items-center rounded-lg text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] cursor-pointer"
                  aria-label="sync settings"
                  title={syncConfig ? `Synced with ${syncConfig.providerId}` : "Sync this board with a tracker"}
                >
                  <Settings size={14} />
                  {syncConfig && (
                    <span className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--color-brand)]" />
                  )}
                </button>
                <button
                  onClick={() => window.dispatchEvent(new CustomEvent("hivemind:new-issue"))}
                  className="nodrag inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-[11.5px] font-semibold text-white bg-[var(--color-brand)] hover:opacity-90 cursor-pointer hm-soft"
                >
                  + New
                </button>
              </>
            }
          />
          {issues.length === 0 ? (
            <TileEmpty
              icon={<Inbox size={26} strokeWidth={1.5} />}
              title="No issues yet"
              hint="Create your first issue to plan work and hand it to an agent."
              action={{ label: "New issue", onClick: () => window.dispatchEvent(new CustomEvent("hivemind:new-issue")) }}
            />
          ) : filtered.length === 0 ? (
            <TileEmpty
              icon={<Inbox size={26} strokeWidth={1.5} />}
              title="No matches"
              hint="No issues match the current filters."
            />
          ) : (
            <div
              // Board: only horizontal scroll here (columns own their own vertical
              // scroll, so a tall backlog scrolls INSIDE its column instead of
              // stretching the whole board). List: normal vertical scroll.
              className={`flex-1 min-h-0 p-2 ${view === "board" ? "overflow-x-auto overflow-y-hidden" : "overflow-auto"}`}
              style={{ zoom: font.size / 13 }}
            >
              {view === "board" ? (
                <BoardView
                  issues={filtered}
                  root={root}
                  groupBy={groupBy}
                  showCancelled={filters.showCancelled}
                  selected={selected}
                  onWork={workOn}
                />
              ) : (
                <ListView
                  issues={filtered}
                  root={root}
                  groupBy={groupBy}
                  showCancelled={filters.showCancelled}
                  onWork={workOn}
                />
              )}
            </div>
          )}
        </>
      )}
    </div>
  );
}
