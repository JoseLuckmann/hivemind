/**
 * FileExplorerTile — a standalone, OS-like file explorer for the canvas. Unlike
 * the Editor (`WorkbenchTile`), it is NOT tied to a frame's bound repo: it can be
 * pointed at ANY folder (a subfolder an agent writes into, a sibling worktree,
 * anywhere) via "Change folder…", and it explicitly guarantees that folder is
 * live-watched (`watchPath`) so new/changed/removed files show up without a
 * manual refresh — the point being to "leave a folder open" and watch what an
 * agent is doing inside it.
 *
 * VIEWING, not editing — that's what the Editor tile is for. The right pane is
 * an OS-style ICON GRID of the current folder's contents (files + subfolders),
 * not a file preview/editor: this is a Finder/Explorer window, not a mini-IDE.
 * Double-clicking a file opens it with the OS default app (`openPathInApp`,
 * the same hardened opener terminal file-links already use); double-clicking a
 * folder navigates the grid into it. The left tree (`FileTreeTile`, embedded)
 * is the navigation sidebar, exactly like a real OS explorer's folder tree —
 * clicking a directory there also navigates the grid (`onSelectDir`).
 *
 * Publishes live metadata (file count, last add/modify/remove) to
 * `explorer-status-bus` so other canvas surfaces can consume an Explorer tile's
 * state without prop drilling, the same way tile status chips consume
 * `agent-status-bus`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { FolderOpen, FolderTree, Folder, File, ChevronRight } from "lucide-react";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import { FileTreeTile } from "./FileTreeTile";
import { useGitListFiles } from "./queries";
import { publishExplorerStats, clearExplorerStats, type ExplorerFileEvent } from "./explorer-status-bus";

interface Props {
  id: string;
  /** Absolute folder this tile browses/watches. */
  folder: string;
  onSetFolder: (id: string, folder: string) => void;
  onClose: () => void;
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

const SIDEBAR_DEFAULT = 260;
const SIDEBAR_MIN = 160;
const SIDEBAR_MAX = 640;
const clampW = (w: number) => Math.min(SIDEBAR_MAX, Math.max(SIDEBAR_MIN, w));

/** Immediate children of `dir` (relative, no trailing slash; "" = root) from a
 *  flat repo-relative path list — the same derivation Pierre's tree does
 *  internally, done here so the icon grid can show ONE level (files + folder
 *  names) instead of a nested tree. */
function childrenOf(paths: string[], dir: string): { files: string[]; dirs: string[] } {
  const prefix = dir ? `${dir}/` : "";
  const files: string[] = [];
  const dirs = new Set<string>();
  for (const p of paths) {
    if (!p.startsWith(prefix)) continue;
    const rest = p.slice(prefix.length);
    if (!rest) continue;
    const slash = rest.indexOf("/");
    if (slash === -1) files.push(rest);
    else dirs.add(rest.slice(0, slash));
  }
  return { files: files.sort((a, b) => a.localeCompare(b)), dirs: Array.from(dirs).sort((a, b) => a.localeCompare(b)) };
}

export function FileExplorerTile({ id, folder, onSetFolder, onClose, pinned, onTogglePin }: Props) {
  const [currentDir, setCurrentDir] = useState("");
  const [sidebarW, setSidebarW] = useState(SIDEBAR_DEFAULT);
  const dragRef = useRef<{ startX: number; startW: number } | null>(null);
  const folderName = folder ? (folder.split("/").filter(Boolean).pop() ?? folder) : "";

  const qc = useQueryClient();
  const { data: paths = [] } = useGitListFiles(folder || null);

  // Reset to the root when the bound folder changes — a stale sub-path from
  // the old folder would otherwise 404 against the new one.
  useEffect(() => { setCurrentDir(""); }, [folder]);

  const { files, dirs } = useMemo(() => childrenOf(paths, currentDir), [paths, currentDir]);
  const crumbs = currentDir ? currentDir.split("/") : [];

  // ── metadata publish: file count ─────────────────────────────────────────
  const lastEventRef = useRef<ExplorerFileEvent | undefined>(undefined);
  useEffect(() => {
    if (!folder) return;
    publishExplorerStats({ tileId: id, folder, fileCount: paths.length, lastEvent: lastEventRef.current });
  }, [id, folder, paths.length]);
  useEffect(() => () => clearExplorerStats(id), [id]);

  // Briefly highlight a just-added file's icon in the grid — "watch files fall
  // in" as an agent creates them. Cleared a couple seconds after the last add.
  const [justAdded, setJustAdded] = useState<string | null>(null);
  useEffect(() => {
    if (!justAdded) return;
    const t = setTimeout(() => setJustAdded(null), 2000);
    return () => clearTimeout(t);
  }, [justAdded]);

  // ── live watch: guarantee THIS folder has a watcher, regardless of which
  // frame/repo it lives in, then react to add/modify/remove events. ────────
  useEffect(() => {
    if (!folder) return;
    window.hive.watchPath(folder).catch(() => {/* best-effort */});
    let timer: ReturnType<typeof setTimeout> | undefined;
    const unsub = window.hive.onFsChanged(folder, ({ events }) => {
      const last = events?.[events.length - 1];
      if (last) {
        const rel = last.path.startsWith(folder) ? last.path.slice(folder.length + 1) : last.path;
        lastEventRef.current = { type: last.type, path: rel, ts: Date.now() };
        publishExplorerStats({ tileId: id, folder, fileCount: paths.length, lastEvent: lastEventRef.current });
        if (last.type === "added") setJustAdded(rel);
      }
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        qc.invalidateQueries({ queryKey: ["git:list-files", folder] });
        qc.invalidateQueries({ queryKey: ["git:status", folder] });
      }, 150);
    });
    return () => { if (timer) clearTimeout(timer); unsub(); };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- paths.length read via closure is fine (only feeds the count already re-published above on paths change)
  }, [folder, id, qc]);

  const changeFolder = async () => {
    const picked = await window.hive.pickFolder({ title: "Choose folder to watch", defaultPath: folder || undefined });
    if (picked) onSetFolder(id, picked);
  };

  const openFile = (relPath: string) => { void window.hive.openPathInApp(folder, relPath); };

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <FolderTree aria-hidden size={13} className="text-[var(--color-fg3)] shrink-0" />
        <span className="font-semibold text-[var(--color-fg)] truncate">{folderName || "Explorer"}</span>
        {folder && <span className="text-[var(--color-fg3)] truncate min-w-0" title={folder}>· {folder}</span>}
        <button
          onClick={changeFolder}
          className="nodrag ml-1 shrink-0 flex items-center gap-1 px-1.5 py-0.5 rounded text-[10.5px] text-[var(--color-fg3)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)]"
          title="Change the folder this Explorer watches"
        >
          <FolderOpen size={11} aria-hidden />
          Change folder…
        </button>
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {folder && (
            <span className="font-mono text-[10px] text-[var(--color-fg3)] tabular-nums" title="files in folder">
              {paths.length}
            </span>
          )}
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} />
          <button
            onClick={onClose}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="close tile"
            title="close"
          >×</button>
        </span>
      </header>

      {!folder ? (
        <div className="flex-1 grid place-items-center">
          <button
            onClick={changeFolder}
            className="flex items-center gap-2 px-3 py-2 rounded-md text-[12px] text-[var(--color-fg2)] border border-[var(--color-line2)] hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
          >
            <FolderOpen size={14} aria-hidden />
            Choose a folder to watch…
          </button>
        </div>
      ) : (
        <div className="flex flex-1 min-h-0">
          <div className="shrink-0 min-w-0 border-r border-[var(--color-line)]" style={{ width: sidebarW }}>
            <FileTreeTile key={folder} repoPath={folder} onSelectDir={setCurrentDir} embedded />
          </div>
          <div
            className="nodrag group shrink-0 w-2 -mx-1 cursor-col-resize relative z-10 flex justify-center"
            role="separator"
            aria-orientation="vertical"
            title="Drag to resize the tree"
            onPointerDown={(e) => {
              dragRef.current = { startX: e.clientX, startW: sidebarW };
              (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
              e.preventDefault();
            }}
            onPointerMove={(e) => {
              const d = dragRef.current;
              if (!d) return;
              setSidebarW(clampW(d.startW + (e.clientX - d.startX)));
            }}
            onPointerUp={(e) => {
              dragRef.current = null;
              (e.currentTarget as HTMLElement).releasePointerCapture(e.pointerId);
            }}
          >
            <span className="w-px h-full bg-[var(--color-line)] group-hover:bg-[var(--color-brand)] group-active:bg-[var(--color-brand)] transition-colors" />
          </div>
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Breadcrumb — click a crumb to jump back up. */}
            <div className="shrink-0 h-7 flex items-center gap-0.5 px-2 border-b border-[var(--color-line)] text-[11px] text-[var(--color-fg3)] overflow-x-auto">
              <button onClick={() => setCurrentDir("")} className="nodrag px-1 rounded hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)] shrink-0">
                {folderName}
              </button>
              {crumbs.map((seg, i) => (
                <span key={i} className="flex items-center gap-0.5 shrink-0">
                  <ChevronRight size={11} aria-hidden />
                  <button
                    onClick={() => setCurrentDir(crumbs.slice(0, i + 1).join("/"))}
                    className="nodrag px-1 rounded hover:bg-[var(--color-bg3)] hover:text-[var(--color-fg)]"
                  >
                    {seg}
                  </button>
                </span>
              ))}
            </div>
            {/* Icon grid — an OS-style view of the current folder's contents.
                View only: double-click a file opens it with the OS default app
                (editing lives in the Editor tile, not here). */}
            <div className="flex-1 min-h-0 overflow-y-auto p-3">
              {dirs.length === 0 && files.length === 0 ? (
                <div className="h-full grid place-items-center text-[12px] text-[var(--color-fg3)]">Empty folder</div>
              ) : (
                <div className="grid gap-3" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(84px, 1fr))" }}>
                  {dirs.map((name) => (
                    <button
                      key={`d:${name}`}
                      onDoubleClick={() => setCurrentDir(currentDir ? `${currentDir}/${name}` : name)}
                      className="nodrag flex flex-col items-center gap-1 p-2 rounded-lg text-center hover:bg-[var(--color-bg3)]"
                      title={name}
                    >
                      <Folder size={30} className="text-[var(--color-fg3)] shrink-0" aria-hidden />
                      <span className="text-[11px] text-[var(--color-fg2)] leading-tight line-clamp-2 break-all">{name}</span>
                    </button>
                  ))}
                  {files.map((name) => {
                    const rel = currentDir ? `${currentDir}/${name}` : name;
                    const added = justAdded === rel;
                    return (
                      <button
                        key={`f:${name}`}
                        onDoubleClick={() => openFile(rel)}
                        className={`nodrag flex flex-col items-center gap-1 p-2 rounded-lg text-center hover:bg-[var(--color-bg3)] transition-colors ${
                          added ? "bg-[var(--color-ok)]/15 ring-1 ring-[var(--color-ok)]" : ""
                        }`}
                        title={name}
                      >
                        <File size={30} className="text-[var(--color-fg3)] shrink-0" aria-hidden />
                        <span className="text-[11px] text-[var(--color-fg2)] leading-tight line-clamp-2 break-all">{name}</span>
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
