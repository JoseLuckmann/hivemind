/**
 * FilePickerModal — pick ONE file from a workspace to open in a single-file
 * tile. Reuses `FileTreeTile` (the same explorer the Editor tile's sidebar
 * uses) for real OS-like folder navigation — expand/collapse, git-status
 * decoration, and Pierre's built-in ⌘P fuzzy search — instead of a flat
 * filtered list, so this reads the same as the Editor's tree, just in a modal.
 */
import { X } from "lucide-react";
import { FileTreeTile } from "./FileTreeTile";

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
  if (!open) return null;

  const choose = (f: string) => { onPick(f); onOpenChange(false); };

  return (
    <div className="fixed inset-0 z-[10000] grid place-items-start justify-center pt-[12vh] bg-black/50" onClick={() => onOpenChange(false)}>
      <div
        className="w-[560px] max-w-[92vw] h-[60vh] max-h-[640px] bg-[var(--color-bg2)] border border-[var(--color-line2)] rounded-lg shadow-2xl overflow-hidden flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center gap-2 px-3 h-11 shrink-0 border-b border-[var(--color-line)]">
          <span className="text-[13px] font-semibold text-[var(--color-fg)]">Open a file</span>
          <span className="text-[11px] text-[var(--color-fg3)]">⌘P to search</span>
          <button
            onClick={() => onOpenChange(false)}
            className="ml-auto size-6 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
            aria-label="close"
          >
            <X size={14} />
          </button>
        </div>
        <div className="flex-1 min-h-0">
          {!repoPath ? (
            <div className="px-3 py-6 text-center text-[12px] text-[var(--color-fg3)]">No workspace repo for this frame.</div>
          ) : (
            <FileTreeTile key={repoPath} repoPath={repoPath} onSelectFile={choose} embedded />
          )}
        </div>
      </div>
    </div>
  );
}
