/**
 * TileIssueLinkerModal — pick a hivemind issue to associate a running agent
 * tile with (or unlink it). Opened from a terminal tile's "link to task"
 * header button (which fires `hivemind:open-tile-issue-linker` {tileId};
 * Canvas owns the open state and renders this). Writing the association goes
 * back through `hivemind:link-tile-to-issue` so the SAME handler serves both
 * this modal and the issue-peek's reverse "associate a terminal" flow.
 *
 * The issue list comes from the app's workspace root; a search box filters by
 * id / title / AB# remote id. This is the tile→issue half of the bidirectional
 * link; the issue→tile half lives in IssuePeek.
 */
import { useMemo, useState } from "react";
import { Link2, Unlink, X, Search } from "lucide-react";
import { useIssues } from "./queries";
import type { IssueSummary } from "@hivemind/core/types";

export function TileIssueLinkerModal({
  tileId,
  root,
  currentIssueId,
  open,
  onOpenChange,
}: {
  /** The agent tile being linked. */
  tileId: string | null;
  /** App workspace `.hivemind` root the issue list is drawn from. */
  root: string | null;
  /** The issue this tile is currently linked to (to show + offer unlink). */
  currentIssueId?: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
}) {
  const { data: issues = [] } = useIssues(open ? root : null);
  const [q, setQ] = useState("");

  const filtered = useMemo(() => {
    const needle = q.trim().toLowerCase();
    const rows = issues.filter((i) => i.state !== "cancelled");
    if (!needle) return rows.slice(0, 50);
    return rows
      .filter((i) => {
        const ab = (i.sync ?? [])
          .map((s) => `ab#${s.externalId}`)
          .join(" ")
          .toLowerCase();
        return (
          i.id.toLowerCase().includes(needle) ||
          i.title.toLowerCase().includes(needle) ||
          ab.includes(needle)
        );
      })
      .slice(0, 50);
  }, [issues, q]);

  if (!open || !tileId) return null;

  const link = (issue: IssueSummary | null) => {
    window.dispatchEvent(
      new CustomEvent("hivemind:link-tile-to-issue", {
        detail: issue
          ? { tileId, issueId: issue.id, root }
          : { tileId, clear: true },
      }),
    );
    onOpenChange(false);
  };

  const abFor = (i: IssueSummary): string | null => {
    const s = (i.sync ?? []).find(
      (x) => x.provider === "azure-devops" && x.externalId && x.externalId !== "__pending__",
    );
    return s ? `AB#${s.externalId}` : null;
  };

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-center bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[440px] max-w-[92vw] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl p-4"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2">
          <Link2 size={16} className="text-[var(--color-fg2)]" />
          <h2 className="text-[15px] font-semibold text-[var(--color-fg)]">Link agent to a task</h2>
          <button
            onClick={() => onOpenChange(false)}
            className="ml-auto size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>

        {currentIssueId && (
          <div className="mt-2 flex items-center gap-2 text-[12px] text-[var(--color-fg2)]">
            <span>
              Currently linked to <span className="font-mono font-semibold text-[var(--color-fg)]">{currentIssueId}</span>
            </span>
            <button
              onClick={() => link(null)}
              className="ml-auto inline-flex items-center gap-1 h-6 px-2 rounded border border-[var(--color-line2)] text-[var(--color-fg2)] hover:text-[var(--color-err)] hover:border-[var(--color-err)]/50 text-[11px] cursor-pointer"
              title="Remove the association"
            >
              <Unlink size={11} aria-hidden />
              Unlink
            </button>
          </div>
        )}

        <div className="mt-3 flex items-center gap-2 bg-[var(--color-bg)] border border-[var(--color-line2)] rounded-md px-2.5 py-1.5 focus-within:border-[var(--color-brand)]">
          <Search size={13} className="text-[var(--color-fg3)]" aria-hidden />
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search issues by id, title, or AB#…"
            className="flex-1 bg-transparent text-[13px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]"
            aria-label="Search issues"
          />
        </div>

        <ul className="mt-2 max-h-[320px] overflow-y-auto border border-[var(--color-line2)] rounded-md divide-y divide-[var(--color-line)]">
          {filtered.length === 0 && (
            <li className="px-3 py-4 text-center text-[12px] text-[var(--color-fg3)]">No matching issues.</li>
          )}
          {filtered.map((i) => {
            const ab = abFor(i);
            const isCurrent = i.id === currentIssueId;
            return (
              <li key={i.id}>
                <button
                  onClick={() => link(i)}
                  disabled={isCurrent}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-left hover:bg-[var(--color-bg3)] disabled:opacity-50 disabled:cursor-not-allowed cursor-pointer"
                >
                  <span className="font-mono text-[11px] font-semibold text-[var(--color-fg2)] shrink-0">{i.id}</span>
                  {ab && <span className="font-mono text-[10px] text-[var(--color-info)] shrink-0">{ab}</span>}
                  <span className="text-[12px] text-[var(--color-fg)] truncate">{i.title}</span>
                  {isCurrent && <span className="ml-auto text-[10px] text-[var(--color-fg3)]">linked</span>}
                </button>
              </li>
            );
          })}
        </ul>
      </div>
    </div>
  );
}
