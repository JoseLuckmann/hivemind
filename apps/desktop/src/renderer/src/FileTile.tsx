/**
 * FileTile — a lightweight SINGLE-FILE editor. It edits exactly one workspace
 * file (a spec, a config, …) with no explorer and no tab switching — the fast
 * path when you just need to touch one file tied to a workspace.
 *
 * It REUSES the existing editor wholesale: `EditorTile` in `embedded` mode with
 * a one-element `tabs` list. That hands us CodeMirror, syntax highlight,
 * dirty/save (fileRead/fileWrite), find/replace, and markdown Preview for free —
 * the single-file tile is just a thin shell around it, so behaviour and future
 * editor improvements stay in one place.
 *
 * Canvas owns the file path (persisted on the TileInstance as `file`); this tile
 * is presentational. Closing the tab isn't offered (a single-file tile IS its
 * file) — the tile's × closes the whole tile instead.
 */
import { useMemo } from "react";
import { FileText } from "lucide-react";
import { EditorTile } from "./EditorTile";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";

interface Props {
  repoPath: string;
  /** The ONE repo-relative file this tile edits. */
  file: string;
  /** Close the whole tile. */
  onClose: () => void;
  /** Open a URL in the frame's browser tile (markdown links, html preview). */
  onOpenInBrowser?: (url: string) => void;
  /** Pin state + toggle (injected via node data) — docked in the header. */
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

export function FileTile({ repoPath, file, onClose, onOpenInBrowser, pinned, onTogglePin }: Props) {
  // Fixed single-tab list. Memoized so EditorTile's tab-resolution effect isn't
  // handed a fresh array identity every render (which would churn its state).
  const tabs = useMemo(() => [file], [file]);
  const name = file.split("/").pop() ?? file;
  // Show the parent dir as context when it disambiguates (e.g. two config.yaml).
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <FileText aria-hidden size={13} className="text-[var(--color-fg3)] shrink-0" />
        <span className="font-semibold text-[var(--color-fg)] truncate">{name}</span>
        {dir && <span className="text-[var(--color-fg3)] truncate min-w-0">· {dir}</span>}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
          <button
            onClick={onClose}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="close tile"
            title="close"
          >×</button>
        </span>
      </header>
      <div className="flex-1 min-h-0">
        {/* key on repoPath+file so switching the bound file/repo remounts cleanly
            (EditorTile caches per-tab buffers keyed by path). onCloseTab is a
            no-op: a single-file tile has no tab to close (the × above closes it). */}
        <EditorTile
          key={`${repoPath}:${file}`}
          repoPath={repoPath}
          tabs={tabs}
          onCloseTab={() => {}}
          onOpenInBrowser={onOpenInBrowser}
          embedded
          singleFile
        />
      </div>
    </div>
  );
}
