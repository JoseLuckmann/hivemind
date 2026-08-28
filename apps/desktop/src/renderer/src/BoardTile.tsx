/**
 * BoardTile — an Excalidraw-backed drawing surface on the canvas. Two shapes
 * share one tile kind (mirrors FileTile's bound-vs-scratch split):
 *
 *  1. A BOUND board: it reads/writes exactly one repo-relative `.excalidraw`
 *     file (JSON — Excalidraw's native format) under `.hivemind/boards/`. The
 *     scene loads from disk on mount; every edit AUTOSAVES back to that path on
 *     a short debounce, so the drawing is versionable and reopens where it was.
 *
 *  2. An UNSAVED board (no `boardFile`): a self-contained in-memory sketch — like
 *     a scratch note. Nothing touches disk until the user hits Save…, which asks
 *     Canvas for a name, writes `.hivemind/boards/<name>.excalidraw`, and binds
 *     the tile to it (from then on it autosaves like a bound board).
 *
 * Canvas owns the bound path (persisted on the TileInstance as `boardFile`) and
 * the Save… name prompt; this tile is presentational + owns only the debounced
 * write. Excalidraw is ESM-only and renders client-side — fine in Electron. It
 * ships its own toolbar; we trim it via UIOptions and pin it to the app's dark
 * theme so it reads as part of the canvas chrome.
 */
import { useCallback, useEffect, useMemo, useRef, useState, lazy, Suspense } from "react";
import { PencilRuler, Save } from "lucide-react";
import { HeaderPinButton, type PinRect } from "./canvas-nodes";
import type { ExcalidrawInitialDataState } from "@excalidraw/excalidraw/types";
import "@excalidraw/excalidraw/index.css";

// Lazily load Excalidraw itself — it's a heavy ESM chunk (canvas engine, fonts,
// its own React tree). A board tile is rarely the first thing open, so keep it
// out of the initial bundle; the Suspense fallback covers the load.
const Excalidraw = lazy(() =>
  import("@excalidraw/excalidraw").then((m) => ({ default: m.Excalidraw })),
);

// Excalidraw's element/appState types are structural; we only ever hand them
// straight back to serializeAsJSON, so we keep them loosely typed here to avoid
// pulling the (large) type surface into this module's public shape.
type SceneChange = { elements: readonly unknown[]; appState: unknown; files: unknown };

interface Props {
  /** Repo the board file is relative to (the tile's frame's effective repo). */
  repoPath: string | null;
  /** The ONE repo-relative `.excalidraw` file this board saves to. Omitted for
   *  an unsaved (in-memory) board. */
  boardFile?: string;
  /** Persist an unsaved board: hands the current scene JSON to Canvas, which
   *  prompts for a name, writes it under `.hivemind/boards/`, and binds the tile. */
  onSaveBoard?: (sceneJson: string) => void;
  /** Selection — gates pointer-events on the wrapper so a deselected board lets
   *  the wheel pan the canvas instead of zooming the drawing (matches other tiles). */
  selected?: boolean;
  onClose: () => void;
  /** Pin state + toggle (injected via node data) — docked in the header. */
  pinned?: boolean;
  onTogglePin?: (id: string, rect: PinRect) => void;
  /** Tile id — needed for the pin button's rect callback. */
  tileId: string;
}

/** Debounce (ms) between the last edit and an autosave write. Long enough to
 *  coalesce a burst of strokes into one write, short enough that a board is
 *  safe within a second of stopping. */
const AUTOSAVE_MS = 800;

export function BoardTile({
  repoPath, boardFile, onSaveBoard, selected, onClose, pinned, onTogglePin, tileId,
}: Props) {
  const name = boardFile ? (boardFile.split("/").pop() ?? boardFile) : "Board";
  // Strip the `.excalidraw` suffix for a cleaner header title.
  const displayName = name.replace(/\.excalidraw$/i, "");

  // Initial scene: for a bound board, read the file once; for an unsaved board,
  // start blank. `initialData` accepts a promise, so we hand Excalidraw the read
  // directly — it shows its own loading state until it resolves. Keyed by
  // repo+file so rebinding (Save… converts unsaved → bound) reloads cleanly.
  const initialData = useMemo(() => {
    if (!repoPath || !boardFile) return null;
    return window.hive
      .fileRead(repoPath, boardFile)
      .then((text) => {
        try {
          const scene = JSON.parse(text) as {
            elements?: unknown[];
            appState?: Record<string, unknown>;
            files?: unknown;
          };
          return {
            elements: (scene.elements ?? []) as ExcalidrawInitialDataState["elements"],
            // Excalidraw refuses a persisted `collaborators` map that isn't a Map;
            // drop it (and the transient width/height) — they're recomputed.
            appState: { ...(scene.appState ?? {}), collaborators: undefined } as ExcalidrawInitialDataState["appState"],
            files: (scene.files ?? undefined) as ExcalidrawInitialDataState["files"],
          } satisfies ExcalidrawInitialDataState;
        } catch {
          // A malformed/empty file → start blank rather than crash the tile.
          return null;
        }
      })
      .catch(() => null);
  }, [repoPath, boardFile]);

  // ── autosave (bound boards only) ──────────────────────────────────────────
  // The latest scene snapshot, captured on every Excalidraw onChange. A single
  // debounced timer flushes it to disk; refs (not state) so onChange doesn't
  // re-render the tile on every pointer move.
  const latestScene = useRef<SceneChange | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [saving, setSaving] = useState(false);
  const [savedTick, setSavedTick] = useState(0); // bump on a successful write (drives the "saved" dot)

  const flushSave = useCallback(async () => {
    if (!repoPath || !boardFile || !latestScene.current) return;
    const { elements, appState, files } = latestScene.current;
    let json: string;
    try {
      const { serializeAsJSON } = await import("@excalidraw/excalidraw");
      // `serializeAsJSON` writes the canonical `.excalidraw` envelope (type,
      // version, source, elements, appState, files) — the same format the web
      // app + file dialogs use, so these files open anywhere.
      json = serializeAsJSON(
        elements as never,
        appState as never,
        (files ?? {}) as never,
        "local",
      );
    } catch {
      return;
    }
    setSaving(true);
    try {
      await window.hive.fileWrite(repoPath, boardFile, json);
      setSavedTick((t) => t + 1);
    } catch {
      /* best-effort — a failed write leaves the in-memory scene intact; the next
         edit reschedules another attempt. */
    } finally {
      setSaving(false);
    }
  }, [repoPath, boardFile]);

  const onChange = useCallback(
    (elements: readonly unknown[], appState: unknown, files: unknown) => {
      latestScene.current = { elements, appState, files };
      // Only autosave a BOUND board; an unsaved board holds its scene in memory
      // (and in latestScene) until the user hits Save…, which reads it back out.
      if (!boardFile) return;
      clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => { void flushSave(); }, AUTOSAVE_MS);
    },
    [boardFile, flushSave],
  );

  // On unmount (tile closed) or when the bound file changes, flush any pending
  // edit immediately so the last stroke isn't lost inside the debounce window.
  useEffect(() => {
    return () => {
      clearTimeout(saveTimer.current);
      if (boardFile) void flushSave();
    };
  }, [boardFile, flushSave]);

  // Save… for an unsaved board: serialize the current scene and hand it up to
  // Canvas (which owns the name prompt + write + rebind). No scene yet → nothing
  // to save (button disabled).
  const requestSave = useCallback(async () => {
    if (!onSaveBoard) return;
    const scene = latestScene.current;
    try {
      const { serializeAsJSON } = await import("@excalidraw/excalidraw");
      const json = scene
        ? serializeAsJSON(
            scene.elements as never,
            scene.appState as never,
            (scene.files ?? {}) as never,
            "local",
          )
        : serializeAsJSON([] as never, {} as never, {} as never, "local");
      onSaveBoard(json);
    } catch {
      /* serialize failure — leave the board as-is. */
    }
  }, [onSaveBoard]);

  const hasContent = (latestScene.current?.elements.length ?? 0) > 0;

  return (
    <div className="hm-glass-surface flex h-full flex-col rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] overflow-hidden shadow-[0_8px_22px_rgba(0,0,0,0.45)]">
      <header className="tile-drag-handle h-8 flex items-center gap-2 px-2.5 bg-[var(--color-bg3)] border-b border-[var(--color-line)] text-[11px] font-mono text-[var(--color-fg2)] cursor-grab active:cursor-grabbing">
        <PencilRuler aria-hidden size={13} className="text-[var(--color-fg3)] shrink-0" />
        <span className="font-semibold text-[var(--color-fg)] truncate">{displayName}</span>
        <span className="text-[var(--color-fg3)] truncate min-w-0">· board</span>
        {/* Status dot: unsaved board shows a warning dot while it has content;
            a bound board shows a subtle "saved" pulse right after a write. */}
        {!boardFile && hasContent && (
          <span className="size-1.5 rounded-full bg-[var(--color-warn)] shrink-0" title="unsaved" aria-label="unsaved" />
        )}
        {boardFile && (
          <span
            key={savedTick}
            className={`size-1.5 rounded-full shrink-0 ${saving ? "bg-[var(--color-warn)]" : "bg-[var(--color-ok,var(--color-fg3))]"}`}
            title={saving ? "saving…" : "saved"}
            aria-label={saving ? "saving" : "saved"}
          />
        )}
        <span className="ml-auto flex items-center gap-1.5 shrink-0">
          {/* Save… only for an UNSAVED board with a repo to write into. A bound
              board autosaves, so it needs no button. */}
          {!boardFile && repoPath && onSaveBoard && (
            <button
              onClick={() => void requestSave()}
              className="nodrag flex items-center gap-1 h-5 px-1.5 rounded text-[10px] text-[var(--color-fg2)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
              title="Save this board to a .excalidraw file"
              aria-label="save board"
            >
              <Save size={11} /> Save…
            </button>
          )}
          <HeaderPinButton pinned={pinned} onToggle={onTogglePin} tileId={tileId} />
          <button
            onClick={onClose}
            className="nodrag size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-line2)] hover:text-[var(--color-fg)]"
            aria-label="close tile"
            title="close"
          >×</button>
        </span>
      </header>
      {/* Excalidraw fills 100% of its container (per its docs) — the flex-1 wrapper
          gives it a non-zero box. `nowheel`/`nodrag` keep its own wheel-zoom +
          pointer interactions from bubbling to react-flow when the tile is
          selected; when NOT selected the wrapper is inert so the wheel pans. */}
      <div className={`relative flex-1 min-h-0 bg-[var(--color-bg)] ${selected ? "nowheel nodrag" : "tile-locked pointer-events-none"}`}>
        <Suspense fallback={<div className="absolute inset-0 grid place-items-center text-[12px] text-[var(--color-fg3)]">Loading board…</div>}>
          <Excalidraw
            // key remounts the engine when the bound file changes (unsaved→bound),
            // so initialData is re-read for the new path.
            key={`${repoPath ?? ""}:${boardFile ?? "unsaved"}`}
            initialData={initialData}
            onChange={onChange}
            theme="dark"
            name={displayName}
            UIOptions={{
              canvasActions: {
                // Trim the menu to the essentials — this is an embedded board, not
                // the standalone app. Keep load/save/export/clear off the burger;
                // the tile owns persistence. Theme is app-global (pinned dark).
                loadScene: false,
                saveToActiveFile: false,
                export: false,
                saveAsImage: true,
                toggleTheme: false,
                changeViewBackgroundColor: true,
                clearCanvas: true,
              },
            }}
          />
        </Suspense>
      </div>
    </div>
  );
}
