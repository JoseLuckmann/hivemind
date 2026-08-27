/**
 * FileTile — a lightweight SINGLE-FILE tile. Three shapes share one tile kind:
 *
 *  1. A bound TEXT file: it edits exactly one workspace file (a spec, a config,
 *     …) with no explorer and no tab switching — the fast path when you just
 *     need to touch one file. It REUSES `EditorTile` in `embedded`+`singleFile`
 *     mode with a one-element `tabs` list, so CodeMirror, syntax highlight,
 *     dirty/save, find/replace, and markdown Preview all come for free.
 *
 *  2. A bound IMAGE file (png/jpg/gif/webp/…): rendered as an <img> from a data
 *     URL (read over IPC as base64) — a quick visual reference on the canvas,
 *     zoom-to-fit, no editor. Detected purely by extension.
 *
 *  3. A blank SCRATCH note (no `file`): a self-contained plain-text pad to jot
 *     something on the canvas, with an in-memory buffer and a "Save…" affordance
 *     that writes it to a workspace path only if you choose to. Nothing touches
 *     disk until you save — "a file that's just for notes, saved if needed".
 *
 * Canvas owns the bound file path (persisted on the TileInstance as `file`);
 * this tile is presentational. Closing the tab isn't offered (a single-file tile
 * IS its file) — the tile's × closes the whole tile instead.
 */
import { useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { FileText, ImageIcon, StickyNote, Save, Eye, Pencil } from "lucide-react";
import { EditorTile } from "./EditorTile";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";

// Markdown preview loads only when a scratch note is actually previewed (marked +
// DOMPurify), so a plain-text note pulls in zero markdown code.
const MarkdownPreview = lazy(() =>
  import("./markdown-preview").then((m) => ({ default: m.MarkdownPreview })),
);

/** Image extensions rendered as a picture instead of text. */
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|bmp|avif|ico|svg)$/i;
export const isImagePath = (p: string): boolean => IMAGE_EXT.test(p);

/** MIME type for the data URL, by extension (svg is text/xml-ish but browsers
 *  render `image/svg+xml` inline fine). */
function mimeFor(path: string): string {
  const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
  switch (ext) {
    case "svg": return "image/svg+xml";
    case "jpg": case "jpeg": return "image/jpeg";
    case "ico": return "image/x-icon";
    default: return `image/${ext}`;
  }
}

interface Props {
  repoPath: string;
  /** The ONE repo-relative file this tile edits — omitted for a scratch note. */
  file?: string;
  /** Persist a scratch note: hands the current buffer to Canvas, which prompts
   *  for a path, writes it, and converts this into a bound file tile. */
  onSaveScratch?: (text: string) => void;
  /** Close the whole tile. */
  onClose: () => void;
  /** Open a URL in the frame's browser tile (markdown links, html preview). */
  onOpenInBrowser?: (url: string) => void;
  /** Pin state + toggle (injected via node data) — docked in the header. */
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
}

export function FileTile({ repoPath, file, onSaveScratch, onClose, onOpenInBrowser, pinned, onTogglePin }: Props) {
  // ── scratch note (no bound file) ──────────────────────────────────────────
  if (!file) {
    return (
      <ScratchTile
        repoPath={repoPath}
        onSaveScratch={onSaveScratch}
        onClose={onClose}
        pinned={pinned}
        onTogglePin={onTogglePin}
      />
    );
  }

  const name = file.split("/").pop() ?? file;
  // Show the parent dir as context when it disambiguates (e.g. two config.yaml).
  const dir = file.includes("/") ? file.slice(0, file.lastIndexOf("/")) : "";

  // ── image reference ─────────────────────────────────────────────────────
  if (isImagePath(file)) {
    return <ImageFileTile repoPath={repoPath} file={file} name={name} dir={dir} onClose={onClose} pinned={pinned} onTogglePin={onTogglePin} />;
  }

  // ── bound text file (reuse EditorTile) ────────────────────────────────────
  // Fixed single-tab list. Memoized so EditorTile's tab-resolution effect isn't
  // handed a fresh array identity every render (which would churn its state).
  const tabs = useMemo(() => [file], [file]);

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

/** Image file reference — reads the bytes over IPC as base64 and shows them as
 *  a contained <img>. No editing; a quick visual reference on the canvas. */
function ImageFileTile({
  repoPath, file, name, dir, onClose, pinned, onTogglePin,
}: {
  repoPath: string; file: string; name: string; dir: string;
  onClose: () => void; pinned?: boolean; onTogglePin?: (id: string, rect: PinRect) => void;
}) {
  const [src, setSrc] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setSrc(null);
    setErr(null);
    window.hive
      .fileReadBase64(repoPath, file)
      .then((b64) => { if (alive) setSrc(`data:${mimeFor(file)};base64,${b64}`); })
      .catch((e: unknown) => { if (alive) setErr(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, [repoPath, file]);
  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <ImageIcon aria-hidden size={13} className="text-[var(--color-fg3)] shrink-0" />
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
      <div className="flex-1 min-h-0 grid place-items-center overflow-auto bg-[var(--color-bg)] p-2">
        {err ? (
          <div className="text-[12px] text-[var(--color-err)] px-3 text-center">Couldn't load image: {err}</div>
        ) : src ? (
          // A checkerboard-free contain fit: the image never overflows the tile,
          // scales down for a thumbnail, and stays crisp when small.
          <img src={src} alt={name} className="max-h-full max-w-full object-contain nodrag" draggable={false} />
        ) : (
          <div className="text-[12px] text-[var(--color-fg3)]">Loading image…</div>
        )}
      </div>
    </div>
  );
}

/** Blank scratch note — an in-memory MARKDOWN pad. Writes nothing to disk until
 *  the user hits Save…, which asks Canvas for a path and persists the buffer,
 *  converting this into a bound file. The buffer is treated as markdown: a
 *  Preview toggle renders it (headings, lists, links, code, mermaid) with the
 *  SAME viewer the editor's Preview uses — so a note formats even before it has
 *  a `.md` file on disk. Saving to a `.md` path then keeps that formatting in
 *  the bound editor tile. */
function ScratchTile({
  repoPath, onSaveScratch, onClose, pinned, onTogglePin,
}: {
  repoPath: string | null; onSaveScratch?: (text: string) => void;
  onClose: () => void; pinned?: boolean; onTogglePin?: (id: string, rect: PinRect) => void;
}) {
  const [text, setText] = useState("");
  const [preview, setPreview] = useState(false);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const dirty = text.length > 0;

  // Save: ⌘S/Ctrl+S hands the buffer to Canvas, which owns the path picker +
  // write + tile conversion. Guarded to the tile's own textarea so it doesn't
  // hijack a global save. No workspace bound → nowhere to save (Save is hidden).
  const requestSave = () => {
    if (!repoPath || !onSaveScratch) return;
    onSaveScratch(text);
  };

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <StickyNote aria-hidden size={13} className="text-[var(--color-fg3)] shrink-0" />
        <span className="font-semibold text-[var(--color-fg)] truncate">Scratch</span>
        <span className="text-[var(--color-fg3)] truncate min-w-0">· markdown</span>
        {dirty && <span className="size-1.5 rounded-full bg-[var(--color-warn)] shrink-0" title="unsaved" aria-label="unsaved" />}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* Edit ⇄ Preview — render the note as markdown without needing a file
              on disk. Disabled while empty (nothing to preview). */}
          <button
            onClick={() => setPreview((p) => !p)}
            disabled={!dirty}
            className="nodrag flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-[var(--color-fg2)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:cursor-not-allowed"
            title={preview ? "Edit the note" : "Preview as markdown"}
            aria-label={preview ? "edit note" : "preview markdown"}
            aria-pressed={preview}
          >
            {preview ? <><Pencil size={11} /> Edit</> : <><Eye size={11} /> Preview</>}
          </button>
          {repoPath && onSaveScratch && (
            <button
              onClick={requestSave}
              disabled={!dirty}
              className="nodrag flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-[var(--color-fg2)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)] disabled:opacity-30 disabled:cursor-not-allowed"
              title="Save this note to a file (⌘S)"
              aria-label="save note"
            >
              <Save size={11} /> Save…
            </button>
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
      {preview ? (
        // Read-only rendered markdown. `nowheel` (inside md-preview default class)
        // lets the note scroll without panning the canvas.
        <div className="nodrag relative flex-1 min-h-0 overflow-auto bg-[var(--color-bg2)]">
          <Suspense fallback={<div className="px-3 py-2 text-[12px] text-[var(--color-fg3)]">Rendering…</div>}>
            <MarkdownPreview source={text} className="md-preview nowheel px-4 py-3" />
          </Suspense>
        </div>
      ) : (
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && (e.key === "s" || e.key === "S")) {
              e.preventDefault();
              requestSave();
            }
          }}
          placeholder="Jot something down in markdown… (⌘S to save to a file)"
          spellCheck={false}
          className="nodrag flex-1 min-h-0 w-full resize-none bg-[var(--color-bg2)] text-[var(--color-fg)] px-3 py-2 text-[13px] leading-relaxed font-mono outline-none placeholder:text-[var(--color-fg3)]"
          aria-label="scratch note"
        />
      )}
    </div>
  );
}
