/**
 * FilePickerModal — a searchable list of a workspace's files, for choosing which
 * ONE file to open in a single-file tile. Backed by `gitListFiles` (same source
 * as the explorer), so it lists tracked + untracked-non-ignored files scoped to
 * the given repo. Fuzzy-ish substring filter, keyboard navigable (↑/↓/Enter/Esc).
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Search, X } from "lucide-react";
import { useGitListFiles } from "./queries";

export function FilePickerModal({
  repoPath,
  open,
  onOpenChange,
  onPick,
}: {
  repoPath: string | null;
  open: boolean;
  onOpenChange: (o: boolean) => void;
  /** Chosen repo-relative path. */
  onPick: (file: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [activeIdx, setActiveIdx] = useState(0);
  const listRef = useRef<HTMLDivElement>(null);
  const { data: files = [], isLoading } = useGitListFiles(open ? repoPath : null);

  useEffect(() => { if (open) { setQuery(""); setActiveIdx(0); } }, [open]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = q
      ? files.filter((f) => f.toLowerCase().includes(q))
      : files;
    // Prefer shorter paths (top-level configs/specs surface first), then alpha.
    return [...list].sort((a, b) => a.length - b.length || a.localeCompare(b)).slice(0, 500);
  }, [files, query]);

  // Keep the active index in range as the filter changes.
  useEffect(() => { setActiveIdx((i) => Math.min(i, Math.max(0, filtered.length - 1))); }, [filtered.length]);

  if (!open) return null;

  const choose = (f: string) => { onPick(f); onOpenChange(false); };

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-start justify-center pt-[12vh] bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[560px] max-w-[92vw] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 h-11 border-b border-[var(--color-line)]">
          <Search size={15} className="text-[var(--color-fg3)] shrink-0" />
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "ArrowDown") { e.preventDefault(); setActiveIdx((i) => Math.min(i + 1, filtered.length - 1)); }
              else if (e.key === "ArrowUp") { e.preventDefault(); setActiveIdx((i) => Math.max(i - 1, 0)); }
              else if (e.key === "Enter") { e.preventDefault(); const f = filtered[activeIdx]; if (f) choose(f); }
              else if (e.key === "Escape") { e.preventDefault(); onOpenChange(false); }
            }}
            placeholder="Open a file… (specs, config, …)"
            className="flex-1 bg-transparent text-[13px] text-[var(--color-fg)] outline-none placeholder:text-[var(--color-fg3)]"
            aria-label="Filter files"
          />
          <button
            onClick={() => onOpenChange(false)}
            className="size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>
        <div ref={listRef} className="max-h-[50vh] overflow-y-auto py-1">
          {!repoPath ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--color-fg3)]">No workspace repo for this frame.</div>
          ) : isLoading ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--color-fg3)]">Loading files…</div>
          ) : filtered.length === 0 ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--color-fg3)]">No files match.</div>
          ) : (
            filtered.map((f, i) => {
              const name = f.split("/").pop() ?? f;
              const dir = f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
              const active = i === activeIdx;
              return (
                <button
                  key={f}
                  onMouseEnter={() => setActiveIdx(i)}
                  onClick={() => choose(f)}
                  ref={active ? (el) => el?.scrollIntoView({ block: "nearest" }) : undefined}
                  className={`flex items-center gap-2 w-full text-left px-3 py-1.5 text-[12px] ${
                    active ? "bg-[var(--surface-4)] text-[var(--color-fg)]" : "text-[var(--color-fg2)] hover:bg-[var(--surface-3)]"
                  }`}
                >
                  <FileText size={13} className="shrink-0 text-[var(--color-fg3)]" />
                  <span className="truncate font-medium">{name}</span>
                  {dir && <span className="truncate text-[var(--color-fg3)] font-mono text-[11px] min-w-0">{dir}</span>}
                </button>
              );
            })
          )}
        </div>
      </div>
    </div>
  );
}
