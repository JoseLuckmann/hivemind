import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Background,
  BackgroundVariant,
  MiniMap,
  Panel,
  ReactFlow,
  useReactFlow,
  MarkerType,
  type Node,
  type Edge,
  type Connection,
} from "@xyflow/react";
import { LayersPanel, type LayerTile, type LayerFrame } from "./LayersPanel";
import { statusOf, setWaitStatus, setSubagentBusy, setNotify, setTurnState, waitForIdle, type TileStatusKind } from "./agent-status-bus";
import { identifyAgent, HOOK_CAPABLE_AGENTS } from "./agent-state";
import { FRAME_ROW_MAX, frameAtPoint } from "./frame-layout";
import { ToolIsland, ZoomIsland } from "./canvas-islands";
import { Wallpaper } from "./Wallpaper";
import { CanvasOverlay } from "./CanvasOverlay";
import { ThemeCustomizer } from "./ThemeCustomizer";
import { applyTheme } from "./theme-store";
import { Eye, EyeOff } from "lucide-react";
import { Toasts, CanvasEmptyState } from "./canvas-overlays";
import { nodeTypes, PinnedLayerContext, type PinRect } from "./canvas-nodes";
import { clampAnchor } from "./pin-anchor";
import { pipeEdgeTypes } from "./canvas-pipe-edge";
import { workflowEdgeTypes } from "./canvas-workflow-edge";
import { EdgePromptPopover, type EdgePromptValue } from "./components/EdgePromptPopover";
import {
  snapViewportCrisp,
  FocusMode,
  FocusOnTile,
  PanMomentum,
  ViewportSnap,
  useTileFocus,
} from "./canvas-camera";
import type { TileKind } from "./tile-kinds";
import {
  loadLayout,
  saveLayout,
  defaultShell,
  WORKBENCH_TILE_ID,
  type TileInstance,
  type FrameState,
  type WorkflowEdge,
} from "./canvas-persistence";
import { useStateWithRef } from "./use-state-with-ref";
import { defaultTileSize, defaultSizeForKind, FRAME_PAD, FRAME_HEADER } from "./canvas-sizing";
import { useWorktrees } from "./useWorktrees";
import { RemoteConnectModal } from "./components/RemoteConnectModal";
import { SyncSettingsModal } from "./components/SyncSettingsModal";
import { CommandButtonModal, type CmdButtonConfig } from "./components/CommandButtonModal";
import { TriggerConfigModal, type TriggerConfig } from "./components/TriggerConfigModal";
import { runWorkflow, type TriggerRunState } from "./workflow-engine";
import { WorkflowScheduler } from "./workflow-scheduler";
import { ConfirmDialog } from "./components/ConfirmDialog";
import { CanvasSpawnMenu, type CanvasSpawnMenuState } from "./CanvasSpawnMenu";
import { isRemote } from "../../shared/remote-uri";
import { AGENTS, AgentIcon, agentById, agentForCmd } from "./agents";
import { useSpawn } from "./useSpawn";
import { useFrameOps } from "./useFrameOps";
import { buildBaseNodes } from "./canvas-node-build";
import { useAgentAwareness } from "./useAgentAwareness";
import { unmarkBackgroundTile } from "./worker-tiles";
import { useCanvasShortcuts } from "./useCanvasShortcuts";
import { useNodeDragStop } from "./useNodeDragStop";
import { WindowsView } from "./WindowsView";
import { GitCommitModal } from "./GitCommitModal";
import { FilePickerModal } from "./FilePickerModal";
import { useGitPush, useGitPull } from "./queries";import {
  loadViewMode, saveViewMode, loadMinimized, saveMinimized, nextActiveTab, type ViewMode,
} from "./windows-view-state";
import type { WorktreeEntry } from "../../shared/ipc";

// snapViewportCrisp moved to canvas-camera.tsx

// node wrappers + nodeTypes + useTileWheelZoom moved to canvas-nodes.tsx

// Stable references for props passed to <ReactFlow>. The xyflow perf guide
// (reactflow.dev/learn/advanced-use/performance) flags unmemoized object/array
// props as the #1 cause of re-renders during node movement — a fresh `edges={[]}`
// or inline `panOnDrag={[1,2]}` every render makes react-flow re-process its
// internal state each frame. Hoisting them to module scope makes the ref constant.
const EMPTY_EDGES: Edge[] = [];
const ALL_EDGE_TYPES = { ...pipeEdgeTypes, ...workflowEdgeTypes };
const PAN_ON_DRAG = [1, 2];
const PRO_OPTIONS = { hideAttribution: true };
// Snap on drop to an 8px grid (Figma's standard). The drop xyflow hands us is
// raw cursor; rounding to 8px means the tile travels a few px from cursor to
// grid — and because `.canvas-dragging` is removed SYNC on dragstop, the
// `.react-flow__node` 280ms transition (Linear-app ease-out-quint) animates
// that travel. THAT is the "smooth land" moment. Below ~4px the travel is too
// small to read as motion.
const SNAP_GRID: [number, number] = [8, 8];
const DEFAULT_VIEWPORT = { x: 16, y: 24, zoom: 1 };

interface Props {
  cwd: string;
  repoPath: string | null;
  /** Workspace root (.hivemind parent) — issues are keyed by this, not repoPath. */
  root?: string | null;
  /** When the launched folder has no .hivemind/, App provides this so the
   *  CanvasEmptyState can offer "Initialize workspace here…" (the old top-left
   *  switcher's job). Undefined when a workspace is already resolved. */
  onInitWorkspace?: () => void;
  /** Open an existing project folder anywhere (native picker) — App wires this
   *  so the empty state can start a project even when launched with no folder
   *  (e.g. from the application menu). */
  onOpenFolder?: () => void;
  /** Pick a folder then initialize a NEW project there (create anywhere). */
  onCreateProject?: () => void;
  /** A newer GitHub release exists → show the "Update available" pill by Theme.
   *  Owned by App (so the Settings dialog + this pill share one check). */
  updateAvailable?: boolean;
  /** Run the installer + restart (from the pill). */
  onUpgrade?: () => void;
  /** An upgrade is in flight — the pill shows a spinner + is click-inert. */
  upgrading?: boolean;
}


// Every tile on the canvas is an INSTANCE now (was: claude/shell instanced via
// `extras`, but editor/diff/issues were global singletons keyed off a fixed id
// + a `vis` boolean). Unifying them means each workspace frame can hold its own
// editor/diff/issues, and terminals are instances everywhere. claude + shell
// are unlimited per frame; editor/diff/issues are one-per-frame (spawn focuses
// the existing one if that frame already has it).
/** Kinds that are one-per-frame (spawn → focus existing). claude/shell are not. */
const SINGLETON_KINDS: ReadonlySet<TileKind> = new Set(["editor", "diff", "issues"]);



// tile sizing helpers + FRAME_* constants moved to canvas-sizing.ts

export function Canvas({ cwd, repoPath, root = null, onInitWorkspace, onOpenFolder, onCreateProject, updateAvailable = false, onUpgrade, upgrading = false }: Props) {
  // Persistence key for the canvas layout. Prefer repoPath (a git/.hivemind
  // project); fall back to the absolute cwd so a plain folder — including
  // `$HOME` — still persists + resumes. Without this, launching onto any
  // non-git, non-init'd directory gave repoPath=null → saveLayout/loadLayout
  // no-op'd → every restart was a blank canvas + agents never resumed. Keyed on
  // the absolute path (never a shared `__global__` sentinel), so distinct
  // folders never leak into each other. An empty cwd (welcome/e2e bootstrap)
  // stays transient (null) and is intentionally NOT persisted.
  const persistKey = repoPath ?? (cwd || null);
  // Bootstrapped from localStorage on first render (synchronous useState
  // initializer so we never flash an empty canvas before hydrating). Reloaded
  // when the persistence key changes — see the effect below.
  const initial = useMemo(() => loadLayout(persistKey), [persistKey]);

  // Lazy-mount: nothing on screen until the user clicks a toggle — OR restored
  // from a prior session so a restart resumes where you left off. Avoids
  // mounting all three tiles + spawning a PTY + git ls-files just to look.
  // All open tiles, every kind, as instances. Replaces the old `vis` singletons
  // + `extras` list. Mirror to a ref so callbacks declared before later state
  // can read the latest list without re-creating on every change.
  const [tiles, setTiles, tilesRef] = useStateWithRef<TileInstance[]>(initial.tiles ?? []);
  // Live agent pipes (HCP hive_connect) → animated data-flow edges. Ephemeral.
  const [pipes, setPipes] = useState<{ src: string; dst: string }[]>([]);
  // Spawn-parentage wires (parent → child) — a spawned sub-agent / workflow worker
  // shows a persistent dashed line to the agent that spawned it. Drawn ALWAYS,
  // independent of the report pipe. Ephemeral (spawn tree is main-side state).
  const [spawnLinks, setSpawnLinks] = useState<{ parent: string; child: string }[]>([]);
  // Files opened in each editor tile — tabs keyed by editor tile id (repo-
  // relative paths, deduped). Each editor instance has its own tab set.
  const [editorTabs, setEditorTabs] = useState<Record<string, string[]>>(initial.editorTabs ?? {});

  // Runtime per-tile dimension overrides. Initial size lives in the node
  // spec's style; once the user drags a NodeResizer corner, react-flow's
  // XYResizer fires a `dimensions` change which we capture here. Without
  // this, the useMemo-rebuilt node spec re-applies the old style.width/height
  // every render and the resize visually no-ops (we proved this via
  // playwright: onResize callback DID fire with 460→620 px, but
  // getBoundingClientRect still read 460 because style.width won the race).
  const [sizes, setSizes, sizesRef] = useStateWithRef<Record<string, { width: number; height: number }>>(initial.sizes);
  // User-renamed tile labels (per tile id). Persisted with layout. Holds USER
  // renames ONLY — an absent entry means "use the auto/agent name".
  const [tileNames, setTileNames] = useState<Record<string, string>>(initial.tileNames ?? {});
  const renameTile = useCallback((id: string, name: string) => {
    const trimmed = name.trim();
    setTileNames((m) => {
      if (!trimmed) {
        if (!(id in m)) return m;
        const { [id]: _, ...rest } = m;
        return rest;
      }
      if (m[id] === trimmed) return m;
      return { ...m, [id]: trimmed };
    });
  }, []);
  // explorer only — repoint a File Explorer tile at a different absolute
  // folder (its "Change folder…" button). Persists on the TileInstance like
  // any other per-tile field, so the tile reopens on the same folder.
  const onSetFolder = useCallback((id: string, folder: string) => {
    setTiles((cur) => cur.map((t) => (t.id === id ? { ...t, folder } : t)));
  }, [setTiles]);
  // Live agent session titles from the terminal OSC window-title (claude writes
  // a task summary there). NOT persisted here — the DAEMON owns the title as
  // session state (persisted in its snapshot) and re-emits it ahead of the
  // replay on every attach, so onTitleChange repopulates this on reattach AND
  // reboot-restore. A user rename (tileNames) still takes precedence. Cleared
  // when a tile closes.
  const [agentTitles, setAgentTitles] = useState<Record<string, string>>({});
  const setAgentTitle = useCallback((id: string, title: string) => {
    setAgentTitles((m) => (m[id] === title ? m : { ...m, [id]: title }));
  }, []);
  // Command Button create/edit modal. `tileId` targets the button being
  // configured; `mode` picks the modal copy + whether a cancel should discard a
  // just-spawned (never-configured) button.
  const [cmdModal, setCmdModal] = useState<{ tileId: string; mode: "create" | "edit" } | null>(null);
  // Open the edit modal for an existing (configured) button — wired into the
  // tile's ⚙ via node data.
  const editCmdButton = useCallback((id: string) => setCmdModal({ tileId: id, mode: "edit" }), []);
  // Trigger create/edit modal — same shape as cmdModal above.
  const [triggerModal, setTriggerModal] = useState<{ tileId: string; mode: "create" | "edit" } | null>(null);
  const editTrigger = useCallback((id: string) => setTriggerModal({ tileId: id, mode: "edit" }), []);
  // Per-trigger last-run outcome, shown on the tile's status line + used to
  // highlight the live edge/node while a run is in flight (workflow-engine.ts).
  const [triggerRuns, setTriggerRuns] = useState<Record<string, TriggerRunState>>({});
  const triggerRunningRef = useRef<Set<string>>(new Set());
  const [activeWorkflowStep, setActiveWorkflowStep] = useState<{ triggerId: string; activeEdgeId: string | null } | null>(null);
  const onNodeResizeCommit = useCallback((id: string, width: number, height: number, x?: number, y?: number) => {
    setSizes((s) => {
      const cur = s[id];
      if (cur && cur.width === width && cur.height === height) return s;
      return { ...s, [id]: { width, height } };
    });
    if (x != null && y != null) {
      // NodeResizer reports x/y RELATIVE to the parent frame for a child node,
      // but our positions map is ABSOLUTE world coords (mkTile + the auto-fit
      // effect both assume absolute). Without converting, resizing a framed
      // tile from a top/left handle stored a relative coord as absolute → the
      // tile jumped left/up by the frame offset on the next render, and the
      // frame mis-grew. Add the frame origin back when the tile lives in one.
      const fid = frameOfRef.current[id];
      const fr = fid ? framesRef.current.find((f) => f.id === fid) : undefined;
      const ax = fr ? fr.x + x : x;
      const ay = fr ? fr.y + y : y;
      setPositions((p) => {
        const cur = p[id];
        if (cur && cur.x === ax && cur.y === ay) return p;
        return { ...p, [id]: { x: ax, y: ay } };
      });
    }
    // Frame resize is handled reactively by the auto-fit effect — committing
    // the new size/position above triggers it. No manual frame-grow here.
  }, []);

  // Proportional tile scale from a terminal header's hover slider. The slider
  // grows the FONT (its own per-tile store) and emits the drag delta as a ratio;
  // here we grow the NODE box by the same ratio so the whole terminal scales in
  // proportion — crisp, since nothing zooms (bigger box + bigger font px only
  // change the cols/rows, not the canvas transform). Clamped to the terminal
  // NodeResizer's min and a sane max.
  useEffect(() => {
    const onScale = (e: Event) => {
      const d = (e as CustomEvent<{ tileId: string; ratio: number }>).detail;
      if (!d?.tileId || !Number.isFinite(d.ratio) || d.ratio <= 0) return;
      const cur = sizesRef.current[d.tileId] ?? defaultTileSize(d.tileId);
      const width = Math.max(340, Math.min(4200, Math.round(cur.width * d.ratio)));
      const height = Math.max(200, Math.min(2800, Math.round(cur.height * d.ratio)));
      onNodeResizeCommit(d.tileId, width, height);
    };
    window.addEventListener("hivemind:scale-tile", onScale as EventListener);
    return () => window.removeEventListener("hivemind:scale-tile", onScale as EventListener);
  }, [onNodeResizeCommit]);

  // Same pattern for positions — useMemo rebuilds nodes with hardcoded x/y
  // from the layout loop, so dragged-then-released tiles would snap back
  // without this override map. Populated by onNodeDragStop.
  const [positions, setPositions, positionsRef] = useStateWithRef<Record<string, { x: number; y: number }>>(initial.positions);
  const commitPosition = useCallback((id: string, x: number, y: number) => {
    // Snap on COMMIT (not during drag) — snapping during motion teleports the
    // tile in grid steps every pointermove → feels notchy. Snap only on release.
    const g = SNAP_GRID[0];
    const sx = Math.round(x / g) * g;
    const sy = Math.round(y / g) * g;
    setPositions((p) => {
      const cur = p[id];
      if (cur && cur.x === sx && cur.y === sy) return p;
      return { ...p, [id]: { x: sx, y: sy } };
    });
  }, []);

  // Manual tile selection (react-flow's click-select is dead in our config —
  // see the note at the original declaration site below). Declared here so
  // openFile can select the editor tile when a file opens.
  const [selectedTileId, setSelectedTileId, selectedTileIdRef] = useStateWithRef<string | null>(null);
  // Keyboard gate: a tile only takes input while selected. `tile-locked`'s
  // pointer-events:none blocks the mouse but NOT the keyboard, so a focused
  // input (CodeMirror, an issue field, …) keeps eating keystrokes after its
  // tile is deselected. Blur whatever's focused inside a now-unselected tile.
  // (Terminals also self-gate via xterm disableStdin.)
  useEffect(() => {
    const active = document.activeElement as HTMLElement | null;
    if (!active || active === document.body) return;
    const node = active.closest(".react-flow__node");
    if (!node) return;
    if (!selectedTileId || node.getAttribute("data-id") !== selectedTileId) active.blur();
  }, [selectedTileId]);
  // Focus mode: fitView to one node (`.`) / fit all (Esc). Reuses same nonce
  // pattern as focusReq so re-firing the same id still triggers.
  const [focusModeReq, setFocusModeReq] = useState<{ id: string | null; n: number } | null>(null);
  const focusModeNonceRef = useRef(0);

  // Open a file as a tab in the workbench's embedded editor (mounting the
  // workbench if it isn't open yet). The EditorTile picks the newly-appended
  // tab as active.
  // Open a file as a tab in a SPECIFIC editor tile (bound per-instance at node-
  // build time). The EditorTile picks the newly-appended tab as active.
  const openFileInTile = useCallback((tileId: string, file: string) => {
    setEditorTabs((m) => {
      const cur = m[tileId] ?? [];
      if (cur.includes(file)) return m;
      return { ...m, [tileId]: [...cur, file] };
    });
    setSelectedTileId(tileId);
  }, []);
  const closeTabInTile = useCallback((tileId: string, file: string) => {
    setEditorTabs((m) => {
      const cur = m[tileId];
      if (!cur) return m;
      return { ...m, [tileId]: cur.filter((f) => f !== file) };
    });
  }, []);
  // Close an editor tile entirely (the WorkbenchTile's × ): drop the instance
  // and its tabs. (closeTile below handles the generic case; editor needs the
  // tab cleanup too.)
  const closeTile = useCallback((id: string) => {
    unmarkBackgroundTile(id);
    // A Command Button owns a main-process runner keyed by tile id — dispose it
    // (kills any live script) so a closed button never leaves an orphan process.
    if (tilesRef.current.find((t) => t.id === id)?.kind === "cmdButton") {
      try { window.hive.cmdDispose(id); } catch { /* best-effort */ }
    }
    setTiles((ts) => ts.filter((t) => t.id !== id));
    setBrowserOpenReqs((m) => {
      if (!(id in m)) return m;
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
    setEditorTabs((m) => {
      if (!(id in m)) return m;
      const { [id]: _drop, ...rest } = m;
      return rest;
    });
    setAgentTitles((m) => {
      if (!(id in m)) return m;
      const { [id]: _t, ...rest } = m;
      return rest;
    });
  }, []);

  // Manual tile selection. react-flow's built-in click-to-select is dead in our
  // config (selectionOnDrag + panOnDrag=[1,2] + per-node dragHandle → a node
  // click never applies selection — verified via probe). So we track the
  // selected tile ourselves via onNodeClick and inject `selected` + a high
  // zIndex into the node spec, which drives the highlight ring, the resize
  // handles (isVisible={selected}), and bring-to-front.
  // (selectedTileId state is declared higher up so openFile can use it.)

  // Frame nodes — Unreal-Blueprint-style colored comment boxes for grouping.
  // frames/frameOf each expose a synchronously-readable ref (updated in the
  // setter — see useStateWithRef). Async bind/unbind + the memoized keyboard
  // handler read the ref; render uses the state value.
  const [frames, setFrames, framesRef] = useStateWithRef<FrameState[]>(initial.frames);
  // Re-resolve a frame's workspaceRoot when it's null but the folder now has a
  // `.hivemind/`. A frame saves workspaceRoot at open time; if you opened the
  // folder BEFORE running `hive init`, that's persisted as null and the Issues
  // tile shows "No workspace" forever — even across restarts (the stale null is
  // in the saved layout). Run once on load: for any local frame with a path but
  // no root, resolve again and adopt a freshly-created tracker.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const todo = framesRef.current.filter(
        (f) => f.workspacePath && !f.workspacePath.startsWith("ssh://") && !f.workspaceRoot,
      );
      for (const f of todo) {
        try {
          const proj = await window.hive.resolveProject(f.workspacePath!);
          if (cancelled || !proj.root) continue;
          setFrames((fs) => fs.map((x) => (x.id === f.id ? { ...x, workspaceRoot: proj.root } : x)));
        } catch { /* unreadable path — leave as-is */ }
      }
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // Explicit tile→frame membership (see PersistedLayout.frameOf). Authoritative
  // for auto-fit, parenting, and the chip strip — geometry never decides it.
  const [frameOf, setFrameOf, frameOfRef] = useStateWithRef<Record<string, string>>(initial.frameOf ?? {});
  // User-authored workflow graph (trigger→agent→…→cmdButton). Persisted
  // alongside the rest of the layout; see canvas-persistence.ts WorkflowEdge.
  const [workflowEdges, setWorkflowEdges, workflowEdgesRef] =
    useStateWithRef<WorkflowEdge[]>(initial.workflowEdges ?? []);

  // ── Workflow engine wiring ────────────────────────────────────────────
  // Real implementations of workflow-engine.ts's injected deps — everything
  // agent-turn-related goes through the new hcp:invoke bridge (agent.send +
  // agent.read, the SAME Mailbox/TurnTracker path MCP's mcp__hive__* tools
  // already exercise); action steps reuse cmdRun/onCmdState verbatim.
  const WORKFLOW_STEP_TIMEOUT_MS = 10 * 60_000; // matches HCP's own default worker-turn ceiling
  const deliverStep = useCallback(async (tileId: string, message: string) => {
    const tile = tilesRef.current.find((t) => t.id === tileId);
    const agent = identifyAgent(tile?.cmd ?? "");
    const hookCapable = agent != null && HOOK_CAPABLE_AGENTS.has(agent);
    // A workflow step ONLY sends a message INTO the (already-running) agent tile
    // — it never spawns a terminal or an agent. agent.send is Mailbox-safe: if
    // the target is mid-turn (e.g. still booting), the message is HELD and typed
    // in once the agent is back at its prompt (see hcp/mailbox.ts). We surface a
    // clear error only if the tile has no live pty at all — the user must have
    // placed/opened the agent tile first (that's how it worked before, unchanged).
    const alive = (await window.hive.hcpInvoke("agent.alive", { tileId })) as { alive: boolean };
    if (!alive.alive) {
      throw new Error(
        `step "${tile?.label ?? tileId}" has no running agent — open/spawn the ${agent ?? "agent"} tile before firing the workflow`,
      );
    }
    await window.hive.hcpInvoke("agent.send", { tileId, text: message });
    if (hookCapable) {
      const res = (await window.hive.hcpInvoke("agent.read", { tileId, timeoutMs: WORKFLOW_STEP_TIMEOUT_MS })) as
        { text: string | null; finalStatus: string; note?: string };
      if (res.finalStatus !== "turn") {
        throw new Error(res.note ?? `step ${tileId} timed out waiting for a reply`);
      }
      return { text: res.text };
    }
    // Hookless agent (codex, kiro, …) — TurnTracker/agent.read can never
    // resolve for these (no Stop-hook-equivalent event exists), so fall back
    // to the status-bus idle transition. No clean reply text is available
    // for these providers — `includePrevReply` silently has nothing to
    // prefix when the SOURCE of an edge is a hookless agent.
    const finished = await waitForIdle(tileId, { timeoutMs: WORKFLOW_STEP_TIMEOUT_MS });
    if (!finished) {
      throw new Error(`step ${tileId} (${agent ?? "unknown agent"}) timed out waiting for it to go idle`);
    }
    return { text: null };
  }, []);
  const runAction = useCallback((tileId: string): Promise<{ ok: boolean; note?: string }> => {
    const tile = tilesRef.current.find((t) => t.id === tileId);
    const script = tile?.cmdButton?.script;
    if (!script?.trim()) return Promise.resolve({ ok: false, note: "action has no script configured" });
    return new Promise((resolve) => {
      const unsub = window.hive.onCmdState(tileId, (s) => {
        if (s.status === "done") { unsub(); resolve({ ok: true }); }
        else if (s.status === "error") {
          unsub();
          resolve({ ok: false, note: s.signal ? `stopped (${s.signal})` : s.exitCode != null ? `exit ${s.exitCode}` : "failed" });
        }
      });
      window.hive.cmdRun(tileId, script, tile?.cmdButton?.cwd).catch((e) => {
        unsub();
        resolve({ ok: false, note: (e as Error).message });
      });
    });
  }, []);
  // Fire a trigger's chain. Guarded against re-entry (a manual click while a
  // scheduled tick — or a previous manual run — is already in flight for the
  // SAME trigger no-ops; different triggers run independently).
  const runTrigger = useCallback((triggerId: string) => {
    if (triggerRunningRef.current.has(triggerId)) return;
    triggerRunningRef.current.add(triggerId);
    setTriggerRuns((m) => ({ ...m, [triggerId]: { status: "running" } }));
    runWorkflow(
      triggerId,
      { edges: workflowEdgesRef.current, tiles: tilesRef.current },
      {
        deliverStep,
        runAction,
        onProgress: (p) => setActiveWorkflowStep(p.activeNodeId ? { triggerId: p.triggerId, activeEdgeId: p.activeEdgeId } : null),
      },
    ).then((res) => {
      setTriggerRuns((m) => ({ ...m, [triggerId]: res }));
    }).finally(() => {
      triggerRunningRef.current.delete(triggerId);
    });
  }, [deliverStep, runAction]);

  // ── Workflow connect UX ───────────────────────────────────────────────
  // The prompt popover currently open, if any — `isNew` marks a just-created
  // edge (from a fresh connect-drag) so Cancel discards it instead of merely
  // closing (mirrors createCmdButton's create-vs-edit cancel semantics).
  const [edgePromptAnchor, setEdgePromptAnchor] = useState<{ edgeId: string; x: number; y: number; isNew: boolean } | null>(null);
  // Anchor point for the popover: the screen-space midpoint between the two
  // nodes' flow positions. Edges have no stable DOM element to anchor a ref
  // to (unlike FrameNode's AnchoredMenu), so this is computed from the same
  // positions/sizes state the node-build memo already reads, then converted
  // flow→screen by hand via the live viewport transform — Canvas is NOT
  // inside a ReactFlowProvider (see onCanvasContextMenu's client→flow
  // conversion above for the same reason/pattern, inverted here).
  const edgeAnchorPoint = useCallback((sourceId: string, targetId: string): { x: number; y: number } => {
    const sp = positionsRef.current[sourceId];
    const tp = positionsRef.current[targetId];
    const ss = sizesRef.current[sourceId] ?? defaultTileSize(sourceId);
    const ts = sizesRef.current[targetId] ?? defaultTileSize(targetId);
    const from = sp ? { x: sp.x + ss.width, y: sp.y + ss.height / 2 } : { x: 0, y: 0 };
    const to = tp ? { x: tp.x, y: tp.y + ts.height / 2 } : from;
    const fx = (from.x + to.x) / 2;
    const fy = (from.y + to.y) / 2;
    const rect = flowWrapRef.current?.getBoundingClientRect();
    const vp = currentViewportRef.current;
    if (!rect) return { x: fx, y: fy };
    return { x: rect.left + vp.x + fx * vp.zoom, y: rect.top + vp.y + fy * vp.zoom };
  }, []);

  const onWorkflowConnect = useCallback((connection: Connection) => {
    if (!connection.source || !connection.target || connection.source === connection.target) return;
    const existing = workflowEdgesRef.current.find((e) => e.source === connection.source && e.target === connection.target);
    const point = edgeAnchorPoint(connection.source, connection.target);
    if (existing) {
      setEdgePromptAnchor({ edgeId: existing.id, ...point, isNew: false });
      return;
    }
    const id = `wf-${connection.source}-${connection.target}-${Date.now()}`;
    setWorkflowEdges((es) => [...es, { id, source: connection.source!, target: connection.target!, includePrevReply: true }]);
    setEdgePromptAnchor({ edgeId: id, ...point, isNew: true });
  }, [edgeAnchorPoint]);

  const onWorkflowEdgeDoubleClick = useCallback((e: React.MouseEvent, edge: Edge) => {
    if (edge.type !== "workflow") return;
    e.stopPropagation();
    const point = edgeAnchorPoint(edge.source, edge.target);
    setEdgePromptAnchor({ edgeId: edge.id, ...point, isNew: false });
  }, [edgeAnchorPoint]);

  const saveEdgePrompt = useCallback((v: EdgePromptValue) => {
    if (!edgePromptAnchor) return;
    const { edgeId } = edgePromptAnchor;
    setWorkflowEdges((es) => es.map((e) => (e.id === edgeId ? { ...e, prompt: v.prompt, includePrevReply: v.includePrevReply } : e)));
    setEdgePromptAnchor(null);
  }, [edgePromptAnchor]);

  const deleteWorkflowEdge = useCallback(() => {
    if (!edgePromptAnchor) return;
    const { edgeId } = edgePromptAnchor;
    setWorkflowEdges((es) => es.filter((e) => e.id !== edgeId));
    setEdgePromptAnchor(null);
  }, [edgePromptAnchor]);

  const cancelEdgePrompt = useCallback(() => {
    if (edgePromptAnchor?.isNew) {
      const { edgeId } = edgePromptAnchor;
      setWorkflowEdges((es) => es.filter((e) => e.id !== edgeId));
    }
    setEdgePromptAnchor(null);
  }, [edgePromptAnchor]);

  // Schedule-mode triggers self-fire on an interval (workflow-scheduler.ts).
  // runTrigger is stable (useCallback, stable deps) but indirect through a ref
  // anyway — cheap insurance so the scheduler instance never has to be rebuilt.
  const runTriggerRef = useRef(runTrigger);
  useEffect(() => { runTriggerRef.current = runTrigger; }, [runTrigger]);
  const schedulerRef = useRef<WorkflowScheduler | null>(null);
  if (!schedulerRef.current) schedulerRef.current = new WorkflowScheduler((id) => runTriggerRef.current(id));
  useEffect(() => {
    const sched = schedulerRef.current!;
    const liveTriggerIds = new Set<string>();
    for (const t of tiles) {
      if (t.kind !== "trigger") continue;
      liveTriggerIds.add(t.id);
      if (t.trigger?.mode === "schedule" && t.trigger.everyMs) sched.arm(t.id, t.trigger.everyMs);
      else sched.cancel(t.id);
    }
    for (const armedId of sched.armedIds()) if (!liveTriggerIds.has(armedId)) sched.cancel(armedId);
  }, [tiles]);
  useEffect(() => () => schedulerRef.current?.cancelAll(), []);

  // The frame the user most recently touched (spawned into / dragged). The
  // collision-separation pass keeps THIS frame fixed and pushes neighbours, so
  // growing a frame never makes your focus jump.
  const lastActiveFrameRef = useRef<string | null>(null);
  const repoPathRef = useRef(repoPath);
  useEffect(() => { repoPathRef.current = repoPath; }, [repoPath]);
  const rootRef = useRef(root);
  useEffect(() => { rootRef.current = root; }, [root]);
  // pushToast is defined far below (depends on dismissToast). bind/unbind are
  // declared above it, so reach it through a ref populated by an effect.
  const pushToastRef = useRef<((t: { tileId: string; label: string; status: TileStatusKind }) => void) | null>(null);
  // Track the selected frame id so F2 / bring-to-front can target it without
  // needing to thread react-flow's selection state through every render.
  // ref (updated in the setter) so F2 / bring-to-front / the keyboard handler
  // read the latest selection without the listener effect rebinding.
  const [selectedFrameId, setSelectedFrameId, selectedFrameIdRef] = useStateWithRef<string | null>(null);

  // Reload layout when the repo changes — each repo has its own canvas state.
  // Skip on first mount (initial values already came from useMemo above).
  const lastRepoRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    if (lastRepoRef.current === undefined) {
      lastRepoRef.current = persistKey;
      return;
    }
    if (lastRepoRef.current === persistKey) return;
    lastRepoRef.current = persistKey;
    const next = loadLayout(persistKey);
    setSizes(next.sizes);
    setPositions(next.positions);
    setFrames(next.frames);
    setTileNames(next.tileNames ?? {});
    setTiles(next.tiles ?? []);
    setEditorTabs(next.editorTabs ?? {});
    setFrameOf(next.frameOf ?? {});
    setWorkflowEdges(next.workflowEdges ?? []);
    if (next.viewport) setViewport(next.viewport);
  }, [persistKey]);

  // Latest viewport mutated on every pan tick (cheap — ref, no re-render);
  // committed to state at onMoveEnd so the layout-persist effect picks it up
  // and writes it to localStorage. Reload restores via defaultViewport. Must
  // be declared BEFORE the persist useEffect below, whose deps array reads
  // `viewport` during render (TDZ if declared later).
  const currentViewportRef = useRef<{ x: number; y: number; zoom: number }>(
    initial.viewport ?? DEFAULT_VIEWPORT,
  );
  const [viewport, setViewport] = useState(initial.viewport ?? DEFAULT_VIEWPORT);
  // Id of the node currently being dragged — set on drag start, cleared on drag
  // stop (feeds the compositing-hint class in onNodeDragStart).
  const draggingIdRef = useRef<string | null>(null);
  // The fixed full-window layer pinned tiles portal their floating panels into.
  // A ref-callback captures the DOM node into state so the context re-renders the
  // node wrappers once it mounts (portals need a live target). See the render.
  const [pinnedLayer, setPinnedLayer] = useState<HTMLDivElement | null>(null);

  // Persist on any layout change. **Trailing-debounced 250ms** so a drag
  // (which fires setPositions on every drop) doesn't trigger a synchronous
  // JSON.stringify of the full layout blob on the main thread per commit.
  // The serialize can be 50ms+ on a 20-tile workspace and the spike showed up
  // as a visible drop-snap stutter (P1 from perf review). Cancel on unmount
  // + on dep change so we don't keep stale references after repo switch.
  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => {
    if (typeof window === "undefined" || !persistKey) return;
    if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    persistTimerRef.current = setTimeout(() => {
      saveLayout(persistKey, { sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf, workflowEdges });
    }, 250);
    return () => {
      if (persistTimerRef.current) clearTimeout(persistTimerRef.current);
    };
  }, [persistKey, sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf, workflowEdges]);
  // Flush on tab close / app quit so the debounced write doesn't lose the
  // last ~250ms of edits. `beforeunload` fires sync before localStorage is
  // torn down; we set the latest snapshot then.
  useEffect(() => {
    if (typeof window === "undefined" || !persistKey) return;
    const flush = () => {
      if (!persistTimerRef.current) return;
      clearTimeout(persistTimerRef.current);
      persistTimerRef.current = undefined;
      saveLayout(persistKey, { sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf, workflowEdges });
    };
    window.addEventListener("beforeunload", flush);
    return () => window.removeEventListener("beforeunload", flush);
  }, [persistKey, sizes, positions, frames, tileNames, tiles, editorTabs, viewport, frameOf, workflowEdges]);

  // Viewport-focus request: we resolve the target's CENTER from our own state
  // (positions/sizes/frames) and hand absolute coords to <FocusOnTile>, which
  // setCenters on them. Resolving here (not via xyflow getNode) means focus
  // works even when the node hasn't been DOM-measured yet OR is culled
  // off-screen — fitView on an unmeasured node centers on a 0×0 box and does
  // nothing, which is why freshly-spawned tiles weren't centering.
  const [focusReq, setFocusReq] = useState<{ id: string; cx: number; cy: number; w: number; h: number; n: number; exact?: boolean } | null>(null);
  const focusTile = useCallback(
    (id: string, opts?: { exact?: boolean }) => {
      // Frame? center on its rect. Tile? center on pos + size. w/h let the exact
      // (100%) focus anchor a tile that's bigger than the viewport to its content
      // corner instead of center-clipping it.
      const frame = framesRef.current.find((f) => f.id === id);
      let cx: number, cy: number, w: number, h: number;
      if (frame) {
        cx = frame.x + frame.w / 2;
        cy = frame.y + frame.h / 2;
        w = frame.w;
        h = frame.h;
      } else {
        const p = positionsRef.current[id];
        if (!p) return;
        const s = sizesRef.current[id] ?? defaultTileSize(id);
        cx = p.x + s.width / 2;
        cy = p.y + s.height / 2;
        w = s.width;
        h = s.height;
      }
      setFocusReq((prev) => ({ id, cx, cy, w, h, n: (prev?.n ?? 0) + 1, exact: opts?.exact }));
    },
    [],
  );

  // Frame CRUD + opt-in arrange + the reactive auto-fit effect. See useFrameOps.
  const {
    addFrame, updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, moveFrame, bringFrameToFront,
  } = useFrameOps({
    repoPath, positions, sizes, tiles, frameOf,
    framesRef, tilesRef, frameOfRef, positionsRef, sizesRef, lastActiveFrameRef,
    setFrames, setPositions, focusTile,
  });

  // Worktree + workspace-zone lifecycle (IPC, in-flight guard, detach confirm).
  const {
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace, bindRemote,
  } = useWorktrees({
    framesRef, tilesRef, positionsRef, sizesRef, frameOfRef, repoPathRef,
    lastActiveFrameRef, pushToastRef, setFrames, setFrameOf, setSelectedFrameId,
    focusTile, closeTile,
  });

  /** Find the topmost frame containing the (x,y) point. Sorted by z desc so
   *  overlapping frames return the visually-topmost one. Used at tile-spawn
   *  time to auto-parent tiles dropped inside a frame. Returns the frame plus
   *  the position relative to the frame's origin (react-flow expects child
   *  positions to be relative when parentId set). */
  const sortedFrames = useMemo(
    () => [...frames].sort((a, b) => b.z - a.z),
    [frames],
  );
  // Membership by the tile's CENTER point (cx,cy), topmost frame wins. Center
  // (not top-left) makes "drag a tile out of the frame" intuitive — you drag
  // until its middle crosses the edge — and matches the auto-fit effect's rule.
  // Returns the owning frame's origin so the caller can compute the tile's
  // top-left RELATIVE position (relX = topLeftX − frame.x).
  const parentFrameOf = useCallback(
    (cx: number, cy: number): { parentId: string; fx: number; fy: number } | null => {
      // Innermost-frame-wins drop membership (pure — see frameAtPoint).
      const r = frameAtPoint(sortedFrames, cx, cy);
      return r ? { parentId: r.id, fx: r.x, fy: r.y } : null;
    },
    [sortedFrames],
  );

  // Which terminal tile ids fall inside each frame — drives the chip strip
  // in FrameNode header. Reuses the same absolute-position overlap logic as
  // parentFrameOf (positions[tileId] is ALWAYS absolute even when a tile is
  // react-flow-parented; we convert to relative only at the mkTile boundary).
  // Topmost frame wins (sortedFrames is z-desc) so overlapping frames don't
  // claim the same tile twice.
  const frameTiles = useMemo(() => {
    const map = new Map<string, string[]>();
    for (const t of tiles) {
      const fid = frameOf[t.id];
      if (!fid) continue;
      const arr = map.get(fid) ?? [];
      arr.push(t.id);
      map.set(fid, arr);
    }
    return map;
  }, [frameOf, tiles]);

  // Display-name map for FrameNode chip strip: tile id → user/auto name.
  // Memoized to keep node memoization stable.
  // Agent title overlays the auto label; a user rename overlays both.
  // Canvas frame-chip names: rename / static only — NOT the live agent OSC title.
  // The title churns ~every 600ms while an agent streams; including it here made
  // baseNodes rebuild each tick → cursor-flicker + focus loss. (Live titles still
  // show in the Layers panel, which derives its own list from agentTitles.)
  const framesChipNames = useMemo(() => ({ ...tileNames }), [tileNames]);

  // ── Figma-style Layers panel data ─────────────────────────────────────────
  // Every open tile flattened to { id, kind, name, frameId } for the left rail.
  const layerFrames: LayerFrame[] = useMemo(
    () => frames.map((f) => ({
      id: f.id, title: f.title, color: f.color,
      parentFrameId: f.parentFrameId, branch: f.parentFrameId ? f.branch : undefined,
      remote: isRemote(f.workspacePath),
    })),
    [frames],
  );
  const layerTiles: LayerTile[] = useMemo(() => {
    const out: LayerTile[] = [];
    const fo = frameOf;
    for (const t of tiles) {
      // Same effective-repo rule as node-build: a worktree/workspace frame can
      // supply the repo even when the canvas has no global one.
      const owner = fo[t.id] ? frames.find((f) => f.id === fo[t.id]) : undefined;
      const effRepo = owner?.worktreePath ?? owner?.workspacePath ?? repoPath ?? null;
      if ((t.kind === "editor" || t.kind === "diff" || t.kind === "file") && !effRepo) continue;
      // planReview tiles are a live blocked agent waiting on your review — they
      // DO belong in the Layers panel so you can navigate to them and see the
      // "review" status (LayersPanel renders kind === "planReview" specially).
      const kind: LayerTile["kind"] = t.kind === "shell" ? "terminal" : t.kind;
      const agent = t.kind === "claude" ? (agentForCmd(t.cmd)?.id ?? "claude") : undefined;
      out.push({ id: t.id, kind, name: tileNames[t.id] ?? agentTitles[t.id] ?? t.label, frameId: fo[t.id] ?? null, agent });
    }
    return out;
  }, [tiles, repoPath, frameOf, frames, tileNames, agentTitles]);
  const focusTileFromPanel = useCallback((id: string) => {
    setSelectedTileId(id);
    // Clicking a tile in the Layers panel must focus it EXACTLY like clicking it
    // on the canvas (onNodeClick) — not the older fit-to-screen zoom-out. Text
    // tiles (terminal/shell/diff/editor) snap to 100% with the content-corner
    // clamp; the rest get the framed focus. Mirrors the onNodeClick decision.
    const kind = tilesRef.current.find((x) => x.id === id)?.kind;
    const exact = kind === "claude" || kind === "shell" || kind === "diff" || kind === "editor";
    focusTile(id, { exact });
  }, [focusTile]);
  const focusFrameFromPanel = useCallback((id: string) => {
    setSelectedFrameId(id);
    setSelectedTileId(null);
    focusTile(id);
  }, [focusTile]);

  // ── Windowed ("editor-like") view mode ─────────────────────────────────────
  // A second way to look at the SAME session: the graph rail on the left + a
  // single frame-colored tab strip + one active tile body (WindowsView). Option
  // B — the tile bodies render from the SAME baseNodes data as the canvas, keyed
  // by tile id, so a mode switch remounts a body at most once (terminals reattach
  // to their PTY daemon by id; diff/issues/browser re-fetch cheaply).
  const [viewMode, setViewMode] = useState<ViewMode>(() => loadViewMode());
  useEffect(() => { saveViewMode(viewMode); }, [viewMode]);
  // Tiles minimized OUT of the tab strip (still in the graph rail so you can
  // restore them). Per-repo, reloaded when the persistence key changes.
  const [minimizedTabs, setMinimizedTabs] = useState<Set<string>>(() => loadMinimized(persistKey));
  useEffect(() => { setMinimizedTabs(loadMinimized(persistKey)); }, [persistKey]);
  useEffect(() => { saveMinimized(persistKey, minimizedTabs); }, [persistKey, minimizedTabs]);
  // The active tab in windows mode. Tracks the canvas selection where sensible
  // but is its own state so minimizing/closing can pick a sane neighbour.
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  // Tabs shown in the strip: every open tile (as the Layers panel sees them),
  // minus the minimized set. Order follows layerTiles (tiles in open order).
  const tabTiles = useMemo(
    () => layerTiles.filter((t) => !minimizedTabs.has(t.id)),
    [layerTiles, minimizedTabs],
  );
  // Keep activeTabId valid as tiles open/close/minimize (pure nextActiveTab).
  useEffect(() => {
    setActiveTabId((cur) => nextActiveTab(cur, tabTiles.map((t) => t.id)));
  }, [tabTiles]);

  const selectTab = useCallback((id: string) => {
    setActiveTabId(id);
    setSelectedTileId(id);
  }, []);
  const minimizeTab = useCallback((id: string) => {
    setMinimizedTabs((s) => {
      if (s.has(id)) return s;
      const next = new Set(s);
      next.add(id);
      return next;
    });
  }, []);
  const restoreTab = useCallback((id: string) => {
    setMinimizedTabs((s) => {
      if (!s.has(id)) return s;
      const next = new Set(s);
      next.delete(id);
      return next;
    });
    setActiveTabId(id);
    setSelectedTileId(id);
  }, []);
  const toggleViewMode = useCallback(() => {
    setViewMode((m) => (m === "canvas" ? "windows" : "canvas"));
  }, []);
  // ⌘/Ctrl+E toggles the mode; Settings dispatches an explicit set. Both keep
  // localStorage in sync via the persist effect above.
  useEffect(() => {
    const onToggle = () => toggleViewMode();
    const onSet = (e: Event) => {
      const m = (e as CustomEvent<{ mode?: ViewMode }>).detail?.mode;
      if (m === "canvas" || m === "windows") setViewMode(m);
    };
    window.addEventListener("hivemind:toggle-view-mode", onToggle);
    window.addEventListener("hivemind:set-view-mode", onSet as EventListener);
    return () => {
      window.removeEventListener("hivemind:toggle-view-mode", onToggle);
      window.removeEventListener("hivemind:set-view-mode", onSet as EventListener);
    };
  }, [toggleViewMode]);

  // Ctrl+Tab / Ctrl+Shift+Tab cycles between elements — browser/editor muscle
  // memory. Windows mode: move through the visible tabs (change the active tab).
  // Canvas mode: move the tile selection + fly focus to it. Kept in refs so the
  // capture-phase listener always reads the latest lists without re-binding.
  const cycleRef = useRef<{ mode: ViewMode; tabs: string[]; active: string | null; canvasTiles: string[]; selected: string | null }>({
    mode: viewMode, tabs: [], active: activeTabId, canvasTiles: [], selected: selectedTileId,
  });
  useEffect(() => {
    cycleRef.current = {
      mode: viewMode,
      active: activeTabId,
      selected: selectedTileId,
      tabs: tabTiles.map((t) => t.id),
      // Canvas mode cycles through every open tile (Layers-panel order).
      canvasTiles: layerTiles.map((t) => t.id),
    };
  }, [viewMode, activeTabId, selectedTileId, tabTiles, layerTiles]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // Ctrl+Tab (+Shift) — NOT Cmd+Tab (that's the OS app switcher). Capture
      // phase so xterm's key handler doesn't swallow it inside a focused terminal.
      if (e.key !== "Tab" || !e.ctrlKey || e.metaKey || e.altKey) return;
      const c = cycleRef.current;
      const list = c.mode === "windows" ? c.tabs : c.canvasTiles;
      if (list.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const cur = c.mode === "windows" ? c.active : c.selected;
      const idx = cur ? list.indexOf(cur) : -1;
      const dir = e.shiftKey ? -1 : 1;
      // Wrap around; from "none selected" go to first (fwd) or last (back).
      const next = list[(idx === -1 ? (dir === 1 ? 0 : list.length - 1) : (idx + dir + list.length) % list.length)];
      if (!next) return;
      if (c.mode === "windows") {
        setActiveTabId(next);
        setSelectedTileId(next);
      } else {
        setSelectedTileId(next);
        focusTile(next, { exact: true });
      }
    };
    window.addEventListener("keydown", onKey, true); // capture
    return () => window.removeEventListener("keydown", onKey, true);
  }, [focusTile]);

  // Permission mode the next Claude spawn launches in. Verified flag values
  // (code.claude.com/docs cli-reference): default | acceptEdits | plan | auto |
  // dontAsk | bypassPermissions. Persisted so it survives restarts.
  const [claudeMode, setClaudeMode] = useState<string>(
    () => localStorage.getItem("hivemind:claude-mode") || "default",
  );
  useEffect(() => { localStorage.setItem("hivemind:claude-mode", claudeMode); }, [claudeMode]);
  // Claude model the next Claude spawn launches with (claude-only `--model`
  // alias). "default" → omit the flag (workspace default). Persisted alongside
  // the permission mode so it survives restarts.
  // Default model for new claude spawns. Read from localStorage (a Settings
  // picker can set it later); the per-spawn `model` param overrides it. No tool-
  // island picker — it lived there briefly but was moved out for a cleaner bar.
  const [claudeModel] = useState<string>(
    () => localStorage.getItem("hivemind:claude-model") || "default",
  );
  // Which agent the tool island's spawn button creates (claude / codex / …).
  const [agentSel, setAgentSel] = useState<string>(
    () => localStorage.getItem("hivemind:agent-sel") || "claude",
  );
  const agentSelRef = useRef(agentSel);
  useEffect(() => { agentSelRef.current = agentSel; localStorage.setItem("hivemind:agent-sel", agentSel); }, [agentSel]);

  // Monotonic session counter — `xs.length + 1` produced DUPLICATE labels
  // (#3, #3) after kill+respawn. This only ever increases.
  const claudeSeqRef = useRef(0);
  // Spawn-target picker: when 2+ workspaces (base + workspace-zone frames) live
  // on the canvas, ask WHERE a new claude should run instead of guessing.
  const [spawnPick, setSpawnPick] = useState<{ kind: TileKind; mode?: string; work?: string; url?: string; agent?: { id: string; cmd: string; args?: string[]; label: string } } | null>(null);
  // Confirmation gate for the destructive "reset tile layout" (clear-all) button
  // in the zoom island — wiping every frame/tile is irreversible, so ask first.
  const [confirmClear, setConfirmClear] = useState(false);
  // Right-click "spawn a component" menu. Opened from the pane onContextMenu
  // with the click coords + the frame the click landed in (null = bare canvas,
  // which routes spawns through the global path). Null = closed.
  const [spawnMenu, setSpawnMenu] = useState<CanvasSpawnMenuState | null>(null);
  const browserReqSeq = useRef(0);
  const [browserOpenReqs, setBrowserOpenReqs] = useState<Record<string, { url: string; seq: number }>>({});
  // Text awaiting a claude target — set when something wants to deliver a prompt
  // ("Work on this", diff "send review") and 2+ claude tiles exist, so the user
  // picks WHICH claude (or a new one). 0 claude → spawn new directly; the picker
  // also lists the single-claude case as "this / new".
  const [claudePick, setClaudePick] = useState<{ text: string } | null>(null);
  // Frame awaiting a remote (ssh://) bind — set when FrameNode fires
  // `hivemind:attach-remote`; the modal connects, browses, and binds the picked
  // ssh uri as that frame's workspacePath.
  const [remoteAttach, setRemoteAttach] = useState<string | null>(null);
  useEffect(() => {
    const onAttach = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId: string }>).detail?.frameId;
      if (fid) setRemoteAttach(fid);
    };
    window.addEventListener("hivemind:attach-remote", onAttach as EventListener);
    return () => window.removeEventListener("hivemind:attach-remote", onAttach as EventListener);
  }, []);

  // External-tracker sync settings — opened from an IssuesTile's gear button,
  // which fires `hivemind:sync-settings` with its OWN root (a board's sync
  // config is per-workspace, and a frame can host an IssuesTile bound to a
  // different repo than the canvas's base root — see IssueCard's
  // `hivemind:open-issue` for the same explicit-root pattern). Rendered here,
  // outside react-flow's transformed viewport, so `position: fixed` overlays
  // the real screen instead of resolving against the canvas transform.
  const [syncSettingsRoot, setSyncSettingsRoot] = useState<string | null>(null);
  useEffect(() => {
    const onSyncSettings = (e: Event) => {
      const root = (e as CustomEvent<{ root: string }>).detail?.root;
      if (root) setSyncSettingsRoot(root);
    };
    window.addEventListener("hivemind:sync-settings", onSyncSettings as EventListener);
    return () => window.removeEventListener("hivemind:sync-settings", onSyncSettings as EventListener);
  }, []);

  // Git commit/sync modal — open for a specific repo (a frame's worktree /
  // workspace / base repo). Opened from the frame header git button or the rail
  // "Git ▸ Commit…" entry, both firing `hivemind:frame-git` {frameId}.
  const [gitModalRepo, setGitModalRepo] = useState<string | null>(null);
  useEffect(() => {
    const onGit = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId?: string; repoPath?: string }>).detail;
      // Either an explicit repoPath (base/global git button) or a frame id we
      // resolve to its effective repo (worktree/workspace/base).
      if (fid?.repoPath) { setGitModalRepo(fid.repoPath); return; }
      if (fid?.frameId) {
        const f = framesRef.current.find((x) => x.id === fid.frameId);
        const repo = f?.worktreePath ?? f?.workspacePath ?? repoPathRef.current ?? null;
        if (repo) setGitModalRepo(repo);
      }
    };
    window.addEventListener("hivemind:frame-git", onGit as EventListener);
    return () => window.removeEventListener("hivemind:frame-git", onGit as EventListener);
  }, []);

  // Single-file tile: pick a workspace file, then spawn a `file` tile bound to
  // it into the frame. Fired by the "File…" entries in the spawn menus.
  const [filePick, setFilePick] = useState<{ frameId: string; repoPath: string | null } | null>(null);
  useEffect(() => {
    const onOpenFile = (e: Event) => {
      const fid = (e as CustomEvent<{ frameId?: string }>).detail?.frameId;
      const frameId = fid ?? selectedFrameIdRef.current ?? framesRef.current[0]?.id;
      if (!frameId) return;
      const f = framesRef.current.find((x) => x.id === frameId);
      const repo = f?.worktreePath ?? f?.workspacePath ?? repoPathRef.current ?? null;
      setFilePick({ frameId, repoPath: repo });
    };
    window.addEventListener("hivemind:frame-open-file", onOpenFile as EventListener);
    return () => window.removeEventListener("hivemind:frame-open-file", onOpenFile as EventListener);
  }, []);

  // Position a new tile inside a frame. Tiles pack left-to-right then WRAP to a
  // new row past FRAME_ROW_MAX (so a frame grows DOWN, not infinitely right).
  // The frame's SIZE is the auto-fit effect's job — it derives geometry from
  // the member bbox once this position commits, then separates frames so the
  // grown frame never overlaps a neighbour. We only pick the new tile's slot.
  // Tile spawning + in-frame placement (placeInFrame / ensureFrame / spawnTile
  // + spawnInto/spawnClaude/spawnVis/frameOpen). See useSpawn.
  const { spawnTile, spawnClaude, spawnAgent, spawnVis, spawnInto, frameOpen, openPlanReview, hcpSpawnAgent, ensureFrame } = useSpawn({
    repoPath, claudeMode, claudeModel,
    positionsRef, sizesRef, tilesRef, frameOfRef, framesRef, selectedFrameIdRef,
    selectedTileIdRef, repoPathRef, rootRef, lastActiveFrameRef, claudeSeqRef,
    setFrameOf, setPositions, setSelectedTileId, setFocusReq, setFrames,
    setSelectedFrameId, setTiles, setSpawnPick, focusTile,
  });

  // Create a new Command Button: spawn the tile (into the active/resolved frame,
  // like any other tile), then immediately open the modal in create mode so the
  // user names it + writes the script. A cancel from create mode discards the
  // freshly-spawned empty button (below, in the modal wiring).
  const createCmdButton = useCallback((targetFrameId?: string) => {
    const id = `tile-cmdButton-${Date.now()}`;
    if (targetFrameId) spawnTile("cmdButton", targetFrameId);
    else spawnInto("cmdButton");
    // spawnInto/spawnTile generates its own id; re-read the just-added tile so
    // the modal targets it. Append is synchronous; the last never-configured
    // cmdButton is ours. Use a microtask so the state has settled.
    queueMicrotask(() => {
      const fresh = tilesRef.current.filter((t) => t.kind === "cmdButton" && !t.cmdButton);
      const target = fresh[fresh.length - 1];
      setCmdModal({ tileId: target?.id ?? id, mode: "create" });
    });
  }, [spawnInto, spawnTile]);

  // Persist a button's config: write the script/cwd onto the TileInstance and
  // the name into the tileNames map (round-trips with the layout).
  const submitCmdButton = useCallback((cfg: CmdButtonConfig) => {
    if (!cmdModal) return;
    const { tileId } = cmdModal;
    setTiles((ts) => ts.map((t) => (t.id === tileId ? { ...t, cmdButton: { script: cfg.script, cwd: cfg.cwd } } : t)));
    renameTile(tileId, cfg.name);
    setCmdModal(null);
  }, [cmdModal, renameTile]);

  // Cancel: in CREATE mode a never-configured button is noise — drop it. In EDIT
  // mode just close (keep the existing config + its live runner state).
  const cancelCmdButton = useCallback(() => {
    if (cmdModal?.mode === "create") {
      const id = cmdModal.tileId;
      const inst = tilesRef.current.find((t) => t.id === id);
      if (inst && !inst.cmdButton) closeTile(id);
    }
    setCmdModal(null);
  }, [cmdModal, closeTile]);

  // Create a new Trigger — same spawn-then-configure dance as createCmdButton.
  const createTrigger = useCallback((targetFrameId?: string) => {
    const id = `tile-trigger-${Date.now()}`;
    if (targetFrameId) spawnTile("trigger", targetFrameId);
    else spawnInto("trigger");
    queueMicrotask(() => {
      const fresh = tilesRef.current.filter((t) => t.kind === "trigger" && !t.trigger);
      const target = fresh[fresh.length - 1];
      setTriggerModal({ tileId: target?.id ?? id, mode: "create" });
    });
  }, [spawnInto, spawnTile]);

  const submitTrigger = useCallback((cfg: TriggerConfig) => {
    if (!triggerModal) return;
    const { tileId } = triggerModal;
    setTiles((ts) => ts.map((t) => (t.id === tileId ? { ...t, trigger: { mode: cfg.mode, everyMs: cfg.everyMs } } : t)));
    renameTile(tileId, cfg.name);
    setTriggerModal(null);
  }, [triggerModal, renameTile]);

  const cancelTrigger = useCallback(() => {
    if (triggerModal?.mode === "create") {
      const id = triggerModal.tileId;
      const inst = tilesRef.current.find((t) => t.id === id);
      if (inst && !inst.trigger) closeTile(id);
    }
    setTriggerModal(null);
  }, [triggerModal, closeTile]);

  // Right-click on empty canvas space → open the spawn menu. We hit-test the
  // click against the frames (innermost wins) so a component spawned from inside
  // a frame is born associated with it; a click on bare canvas targets null (the
  // global spawn path). Only fires on the empty pane — clicks on a tile/header
  // fall through to the tile's own handling (and are filtered here by target).
  const onCanvasContextMenu = useCallback((e: React.MouseEvent) => {
    // Always suppress the native menu (so right-drag panning stays snappy).
    e.preventDefault();
    const target = e.target as HTMLElement;
    // Only the empty pane / frame body should pop the spawn menu — never a tile,
    // its header, or the floating chrome (those manage their own right-click).
    const onChrome = target.closest(".tile-drag-handle, .react-flow__controls, .react-flow__minimap, .react-flow__panel");
    // A react-flow node that is NOT a frame means the click landed on a tile — skip.
    const nodeEl = target.closest<HTMLElement>(".react-flow__node");
    const overTile = !!nodeEl && !nodeEl.classList.contains("react-flow__node-frame");
    if (onChrome || overTile) return;
    // Convert client → flow coords using the live viewport transform (Canvas is
    // not inside a ReactFlowProvider, so we can't use screenToFlowPosition here).
    const rect = flowWrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const vp = currentViewportRef.current;
    const fx = (e.clientX - rect.left - vp.x) / vp.zoom;
    const fy = (e.clientY - rect.top - vp.y) / vp.zoom;
    const hit = parentFrameOf(fx, fy);
    const frame = hit ? framesRef.current.find((f) => f.id === hit.parentId) : undefined;
    setSpawnMenu({
      x: e.clientX,
      y: e.clientY,
      frameId: hit?.parentId ?? null,
      targetLabel: frame?.title ?? "canvas",
    });
  }, [parentFrameOf]);

  // Spawn-menu dispatch: with a frameId the component is born INSIDE that frame;
  // null routes through the global spawn path (selection → picker → base frame).
  const menuSpawnAgent = useCallback((agentId: string, frameId: string | null) => {
    if (frameId) { frameOpen(frameId, agentId); return; }
    const a = agentById(agentId);
    if (a) spawnAgent({ id: a.id, cmd: a.cmd, defaultArgs: a.defaultArgs, label: a.label });
  }, [frameOpen, spawnAgent]);
  const menuSpawnKind = useCallback((kind: string, frameId: string | null) => {
    if (frameId) { frameOpen(frameId, kind); return; }
    // Bare-canvas (no frame): route through the global spawn path. `tree` maps
    // to an editor tile; browser has no spawnVis variant so spawn it directly.
    if (kind === "browser") { spawnInto("browser"); return; }
    spawnVis(kind === "tree" ? "tree" : (kind as "shell" | "diff" | "issues"));
  }, [frameOpen, spawnVis, spawnInto]);
  const menuSpawnFile = useCallback((frameId: string | null) => {
    const f = frameId ? framesRef.current.find((x) => x.id === frameId) : undefined;
    const targetFrame = f ?? framesRef.current.find((x) => !x.parentFrameId);
    if (!targetFrame) return;
    const repo = targetFrame.worktreePath ?? targetFrame.workspacePath ?? repoPathRef.current ?? null;
    setFilePick({ frameId: targetFrame.id, repoPath: repo });
  }, []);
  const menuSpawnCommand = useCallback((frameId: string | null) => {
    createCmdButton(frameId ?? undefined);
  }, [createCmdButton]);
  const menuSpawnTrigger = useCallback((frameId: string | null) => {
    createTrigger(frameId ?? undefined);
  }, [createTrigger]);

  // Rail context-menu actions — the SAME surface the on-canvas frame header
  // exposes, reused from the Layers rail (drives a workspace in windows mode,
  // where the header isn't visible; handy in canvas mode too). Each maps to an
  // existing handler/event so behaviour is identical to the header.
  const gitPushMut = useGitPush();
  const gitPullMut = useGitPull();
  const repoOfFrame = useCallback((frameId: string): string | null => {
    const f = framesRef.current.find((x) => x.id === frameId);
    return f?.worktreePath ?? f?.workspacePath ?? repoPathRef.current ?? null;
  }, []);
  // Re-parent a frame under `parentId` (nest) or to top-level (`null` = detach)
  // WITHOUT dragging — the menu equivalent of the drag-into-frame gesture. On
  // nest we shift the frame (and its body: descendant frames + all member tiles)
  // to sit just inside the parent's top-left, so it visibly lands inside; the
  // auto-fit/collision effect then settles the final packing. 2-level rule and
  // eligibility are enforced by nestTargetsFor (menu only offers valid targets).
  const reparentFrame = useCallback((frameId: string, parentId: string | null) => {
    const f = framesRef.current.find((x) => x.id === frameId);
    if (!f) return;
    if (parentId === (f.parentFrameId ?? null)) return; // no-op
    let dx = 0, dy = 0;
    if (parentId) {
      const parent = framesRef.current.find((x) => x.id === parentId);
      if (!parent) return;
      // Land the frame just inside the parent's content area (below its header).
      const targetX = parent.x + FRAME_PAD;
      const targetY = parent.y + FRAME_HEADER + FRAME_PAD;
      dx = targetX - f.x;
      dy = targetY - f.y;
    }
    // Move the frame + its descendant frames + every member tile of both so the
    // whole zone travels together (mirrors the drag-stop body-carry logic).
    const descendants = framesRef.current.filter((x) => x.parentFrameId === frameId).map((x) => x.id);
    const movedFrames = new Set<string>([frameId, ...descendants]);
    const moveIds = Object.keys(frameOfRef.current).filter((tid) => movedFrames.has(frameOfRef.current[tid]!));
    if ((dx !== 0 || dy !== 0) && moveIds.length > 0) {
      setPositions((prev) => {
        const next = { ...prev };
        for (const tid of moveIds) { const p = next[tid]; if (p) next[tid] = { x: p.x + dx, y: p.y + dy }; }
        return next;
      });
    }
    lastActiveFrameRef.current = frameId;
    setFrames((fs) => fs.map((x) => {
      if (x.id === frameId) return { ...x, x: x.x + dx, y: x.y + dy, parentFrameId: parentId ?? undefined };
      if (descendants.includes(x.id)) return { ...x, x: x.x + dx, y: x.y + dy };
      return x;
    }));
  }, []);

  // Frames a given frame can be nested under: top-level frames only (2-level
  // rule), excluding itself, its current parent, and any frame that is already
  // a child. A frame that itself HAS children can't become a child.
  const nestTargetsFor = useCallback((frameId: string): { id: string; title: string }[] => {
    const f = framesRef.current.find((x) => x.id === frameId);
    if (!f) return [];
    const hasChildren = framesRef.current.some((x) => x.parentFrameId === frameId);
    if (hasChildren) return [];
    return framesRef.current
      .filter((x) => x.id !== frameId && !x.parentFrameId && x.id !== f.parentFrameId)
      .map((x) => ({ id: x.id, title: x.title }));
  }, []);

  const frameActions = useMemo(() => ({
    onOpenInFrame: (frameId: string, kind: string) => {
      // A command button / trigger needs its create modal after spawn, so it
      // can't go through the plain frameOpen spawn path — route it to the
      // modal-aware creator, targeting this frame.
      if (kind === "cmdButton") { createCmdButton(frameId); return; }
      if (kind === "trigger") { createTrigger(frameId); return; }
      frameOpen(frameId, kind);
    },
    onOpenFilePicker: (frameId: string) =>
      window.dispatchEvent(new CustomEvent("hivemind:frame-open-file", { detail: { frameId } })),
    onCreateWorktree,
    onAttachWorktree,
    onBindWorkspace: (frameId: string) => bindWorkspace(frameId),
    onAttachRemote: (frameId: string) =>
      window.dispatchEvent(new CustomEvent("hivemind:attach-remote", { detail: { frameId } })),
    onArrange: (frameId: string, mode: "columns" | "rows" | "grid") => arrangeFrame(frameId, mode),
    onRename: (frameId: string, title: string) => updateFrameTitle(frameId, title),
    onColor: (frameId: string, color: string) => updateFrameColor(frameId, color),
    onDelete: (frameId: string) => deleteFrame(frameId),
    onNest: (frameId: string, parentId: string | null) => reparentFrame(frameId, parentId),
    nestTargets: (frameId: string) => nestTargetsFor(frameId),
    onGit: (frameId: string) =>
      window.dispatchEvent(new CustomEvent("hivemind:frame-git", { detail: { frameId } })),
    // Quick push/pull straight from the rail (the modal offers the full flow +
    // first-push upstream handling; these are the common already-tracked case).
    onPush: (frameId: string) => { const r = repoOfFrame(frameId); if (r) gitPushMut.mutate({ repoPath: r }); },
    onPull: (frameId: string) => { const r = repoOfFrame(frameId); if (r) gitPullMut.mutate({ repoPath: r }); },
    repoPathForFrame: (frameId: string): string | null => {
      const f = framesRef.current.find((x) => x.id === frameId);
      return f?.worktreePath ?? f?.workspacePath ?? repoPath ?? null;
    },
  }), [frameOpen, createCmdButton, onCreateWorktree, onAttachWorktree, bindWorkspace, arrangeFrame, updateFrameTitle, updateFrameColor, deleteFrame, repoPath, repoOfFrame, gitPushMut, gitPullMut, reparentFrame, nestTargetsFor]);
  const openFileFromTerminal = useCallback((sourceTileId: string, path: string) => {
    const sourceFrameId = frameOfRef.current[sourceTileId] ?? selectedFrameIdRef.current;
    const existing = tilesRef.current.find((t) => (
      (t.kind === "editor" || t.kind === "workbench") &&
      (!sourceFrameId || frameOfRef.current[t.id] === sourceFrameId)
    ));
    if (existing) {
      openFileInTile(existing.id, path);
      setTimeout(() => { setSelectedTileId(existing.id); focusTile(existing.id); }, 0);
      return;
    }
    spawnTile("editor", sourceFrameId ?? null, {});
  }, [openFileInTile, focusTile, spawnTile]);

  const openUrlInBrowser = useCallback((sourceTileId: string, url: string) => {
    const sourceFrameId = frameOfRef.current[sourceTileId] ?? selectedFrameIdRef.current;
    const existing = tilesRef.current.find((t) => (
      t.kind === "browser" && (!sourceFrameId || frameOfRef.current[t.id] === sourceFrameId)
    ));
    if (existing) {
      const browserFrameId = frameOfRef.current[existing.id] ?? null;
      const seq = ++browserReqSeq.current;
      setBrowserOpenReqs((m) => ({ ...m, [existing.id]: { url, seq } }));
      // Defer selection past the click-bubble: onNodeClick fires on the terminal
      // node after our handler and would re-select it, clobbering our selection.
      setTimeout(() => {
        if (browserFrameId) setSelectedFrameId(browserFrameId);
        setSelectedTileId(existing.id);
        focusTile(existing.id);
      }, 0);
      return;
    }
    spawnTile("browser", sourceFrameId ?? null, { url });
  }, [focusTile, spawnTile]);

  // Plan review: an agent hit ExitPlanMode → main's plan-bridge pushed the plan.
  // Open a PlanReviewTile beside the agent (the tile decides and unblocks the
  // hook via planReviewDecide). On abort (hook/agent gone) close the open tile.
  useEffect(() => {
    const offOpen = window.hive.onPlanReviewOpen((p) => {
      openPlanReview({ requestId: p.requestId, plan: p.plan, cwd: p.cwd, agentTileId: p.tileId });
    });
    const offAbort = window.hive.onPlanReviewAbort((requestId) => {
      const tile = tilesRef.current.find((t) => t.kind === "planReview" && t.review?.requestId === requestId);
      if (tile) closeTile(tile.id);
    });
    return () => { offOpen(); offAbort(); };
  }, [openPlanReview, closeTile]);

  // HCP control plane: main forwards a canvas verb (e.g. tile.spawn_agent from an
  // agent's hive MCP). Execute it via useSpawn and reply with the result/error.
  useEffect(() => {
    const off = window.hive.onHcpCommand(async (cmd) => {
      try {
        const p = (cmd.params ?? {}) as Record<string, unknown>;
        switch (cmd.method) {
          case "tile.spawn_agent": {
            const tileId = hcpSpawnAgent(p as { agent?: string; prompt?: string; frame?: string; mode?: string; model?: string; callerTile?: string; background?: boolean; name?: string });
            await window.hive.hcpResult(cmd.id, true, { tileId });
            break;
          }
          case "tile.list": {
            // Resolve an optional frame filter (id → title → path basename →
            // title substring), same precedence as spawn's frame targeting.
            const resolveFrameId = (q: string): string | undefined => {
              const fs = framesRef.current;
              const lq = q.toLowerCase();
              const base = (pp?: string) => pp?.split("/").filter(Boolean).pop()?.toLowerCase();
              return (
                fs.find((f) => f.id === q) ??
                fs.find((f) => f.title.toLowerCase() === lq) ??
                fs.find((f) => base(f.worktreePath) === lq || base(f.workspacePath) === lq) ??
                fs.find((f) => f.title.toLowerCase().includes(lq))
              )?.id;
            };
            const filterId = p.frame ? resolveFrameId(String(p.frame)) : undefined;
            const mapTile = (t: typeof tilesRef.current[number]) => ({
              tileId: t.id, kind: t.kind, label: t.label, status: statusOf(t.id),
            });
            const groupOf = (f: FrameState) => ({
              frameId: f.id,
              title: f.title,
              repo: f.worktreePath ?? f.workspacePath ?? null,
              branch: f.branch ?? null,
              tiles: tilesRef.current.filter((t) => frameOfRef.current[t.id] === f.id).map(mapTile),
            });
            if (filterId) {
              const f = framesRef.current.find((fr) => fr.id === filterId)!;
              await window.hive.hcpResult(cmd.id, true, { frames: [groupOf(f)], loose: [] });
              break;
            }
            // Drop empty frames; loose = tiles whose frame is unknown/missing.
            const frameIds = new Set(framesRef.current.map((f) => f.id));
            const frames = framesRef.current.map(groupOf).filter((g) => g.tiles.length > 0);
            const loose = tilesRef.current
              .filter((t) => { const fid = frameOfRef.current[t.id]; return !fid || !frameIds.has(fid); })
              .map(mapTile);
            await window.hive.hcpResult(cmd.id, true, { frames, loose });
            break;
          }
          case "tile.list_frames": {
            const frames = framesRef.current.map((f) => ({
              id: f.id,
              title: f.title,
              repo: f.worktreePath ?? f.workspacePath ?? null,
              branch: f.branch ?? null,
              tiles: tilesRef.current.filter((t) => frameOfRef.current[t.id] === f.id).length,
            }));
            await window.hive.hcpResult(cmd.id, true, { frames });
            break;
          }
          case "tile.focus": {
            const id = String(p.tileId ?? "");
            setSelectedTileId(id);
            focusTile(id);
            await window.hive.hcpResult(cmd.id, true, { ok: true });
            break;
          }
          case "tile.close": {
            closeTile(String(p.tileId ?? ""));
            await window.hive.hcpResult(cmd.id, true, { ok: true });
            break;
          }
          case "review.open": {
            // Open the review tile carrying THIS command's id; the tile replies
            // (hcpResult) on the user's decision — so do NOT reply here.
            openPlanReview({ plan: String(p.plan ?? ""), cwd: String(p.cwd ?? ""), hcpCmdId: cmd.id });
            break;
          }
          default:
            await window.hive.hcpResult(cmd.id, false, undefined, `unknown renderer verb: ${cmd.method}`);
        }
      } catch (e) {
        await window.hive.hcpResult(cmd.id, false, undefined, (e as Error)?.message ?? "renderer error");
      }
    });
    return off;
  }, [hcpSpawnAgent, focusTile, closeTile]);

  // HCP pipes → animated data-flow edges. Add on connect; on disconnect remove
  // the one edge (dst set) or all of src's edges (dst null).
  useEffect(() => {
    return window.hive.onHcpPipe((ev) => {
      setPipes((cur) => {
        if (ev.connected && ev.dst) {
          if (cur.some((p) => p.src === ev.src && p.dst === ev.dst)) return cur;
          return [...cur, { src: ev.src, dst: ev.dst }];
        }
        return cur.filter((p) => p.src !== ev.src || (ev.dst != null && p.dst !== ev.dst));
      });
    });
  }, []);

  // HCP spawn wires → dashed parentage edges. Add on spawn; on close (parent null,
  // connected false) drop every link where the closed tile is parent OR child.
  useEffect(() => {
    return window.hive.onHcpSpawn((ev) => {
      setSpawnLinks((cur) => {
        if (ev.connected && ev.parent) {
          if (cur.some((l) => l.parent === ev.parent && l.child === ev.child)) return cur;
          return [...cur, { parent: ev.parent, child: ev.child }];
        }
        return cur.filter((l) => l.child !== ev.child && l.parent !== ev.child);
      });
    });
  }, []);

  // HCP "wait" states (control-plane derived: a supervised worker blocked on its
  // parent's approval) → override the scrape on the status bus so the tile reads
  // "waiting: approval" instead of a misleading "idle".
  useEffect(() => {
    return window.hive.onHcpWait((ev) => {
      // ev.tileId is already the bare tile id (the status bus key).
      setWaitStatus(ev.tileId, (ev.status as TileStatusKind | null) ?? null);
    });
  }, []);

  // HCP subagent lifecycle (deterministic SubagentStart/Stop hooks) → keep a tile
  // reading "working" while it has in-flight Task subagents, including BACKGROUND
  // agents where the main loop is back at the idle prompt and the scrape misses it.
  useEffect(() => {
    return window.hive.onHcpSubagent((ev) => {
      // ev.tileId is already the bare tile id (the status bus key).
      setSubagentBusy(ev.tileId, ev.busy);
    });
  }, []);

  // HCP "needs you" (claude's deterministic Notification hook) → a soft status
  // override the scrape auto-clears when work resumes. Hardens permission/question
  // detection against UI-string drift; tileId is already bare.
  useEffect(() => {
    return window.hive.onHcpNotify((ev) => {
      setNotify(ev.tileId, ev.status as TileStatusKind);
    });
  }, []);

  // HCP turn state — claude's hook-driven working/idle (UserPromptSubmit → working,
  // Stop → idle). Authoritative over the screen-scrape for working/idle; immune to
  // TUI/scroll/focus/buffer-replay churn. ev.tileId is already bare.
  useEffect(() => {
    return window.hive.onHcpTurnState((ev) => {
      setTurnState(ev.tileId, ev.state);
    });
  }, []);

  // Plan-review wait: while a planReview tile is open for an agent, that agent is
  // blocked on its ExitPlanMode handoff → mark it "waiting: review" (cleared when
  // the plan tile closes). Diff against the previous set to set/clear precisely.
  const planAgentsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const now = new Set<string>();
    for (const t of tiles) if (t.kind === "planReview" && t.review?.agentTileId) now.add(t.review.agentTileId);
    for (const a of now) if (!planAgentsRef.current.has(a)) setWaitStatus(a, "plan_review");
    for (const a of planAgentsRef.current) if (!now.has(a)) setWaitStatus(a, null);
    planAgentsRef.current = now;
  }, [tiles]);

  // Deliver a prompt to claude with a TARGET PICKER. "Work on this" and the
  // diff "send review" fire `hivemind:deliver-to-claude` with the text; we route
  // by how many claude tiles exist: 0 → spawn a new claude carrying the prompt;
  // 1+ → show a picker (the chosen tile, or "New claude"). Old direct paths
  // (spawn-claude / send-to-claude) still work for internal callers.
  const deliverToClaude = useCallback((text: string, target: "new" | string) => {
    if (target === "new") { spawnClaude(undefined, text); return; }
    window.dispatchEvent(new CustomEvent("hivemind:send-to-claude", { detail: { text, target } }));
    setSelectedTileId(target);
    focusTile(target);
  }, [spawnClaude, focusTile]);
  useEffect(() => {
    const onDeliver = (e: Event) => {
      const text = (e as CustomEvent<{ text: string }>).detail?.text;
      if (!text) return;
      const claudes = tilesRef.current.filter((t) => t.kind === "claude");
      if (claudes.length === 0) { spawnClaude(undefined, text); return; }
      setClaudePick({ text });
    };
    window.addEventListener("hivemind:deliver-to-claude", onDeliver as EventListener);
    return () => window.removeEventListener("hivemind:deliver-to-claude", onDeliver as EventListener);
  }, [spawnClaude]);

  // "Work on this task": spawn the TASK'S agent in the TASK'S workspace, and
  // hand it the task reference. Resolution:
  //   • Workspace: the frame whose workspaceRoot/workspacePath matches the
  //     issue's `.hivemind` root (so the agent runs in the right repo/cwd). Fall
  //     back to the active frame when nothing matches.
  //   • Agent: the agent assigned to the task (issue.assignee, type=agent) if
  //     it's a known registry agent; else the island's selected agent; else
  //     claude. A custom-catalog id we don't recognize still spawns claude (a
  //     safe generic) carrying the task prompt.
  //   • Prompt: names the issue id + title and tells the agent to load it via
  //     hive_get_issue and treat later "faça isso" as scoped to THIS task.
  useEffect(() => {
    const onWork = (e: Event) => {
      const d = (e as CustomEvent<{ root: string | null; id: string; title?: string; agent?: string; model?: string }>).detail;
      if (!d?.id) return;
      const norm = (p?: string | null) => (p ? p.replace(/\/+$/, "").replace(/\/\.hivemind$/, "") : "");
      const issueRepo = norm(d.root);
      // Prefer a frame bound to the issue's workspace (by root or repo path).
      const frame =
        framesRef.current.find(
          (f) => norm(f.workspaceRoot) === norm(d.root) || (!!issueRepo && norm(f.workspacePath) === issueRepo),
        ) ?? undefined;
      const reg = d.agent ? agentById(d.agent) : undefined;
      const work =
        `You are working on task ${d.id}${d.title ? ` — "${d.title}"` : ""}. ` +
        `First load it with hive_get_issue ${d.id} to read the description and acceptance criteria. ` +
        `Implement it end-to-end, tick acceptance criteria as you go, and finish by setting its state with hive_set_state. ` +
        `Treat any later instruction like "faça isso"/"do this" as referring to THIS task (${d.id}) — re-read it with hive_get_issue if unsure.`;
      const targetFrameId = frame?.id ?? ensureFrame().id;
      // A recognized registry agent (codex/opencode/…) spawns with its binary;
      // claude (or an unknown/custom id) spawns as claude carrying the prompt.
      if (reg && reg.id !== "claude") {
        spawnTile("claude", targetFrameId, {
          agent: { id: reg.id, cmd: reg.cmd, args: reg.defaultArgs, label: reg.label },
          work,
        });
      } else {
        spawnTile("claude", targetFrameId, { work });
      }
    };
    window.addEventListener("hivemind:work-on-issue", onWork as EventListener);
    return () => window.removeEventListener("hivemind:work-on-issue", onWork as EventListener);
  }, [spawnTile, ensureFrame]);

  // Spawn the island's CURRENTLY-selected agent (key "2"), reading agentSel via
  // a ref so the stable callback always uses the latest selection.
  const spawnSelectedAgent = useCallback(() => {
    const a = agentById(agentSelRef.current) ?? AGENTS[0]!;
    spawnAgent(a);
  }, [spawnAgent]);

  // Keyboard shortcuts + menu event listeners. See useCanvasShortcuts.
  useCanvasShortcuts({
    repoPath, spawnClaude, spawnSelectedAgent, spawnVis, spawnBrowser: () => spawnInto("browser"), spawnCmdButton: createCmdButton, spawnTrigger: createTrigger, addFrame, frameOpen, focusTile,
    setSelectedTileId, setFocusModeReq, selectedTileIdRef, selectedFrameIdRef,
    focusModeNonceRef, tilesRef,
  });

  // Pin state derived from tiles. `pinnedIds` tells the node builder which tiles
  // render as screen-fixed floating panels (portaled out of the transformed
  // viewport into the fixed pinned layer — see canvas-nodes.tsx TileShell).
  const pinnedIds = useMemo(
    () => new Set(tiles.filter((t) => t.pinned).map((t) => t.id)),
    [tiles],
  );
  // Toggle a tile's pin. Pinning captures the tile's current SCREEN rect (top-left
  // + size, from its DOM) so the floating panel opens exactly where and the size
  // the tile is; the anchor is clamped inside the window. Unpinning keeps the
  // anchor/size (so a re-pin lands in the same place) and returns the tile to its
  // normal canvas node.
  const togglePin = useCallback((id: string, rect: PinRect) => {
    setTiles((ts) => ts.map((t) => {
      if (t.id !== id) return t;
      if (t.pinned) return { ...t, pinned: false };
      const anchor = clampAnchor(
        { sx: rect.sx, sy: rect.sy },
        { w: rect.w, h: rect.h },
        { w: window.innerWidth, h: window.innerHeight },
      );
      return { ...t, pinned: true, pinAnchor: anchor, pinSize: { w: rect.w, h: rect.h } };
    }));
  }, [setTiles]);
  // Persist a pinned panel's new anchor/size after a drag or resize (the panel
  // owns its live geometry; this just commits it back to the tile so it survives
  // reloads).
  const onPinChange = useCallback((id: string, patch: { anchor?: { sx: number; sy: number }; size?: { w: number; h: number } }) => {
    setTiles((ts) => ts.map((t) => (t.id === id
      ? { ...t, ...(patch.anchor ? { pinAnchor: patch.anchor } : {}), ...(patch.size ? { pinSize: patch.size } : {}) }
      : t)));
  }, [setTiles]);

  // A pinned panel lives in SCREEN pixels, so it is the one thing on the canvas
  // that a window resize can strand: shrink the window (or unmaximise, or unplug
  // a monitor) and a pin anchored near the old right/bottom edge is simply gone —
  // permanently, because the anchor is persisted. clampAnchor already runs when a
  // tile is pinned and when it's dragged; nothing was re-running it when the
  // WINDOW changed instead of the panel. Re-clamp every pin on resize, and write
  // back only when something actually moved so we don't churn state (and the
  // persisted layout) on every resize frame.
  useEffect(() => {
    const reclamp = () => {
      const win = { w: window.innerWidth, h: window.innerHeight };
      setTiles((ts) => {
        let moved = false;
        const next = ts.map((t) => {
          if (!t.pinned || !t.pinAnchor) return t;
          const size = t.pinSize ?? { w: 380, h: 260 };
          const c = clampAnchor(t.pinAnchor, size, win);
          if (c.sx === t.pinAnchor.sx && c.sy === t.pinAnchor.sy) return t;
          moved = true;
          return { ...t, pinAnchor: c };
        });
        return moved ? next : ts;
      });
    };
    reclamp(); // also rescues pins already stranded by a resize while closed
    window.addEventListener("resize", reclamp);
    return () => window.removeEventListener("resize", reclamp);
  }, [setTiles]);

  // baseNodes: built WITHOUT selectedTileId. Heavy: rebuilds whenever any
  // layout / extras / frames / pile / size / position state changes. The
  // selection-derived `nodes` below shallow-clones only the selected and
  // previously-selected nodes — so a click-to-select doesn't trigger a full
  // rebuild + data-ref churn that would defeat React.memo on heavy wrappers.
  // Heavy node-array build (frames + tiles). Pure — see canvas-node-build.ts.
  // Rebuilds on any layout/frame/size/position change; the selection-derived
  // `nodes` memo below clones only the selected node so a click doesn't churn.
  const baseNodes: Node[] = useMemo(() => buildBaseNodes({
    repoPath, root, cwd, tiles, frames, frameOf, pinnedIds, sizes, positions, editorTabs, browserOpenReqs,
    tileNames, agentTitles, frameTiles, framesChipNames,
    updateFrameTitle, updateFrameColor, deleteFrame, arrangeFrame, bringFrameToFront,
    onAttachWorktree, onCreateWorktree, unbindBranch, bindWorkspace, unbindWorkspace,
    openFileInTile, openUrlInBrowser, openFileFromTerminal, closeTabInTile, closeTile, onSetFolder, onNodeResizeCommit, renameTile, setAgentTitle,
    editCmdButton, editTrigger, runTrigger, triggerRuns,
    onTogglePin: togglePin, onPinChange,
  }), [
    repoPath, root, cwd, tiles, editorTabs, browserOpenReqs, frames, frameOf, pinnedIds, sizes, positions,
    openFileInTile, openUrlInBrowser, openFileFromTerminal, closeTabInTile, closeTile, onSetFolder, updateFrameTitle, updateFrameColor,
    deleteFrame, arrangeFrame, bringFrameToFront, onAttachWorktree, onCreateWorktree,
    unbindBranch, onNodeResizeCommit, frameTiles, tileNames, bindWorkspace,
    // agentTitles intentionally NOT a dep: a live title change must not rebuild
    // the react-flow node array (cursor-flicker + focus loss while streaming).
    unbindWorkspace, renameTile, framesChipNames, setAgentTitle, togglePin, onPinChange, editCmdButton,
    editTrigger, runTrigger, triggerRuns,
  ]);
  // Derive selection-aware nodes from baseNodes. Shallow-clones ONLY the
  // currently-selected and previously-selected tile so other nodes keep their
  // object identity → React.memo skips them. Frames keep their own z stacking.
  const nodes: Node[] = useMemo(() => {
    // No selection (the common case): baseNodes already carries every node's
    // zIndex (tiles 100 via mkTile, frames their own), so return it VERBATIM —
    // same array + node refs, zero allocation, no memo break. Pinned tiles need
    // NO special node treatment here: their content is portaled out to the fixed
    // pinned layer by the node wrapper, so the in-canvas node is just an inert,
    // empty bookkeeping node at its normal position.
    if (!selectedTileId) return baseNodes;
    // Clone ONLY the selected node; every other node keeps its identity so
    // React.memo skips it. Frames keep their own z stacking.
    return baseNodes.map((n) => {
      if (n.type === "frame" || n.id !== selectedTileId) return n;
      return { ...n, selected: true, style: { ...(n.style ?? {}), zIndex: 1000 } };
    });
  }, [baseNodes, selectedTileId]);
  // Agent pipes (hive_connect) → animated "data flow" edges. Main pushes
  // connect/disconnect over "hcp:pipe"; we draw an edge per pipe whose endpoints
  // both still exist as tiles (a closed tile's edge silently drops).
  const edges = useMemo<Edge[]>(() => {
    if (pipes.length === 0 && spawnLinks.length === 0 && workflowEdges.length === 0) return EMPTY_EDGES;
    const ids = new Set(tiles.map((t) => t.id));
    const kindOf = new Map(tiles.map((t) => [t.id, t.kind]));
    // Spawn wires (dashed parentage, parent → child) sit UNDER the animated data
    // pipes. A pipe between the same pair visually wins (higher zIndex).
    const spawnEdges: Edge[] = spawnLinks
      .filter((l) => ids.has(l.parent) && ids.has(l.child))
      .map((l) => ({ id: `spawn-${l.parent}-${l.child}`, source: l.parent, target: l.child, type: "spawn", zIndex: 1900 }));
    const pipeEdges: Edge[] = pipes
      .filter((p) => ids.has(p.src) && ids.has(p.dst))
      .map((p) => ({ id: `flow-${p.src}-${p.dst}`, source: p.src, target: p.dst, type: "dataflow", zIndex: 2000 }));
    // User-authored workflow edges — Handle-anchored (see canvas-workflow-edge.tsx),
    // drawn UNDER the live HCP pipes so an executing step's animated dataflow
    // pipe (if the two also happen to be piped) doesn't get visually buried.
    const workflowRenderEdges: Edge[] = workflowEdges
      .filter((e) => ids.has(e.source) && ids.has(e.target))
      .map((e) => {
        // An edge into a cmdButton has no prompt concept — it's never "missing
        // a prompt", it just triggers a run.
        const promptless = kindOf.get(e.target) === "cmdButton";
        const hasPrompt = promptless || !!e.prompt?.trim();
        const active = activeWorkflowStep?.activeEdgeId === e.id;
        // Directional arrowhead, color-matched to the line (same rule
        // WorkflowEdgeComponent uses for its stroke) so the edge always shows
        // WHICH WAY the step flows, not just that a connection exists.
        const color = active ? "var(--color-brand)" : hasPrompt ? "var(--color-fg2)" : "var(--color-err)";
        return {
          id: e.id, source: e.source, target: e.target, type: "workflow", zIndex: 1800,
          data: { active, hasPrompt },
          markerEnd: { type: MarkerType.ArrowClosed, width: 18, height: 18, color },
        };
      });
    return [...workflowRenderEdges, ...spawnEdges, ...pipeEdges];
  }, [pipes, spawnLinks, tiles, workflowEdges, activeWorkflowStep]);

  // MiniMap is opt-in — its `pannable zoomable` re-renders every node mini-rect
  // on every pan/zoom frame, a real cost with several live tiles. Off by default.
  const [minimapOn, setMinimapOn] = useState(false);
  const showMinimap = minimapOn && nodes.length > 0;
  // Zen mode — hide ALL canvas chrome (tool island, zoom island, minimap, Layers
  // panel) for a clean full-canvas view. The eye toggle stays so you can restore.
  const [zen, setZen] = useState<boolean>(() => localStorage.getItem("hivemind:zen") === "1");
  useEffect(() => { localStorage.setItem("hivemind:zen", zen ? "1" : "0"); }, [zen]);
  // Appearance customizer (glass / wallpaper / accent). Theme is a global app
  // pref persisted by theme-store; push it into the DOM once on mount.
  const [customizerOpen, setCustomizerOpen] = useState(false);
  useEffect(() => { applyTheme(); }, []);

  const isEmpty = nodes.length === 0;

  // Motion-aware compositing: while the viewport pans/zooms we add a class that
  // (a) kills tile pointer-events (no hit-test churn) and (b) clips each tile's
  // paint via `contain` so the browser composites fewer/cheaper layers. Restored
  // shortly after motion stops. This is hivemind's take on Nyx's "GPU promotion
  // during motion". See styles.css `.canvas-moving`.
  const flowWrapRef = useRef<HTMLDivElement>(null);
  const moveEndTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  // Pan momentum: react-flow's pan stops DEAD on release, which reads as
  // "lifeless." Sample the viewport during a pan, and on release fling it with
  // velocity decay (like a slippy map). `inMomentumRef` guards our own
  // programmatic setViewport calls from re-feeding the sampler.
  const panSamplesRef = useRef<{ t: number; x: number; y: number }[]>([]);
  const inMomentumRef = useRef(false);
  const momentumNonce = useRef(0);
  const [momentumReq, setMomentumReq] = useState<{ vx: number; vy: number; n: number } | null>(null);
  // Bumped to snap the LIVE viewport crisp (ViewportSnap child applies it): on
  // pan/zoom settle, on fling settle, and on tile select — the moments a tile is
  // promoted to its own layer and a fractional transform would blur it.
  const [snapReq, setSnapReq] = useState(0);
  const bumpSnap = useCallback(() => setSnapReq((n) => n + 1), []);
  const onMove = useCallback((_: unknown, vp: { x: number; y: number; zoom: number }) => {
    currentViewportRef.current = vp;
    if (inMomentumRef.current) return; // ignore self-generated moves
    const s = panSamplesRef.current;
    s.push({ t: performance.now(), x: vp.x, y: vp.y });
    if (s.length > 6) s.shift();
  }, []);
  const onMoveStart = useCallback(() => {
    // Ignore move-starts emitted by our OWN momentum setViewport calls — only a
    // real user grab should re-add the motion class + cancel the fling.
    if (inMomentumRef.current) return;
    if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
    setMomentumReq(null); // cancel any in-flight fling when the user grabs again
    panSamplesRef.current = [];
    flowWrapRef.current?.classList.add("canvas-moving");
  }, []);
  const onMoveEnd = useCallback(() => {
    if (moveEndTimer.current) clearTimeout(moveEndTimer.current);
    moveEndTimer.current = setTimeout(() => {
      flowWrapRef.current?.classList.remove("canvas-moving");
    }, 120);
    if (inMomentumRef.current) return;
    // Velocity (px/ms) from the last two recent samples; fling only on a real flick.
    const s = panSamplesRef.current;
    let flung = false;
    if (s.length >= 2) {
      const a = s[s.length - 2]!;
      const b = s[s.length - 1]!;
      const dt = b.t - a.t;
      if (dt > 0 && dt < 80) {
        const vx = (b.x - a.x) / dt;
        const vy = (b.y - a.y) / dt;
        if (Math.abs(vx) > 0.15 || Math.abs(vy) > 0.15) {
          setMomentumReq({ vx, vy, n: ++momentumNonce.current });
          flung = true;
        }
      }
    }
    panSamplesRef.current = [];
    // Commit the post-pan viewport to state so the layout-save effect persists
    // it. Triggers ONE re-render at the end of the pan (not per pointermove).
    // When the canvas comes to REST (no fling), snap it crisp: xterm rasterizes
    // its glyphs to a canvas that the react-flow viewport then CSS-transforms, so
    // a fractional translate or an off-by-epsilon zoom lands that bitmap on
    // sub-pixels → fuzzy text. Rounding the pan to the device-pixel grid and
    // snapping a near-1 zoom to exactly 1 makes text sharp whenever it's at rest
    // around 100%. (Other zoom levels still scale the bitmap — inherent.)
    const committed = flung ? currentViewportRef.current : snapViewportCrisp(currentViewportRef.current);
    currentViewportRef.current = committed;
    setViewport(committed);
    if (!flung) bumpSnap(); // snap the LIVE transform too (a fling snaps on settle)
  }, [bumpSnap]);
  // Dragging a TILE is a node drag (not a viewport move) so onMoveStart never
  // fires for it — that's why drag still felt laggy. Use a SEPARATE class with
  // compositing hints only (NOT pointer-events:none, which would drop the drag
  // gesture mid-move).
  const onNodeDragStart = useCallback((_e: unknown, node: Node) => {
    draggingIdRef.current = node.id;
    flowWrapRef.current?.classList.add("canvas-dragging");
  }, []);
  // Remove SYNCHRONOUSLY on drop — must run BEFORE commitPosition's setPositions
  // flushes, so the `.react-flow__node` transition is active when xyflow re-syncs
  // the node's transform to the snapped target. Otherwise the snap lands instant
  // and the user never sees the "moment". (Tracked permanent fix: research lap on
  // tldraw + Framer Motion drop-land patterns.)
  const clearDragging = useCallback(() => {
    flowWrapRef.current?.classList.remove("canvas-dragging");
  }, []);
  // NodeResizer sets body.canvas-resizing on resize start; clear it when the
  // pointer is released (resize ends on pointerup, anywhere).
  useEffect(() => {
    const clear = () => document.body.classList.remove("canvas-resizing");
    document.addEventListener("pointerup", clear);
    return () => document.removeEventListener("pointerup", clear);
  }, []);

  // Compositor layer pre-promotion. MDN's "via script" pattern: set
  // `will-change: transform` on pointerdown, clear on pointerup. Pointerdown
  // beats xyflow's dragstart by ~50-150ms (human reaction + threshold check),
  // which is plenty of head-start for Blink to upload the layer. Only the
  // grabbed tile gets promoted — no layer explosion. CSS `:hover` would have
  // promoted every tile under the cursor and every frame the pointer crossed
  // (MDN: "Don't apply will-change to too many elements").
  // https://developer.mozilla.org/en-US/docs/Web/CSS/will-change#via_a_script
  // Layer pre-promotion via MDN "via_a_script" pattern. On pointerdown over a
  // heavy tile's drag handle, set `will-change: transform` so Blink uploads the
  // layer to the GPU BEFORE xyflow's drag-threshold trips. Cleared on
  // pointerup/cancel. Only ONE element promoted at a time — no layer explosion.
  // Frames are excluded (huge surface, would defeat the optimization).
  // https://developer.mozilla.org/en-US/docs/Web/CSS/will-change#via_a_script
  // Compositor layer pre-promotion via MDN "via_a_script" pattern. On
  // pointerdown over a heavy tile's drag handle, set `will-change: transform`
  // so Blink uploads the layer to the GPU BEFORE xyflow's drag-threshold trips.
  // Cleared on pointerup/cancel. Only ONE element promoted at a time — no
  // layer explosion. Frames excluded (huge surface).
  // https://developer.mozilla.org/en-US/docs/Web/CSS/will-change#via_a_script
  useEffect(() => {
    const wrap = flowWrapRef.current;
    if (!wrap) return;
    let promoted: HTMLElement | null = null;
    const onDown = (e: PointerEvent) => {
      const handle = (e.target as HTMLElement | null)?.closest(".tile-drag-handle");
      if (!handle) return;
      const node = handle.closest(
        ".react-flow__node-terminal, .react-flow__node-diff, .react-flow__node-workbench, .react-flow__node-editor, .react-flow__node-issues",
      ) as HTMLElement | null;
      if (!node) return;
      promoted = node;
      node.style.willChange = "transform";
    };
    const onUp = () => {
      if (promoted) {
        promoted.style.willChange = "";
        promoted = null;
      }
    };
    wrap.addEventListener("pointerdown", onDown, { passive: true });
    document.addEventListener("pointerup", onUp, { passive: true });
    document.addEventListener("pointercancel", onUp, { passive: true });
    return () => {
      wrap.removeEventListener("pointerdown", onDown);
      document.removeEventListener("pointerup", onUp);
      document.removeEventListener("pointercancel", onUp);
    };
  }, []);

  // ── auto-pan to newly-spawned tiles ───────────────────────────────────────
  // (focusReq / focusTile are declared earlier so addFrame can pan to a new
  // frame.) When a tile is added we fly the viewport to it.
  // New claude/extra terminals: focus the most-recently-added one. Initialised
  // from the restored length so reopening the app doesn't pan to old tiles.
  // Only pan when OTHER tiles already exist (nodes.length > 1 after the add) —
  // the new tile is then appended off to the side and would otherwise land
  // off-screen. The first tile on an empty canvas is already framed by the
  // default viewport, so panning to it is both pointless and jarring.
  const prevExtrasLen = useRef(tiles.length);
  useEffect(() => {
    if (tiles.length > prevExtrasLen.current) {
      const last = tiles[tiles.length - 1];
      // Pan to the newly-spawned tile. FALLBACK ONLY: framed spawns are already
      // selected+focused by placeInFrame (the single authority); fire here only
      // for a LOOSE tile (no frameOf entry) so we don't double-animate.
      if (last && !frameOfRef.current[last.id]) {
        setSelectedTileId(last.id);
        focusTile(last.id);
      }
    }
    prevExtrasLen.current = tiles.length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tiles, focusTile]);

  // herdr-style agent awareness: status → in-app toast + OS notification, with
  // done-unseen tracking + selection-based suppression. See useAgentAwareness.
  const { toasts, dismissToast, markSeen, selectedTileIdsRef } = useAgentAwareness({
    pushToastRef, frameOfRef, framesRef,
  });

  const handleNodeDragStop = useNodeDragStop({
    framesRef, frameOfRef, sizesRef, tilesRef, lastActiveFrameRef,
    setPositions, setFrames, setFrameOf, parentFrameOf, moveFrame, commitPosition, clearDragging,
  });
  // Wrap drag-stop: commit the drop, then clear the drag guard. Pinned tiles have
  // no draggable in-canvas footprint (their content is portaled to the fixed
  // layer), so there's nothing pin-specific to reconcile here.
  const onNodeDragStopWithPin = useCallback((e: unknown, node: Node) => {
    handleNodeDragStop(e, node);
    draggingIdRef.current = null;
  }, [handleNodeDragStop]);
  return (
    <PinnedLayerContext.Provider value={pinnedLayer}>
    <div className="relative h-full w-full flex flex-col">
      {/* Screen-fixed layer pinned tiles portal their floating panels into. Fixed
          full-window + pointer-events:none so it never blocks the canvas or the
          tool-island Panels; each floating panel re-enables pointer-events on
          itself. Sits above tiles (z ~55) yet below modal overlays. Because it's
          OUTSIDE react-flow's transformed viewport, its content is inherently
          screen-fixed + constant-size — unaffected by pan/zoom. */}
      <div
        id="hm-pinned-layer"
        ref={setPinnedLayer}
        className="fixed inset-0 pointer-events-none"
        style={{ zIndex: 50 }}
      />
      {/* Live wallpaper — fixed full-window layer behind ALL app content (z-index
          -1), so it shows through the canvas pane AND the panels beside it. */}
      <Wallpaper />
      {/* Custom OVERLAY media — user's transparent foreground plane OVER the
          tiles. Fixed full-window + pointer-events:none, so it never blocks
          canvas interaction. Renders nothing until the user picks a file. */}
      <CanvasOverlay />
      {/* t3code-style DOCKED layout: the Layers panel is a flex SIBLING of the
          canvas (not an overlay), so the canvas sits BESIDE it and is never
          occluded. Collapses to a narrow icon rail; both keep the canvas clear. */}
      {viewMode === "windows" ? (
        <WindowsView
          nodes={baseNodes}
          frames={layerFrames}
          tiles={layerTiles}
          tabTiles={tabTiles}
          activeTabId={activeTabId}
          selectedTileId={selectedTileId}
          onSelectTab={selectTab}
          onMinimizeTab={minimizeTab}
          onCloseTab={closeTile}
          onFocusTile={restoreTab}
          onFocusFrame={focusFrameFromPanel}
          frameActions={frameActions}
        />
      ) : (
      <div className="flex-1 min-h-0 flex flex-row">
        {!zen && layerTiles.length > 0 && (
          <LayersPanel
            frames={layerFrames}
            tiles={layerTiles}
            selectedTileId={selectedTileId}
            onFocusTile={focusTileFromPanel}
            onFocusFrame={focusFrameFromPanel}
            frameActions={frameActions}
          />
        )}
        {/* Suppress the native context menu inside the canvas so RIGHT-mouse drag
            pans (panOnDrag=[1,2]) instead of popping a menu that aborts the drag.
            On the empty pane / a frame body it opens the spawn menu instead. */}
        <div ref={flowWrapRef} className="relative flex-1 min-h-0" onContextMenu={onCanvasContextMenu}>
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={ALL_EDGE_TYPES}
          onConnect={onWorkflowConnect}
          onEdgeDoubleClick={onWorkflowEdgeDoubleClick}
          defaultViewport={initial.viewport ?? DEFAULT_VIEWPORT}
          minZoom={0.25}
          maxZoom={2.5}
          panOnScroll
          // Excalidraw/Figma model: hold Space to pan with left-drag; plain
          // left-drag does rubber-band selection.
          panActivationKeyCode="Space"
          selectionOnDrag
          panOnDrag={PAN_ON_DRAG}
          zoomOnPinch
          // Both default to 0 → a 1px pointer wobble during a click is read as a
          // drag and the click is swallowed (feels unresponsive). A few px of
          // slack makes clicks land reliably + a tiny jitter doesn't micro-drag.
          paneClickDistance={4}
          nodeClickDistance={4}
          deleteKeyCode={null}
          onMove={onMove}
          onMoveStart={onMoveStart}
          onMoveEnd={onMoveEnd}
          onNodeDragStart={onNodeDragStart}
          // Tiles are HUGE (1200×820 by default) — bigger than typical window.
          // xyflow's default autoPanOnNodeDrag pans the viewport when the
          // DRAGGED NODE's edges approach the viewport edges. With a tile
          // already extending past the window edges, ANY drag triggers
          // continuous auto-pan → tile's screen position barely changes while
          // its internal canvas position moves correctly. Disable so drag is
          // a pure node move; user can pan separately via Space+drag.
          autoPanOnNodeDrag={false}
          // Manual selection (react-flow's click-select is dead in our config).
          // Clicking a tile selects it → highlight + handles + front. Clicking a
          // frame or the empty pane clears tile selection.
          onNodeClick={(_e, node) => {
            if (node.type === "frame") {
              setSelectedTileId(null);
            } else {
              // Re-frame only when selecting a DIFFERENT tile — re-clicking the
              // already-selected tile (e.g. to type) must NOT yank the viewport.
              const isNewSelection = !selectedTileIdsRef.current.has(node.id);
              setSelectedTileId(node.id);
              selectedTileIdsRef.current = new Set([node.id]);
              markSeen([node.id]);
              // Selecting promotes the tile to its own compositing layer; snap
              // the viewport so that layer lands on whole pixels (sharp, not
              // blurry). See ViewportSnap.
              bumpSnap();
              if (isNewSelection) {
                // Terminals, diff (Pierre) and editor (CodeMirror) all need
                // EXACTLY 100% zoom when focused. xterm maps the mouse to a cell
                // using the UNSCALED cell size, so a drag-selection at any zoom ≠ 1
                // lands on the wrong row — it highlights BELOW the cursor at
                // zoom > 1. diff/editor render DOM text the browser only rasterizes
                // crisply at 1:1, and the terminal's focus DOM-renderer boost is
                // likewise only pixel-perfect at 1:1. So snap all of them to 100%.
                // (An earlier change fit-to-tiled terminals at zoom ≤ 1 on the
                // now-removed premise that a DPR supersample kept them crisp at any
                // zoom — that broke text selection.)
                if (
                  node.type === "terminal" ||
                  node.type === "diff" ||
                  node.type === "editor" ||
                  node.type === "workbench"
                ) {
                  // Snap to 100% AND frame the tile in one move. The old path only
                  // zoomed to 1 around the VIEWPORT centre — if the tile wasn't
                  // already centred it grew off-screen (the left columns/prompt
                  // clipped). exact focus recentres on the tile (anchoring the
                  // content corner when it's bigger than the viewport).
                  focusTile(node.id, { exact: true });
                }
              }
            }
          }}
          onPaneClick={() => {
            setSelectedTileId(null);
            selectedTileIdsRef.current = new Set();
          }}
          onSelectionChange={({ nodes: sel }) => {
            // Track which frame (if any) is the user's current single
            // selection. Drives F2-rename + future bulk frame ops. We only
            // care about single-frame selection; multi-select clears.
            if (sel.length === 1 && sel[0]!.type === "frame") {
              setSelectedFrameId(sel[0]!.id);
            } else {
              setSelectedFrameId(null);
            }
            // Track selected tiles for agent-awareness: selecting a tile counts
            // as "seeing" it, so a done-unseen tile clears + its toast dismisses.
            const tileIds = sel.filter((n) => n.type !== "frame").map((n) => n.id);
            selectedTileIdsRef.current = new Set(tileIds);
            markSeen(tileIds);
          }}
          onNodeDragStop={onNodeDragStopWithPin}
          // NEVER cull off-viewport tiles. Our tiles wrap LIVE PTY sessions
          // (claude/shell): react-flow unmounts a culled node, which tears the
          // tile's PTY down — detach+reattach (banner + full xterm/WebGL rebuild
          // + replay, reads as "the session restarted") in daemon mode, or an
          // outright kill+respawn (a genuinely NEW claude session) in the
          // in-process/non-persistent path. Spawning a new tile recenters the
          // viewport onto it, which pushed existing claude tiles off-screen →
          // they got culled → existing sessions were disturbed/recreated. So we
          // keep every node mounted; xterm's WebGL addon already falls back to
          // the DOM renderer if the GPU context cap is hit on huge boards.
          onlyRenderVisibleElements={false}
          // Perf: skip focus rings + ARIA per tile (we manage focus inside
          // tiles ourselves via xterm/Pierre).
          nodesFocusable={false}
          edgesFocusable={false}
          proOptions={PRO_OPTIONS}
        >
          <Background variant={BackgroundVariant.Dots} gap={22} size={1.5} color="rgba(155,161,173,0.10)" />
          <FocusOnTile req={focusReq} />
          <FocusMode req={focusModeReq} />
          <PanMomentum req={momentumReq} activeRef={inMomentumRef} onSettle={bumpSnap} />
          <ViewportSnap req={snapReq} activeRef={inMomentumRef} />

          {/* Excalidraw-style floating tool island — top-center. Hidden in zen. */}
          {!zen && (
          <Panel position="top-center" className="!m-0 !mt-3">
            <ToolIsland
              repoPath={repoPath}
              onToggle={(k) => spawnVis(k)}
              agentSel={agentSel}
              onAgentChange={setAgentSel}
              onSpawnAgent={(a) => spawnAgent(a)}
              onFrame={addFrame}
              onBrowser={() => spawnInto("browser")}
              onCmdButton={createCmdButton}
              onTheme={() => setCustomizerOpen((o) => !o)}
              updateAvailable={updateAvailable}
              onUpgrade={() => onUpgrade?.()}
              upgrading={upgrading}
            />
          </Panel>
          )}

          {/* Roster removed — the top-left WorkspaceSwitcher (App) is the
              single workspace UI. Click a frame on the canvas to set active. */}

          {/* Live agent sessions now live in the Figma-style LayersPanel
              (bottom-left rail). The old top-left SessionChips strip was
              redundant with it and has been removed. */}

          {/* Background-event toasts — BOTTOM-right. (Was top-right, where it
              collided with + hid behind the Board/List/Canvas view switcher.)
              Bottom-right is clear: tool island is top-center, chips top-left,
              zoom bottom-left. An agent that goes blocked or finishes while
              off-screen pings here; click to fly to it. */}
          {toasts.length > 0 && (
            <Panel position="bottom-right" className="!m-0 !mr-3 !mb-3">
              <Toasts toasts={toasts} onDismiss={dismissToast} onView={(id) => markSeen([id])} />
            </Panel>
          )}

          {/* Zoom + nav island — bottom-left (Excalidraw footer). The EYE toggle
              is always visible (it restores zen); the zoom island hides in zen. */}
          <Panel position="bottom-left" className="!m-0 !ml-3 !mb-3">
            <div className="flex items-center gap-2 pointer-events-auto">
              <button
                onClick={() => setZen((z) => !z)}
                className="hm-island size-8 grid place-items-center rounded-lg text-[var(--color-fg2)] hover:text-[var(--color-fg)]"
                title={zen ? "Show UI" : "Hide UI (zen mode)"}
                aria-label={zen ? "show UI" : "hide UI"}
              >
                {zen ? <EyeOff size={15} /> : <Eye size={15} />}
              </button>
              {!zen && (
                <ZoomIsland
                  tileCount={nodes.length}
                  minimapOn={minimapOn}
                  onToggleMinimap={() => setMinimapOn((v) => !v)}
                  onReset={() => setConfirmClear(true)}
                  onFocus={() => {
                    const id = selectedTileIdRef.current ?? selectedFrameIdRef.current;
                    setFocusModeReq({ id, n: ++focusModeNonceRef.current });
                  }}
                />
              )}
            </div>
          </Panel>

          {showMinimap && !zen && (
            <MiniMap
              pannable
              zoomable
              className="!bg-[var(--color-bg3)] !border !border-[var(--color-line2)] !rounded-lg"
              maskColor="rgba(0,0,0,0.55)"
              nodeColor="var(--color-line2)"
            />
          )}

          {spawnPick && (
            <Panel position="top-center" className="!m-0 !mt-16">
              <div className="hm-island rounded-xl p-1.5 min-w-[240px] pointer-events-auto">
                <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)]">
                  Spawn claude in
                </div>
                {/* Order each repo frame followed by its worktree children, so
                    the picker reads as a tree (children indented + tagged). */}
                {frames
                  .filter((f) => !f.parentFrameId)
                  .flatMap((p) => [p, ...frames.filter((c) => c.parentFrameId === p.id)])
                  .map((f) => {
                    const isSel = f.id === selectedFrameId;
                    const isWt = !!f.parentFrameId;
                    return (
                      <button
                        key={f.id}
                        autoFocus={isSel}
                        onClick={() => { spawnTile(spawnPick.kind, f.id, { mode: spawnPick.mode, work: spawnPick.work, url: spawnPick.url, agent: spawnPick.agent }); setSpawnPick(null); }}
                        className={`w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-[var(--color-fg)] hover:bg-[var(--color-bg3)] transition-colors ${
                          isSel ? "bg-[var(--color-bg3)] ring-1 ring-[var(--color-select)]" : ""
                        }`}
                        style={isWt ? { paddingLeft: 20 } : undefined}
                      >
                        <span aria-hidden className="size-2 rounded-full shrink-0" style={{ background: f.color }} />
                        <span className="truncate">{f.title}</span>
                        <span className="ml-auto text-[10px] text-[var(--color-fg3)]">
                          {isSel ? "selected" : isWt ? "worktree" : "workspace"}
                        </span>
                      </button>
                    );
                  })}
                <button
                  onClick={() => setSpawnPick(null)}
                  className="w-full text-left px-2 py-1 mt-0.5 rounded-md text-[11px] text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] transition-colors"
                >
                  cancel
                </button>
              </div>
            </Panel>
          )}
        </ReactFlow>
        {isEmpty && (
          <CanvasEmptyState
            repoPath={repoPath}
            onShowTree={() => spawnVis("tree")}
            onShowShell={() => spawnVis("shell")}
            onShowDiff={() => spawnVis("diff")}
            onSpawnClaude={() => spawnClaude()}
            onInitWorkspace={onInitWorkspace}
            onOpenFolder={onOpenFolder}
            onCreateProject={onCreateProject}
          />
        )}
        <RemoteConnectModal
          open={remoteAttach !== null}
          onClose={() => setRemoteAttach(null)}
          onPick={(uri) => { if (remoteAttach) bindRemote(remoteAttach, uri); setRemoteAttach(null); }}
        />
        <SyncSettingsModal root={syncSettingsRoot} onClose={() => setSyncSettingsRoot(null)} />
        <ThemeCustomizer open={customizerOpen} onClose={() => setCustomizerOpen(false)} />
        {cmdModal && (() => {
          const inst = tiles.find((t) => t.id === cmdModal.tileId);
          const initial = cmdModal.mode === "edit" && inst?.cmdButton
            ? { name: tileNames[inst.id] ?? inst.label, script: inst.cmdButton.script, cwd: inst.cmdButton.cwd }
            : undefined;
          // The cwd the button would inherit from its frame/workspace (shown as
          // the placeholder for the optional override field).
          const owningFrame = frames.find((f) => f.id === frameOf[cmdModal.tileId]);
          const defaultCwd = owningFrame?.worktreePath ?? owningFrame?.workspacePath ?? repoPath ?? cwd ?? null;
          return (
            <CommandButtonModal
              open
              onOpenChange={(o) => { if (!o) cancelCmdButton(); }}
              initial={initial}
              defaultCwd={defaultCwd}
              onSubmit={submitCmdButton}
            />
          );
        })()}
        {triggerModal && (() => {
          const inst = tiles.find((t) => t.id === triggerModal.tileId);
          const initial = triggerModal.mode === "edit" && inst?.trigger
            ? { name: tileNames[inst.id] ?? inst.label, mode: inst.trigger.mode, everyMs: inst.trigger.everyMs }
            : undefined;
          return (
            <TriggerConfigModal
              open
              onOpenChange={(o) => { if (!o) cancelTrigger(); }}
              initial={initial}
              onSubmit={submitTrigger}
            />
          );
        })()}
        {edgePromptAnchor && (() => {
          const edge = workflowEdges.find((e) => e.id === edgePromptAnchor.edgeId);
          if (!edge) return null;
          const sourceTile = tiles.find((t) => t.id === edge.source);
          const targetTile = tiles.find((t) => t.id === edge.target);
          const promptless = targetTile?.kind === "cmdButton";
          const showIncludePrevReply = sourceTile?.kind !== "trigger";
          return (
            <EdgePromptPopover
              x={edgePromptAnchor.x}
              y={edgePromptAnchor.y}
              initial={{ prompt: edge.prompt ?? "", includePrevReply: edge.includePrevReply ?? true }}
              promptless={promptless}
              showIncludePrevReply={showIncludePrevReply}
              onSave={saveEdgePrompt}
              onDelete={deleteWorkflowEdge}
              onClose={cancelEdgePrompt}
            />
          );
        })()}
        {claudePick && (
          // z above the tile fullscreen overlay (z-[9999]) so the picker shows ON
          // TOP of a fullscreened diff/editor instead of behind it.
          <div className="fixed inset-0 z-[10000] grid place-items-center" onClick={() => setClaudePick(null)}>
            <div className="absolute inset-0 bg-black/40" />
            <div className="relative w-[340px] max-w-[90vw] rounded-xl border border-[var(--color-line)] bg-[var(--color-bg2)] shadow-2xl p-1.5" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center px-2 py-1.5">
                <span className="text-[10px] font-semibold uppercase tracking-[0.12em] text-[var(--color-fg3)]">
                  Send to claude
                </span>
                <button
                  onClick={() => setClaudePick(null)}
                  className="ml-auto size-4 grid place-items-center rounded text-[var(--color-fg3)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] transition-colors text-[12px] leading-none"
                  aria-label="cancel"
                  title="cancel (Esc)"
                >
                  ×
                </button>
              </div>
              {tiles.filter((t) => t.kind === "claude").map((t) => {
                const name = tileNames[t.id] ?? agentTitles[t.id] ?? t.label;
                const frame = frames.find((f) => f.id === frameOf[t.id]);
                return (
                  <button
                    key={t.id}
                    onClick={() => { deliverToClaude(claudePick.text, t.id); setClaudePick(null); }}
                    className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left text-[var(--color-fg2)] hover:bg-[var(--color-bg4)] hover:text-[var(--color-fg)] cursor-pointer"
                  >
                    <AgentIcon id="claude" size={13} className="shrink-0 text-[var(--color-fg3)]" />
                    <span className="truncate flex-1">{name}</span>
                    {frame && <span className="shrink-0 text-[10px] text-[var(--color-fg3)]">{frame.title}</span>}
                  </button>
                );
              })}
              <div className="my-1 border-t border-[var(--color-line2)]" />
              <button
                onClick={() => { deliverToClaude(claudePick.text, "new"); setClaudePick(null); }}
                className="w-full flex items-center gap-2 px-2 py-1.5 rounded-md text-[12px] text-left text-[var(--color-fg)] hover:bg-[var(--color-bg4)] cursor-pointer"
              >
                <span className="shrink-0 grid place-items-center size-3.5 text-[var(--color-fg3)]">+</span>
                <span className="flex-1">New claude</span>
              </button>
              <button
                onClick={() => setClaudePick(null)}
                className="w-full text-left px-2 py-1 mt-0.5 rounded-md text-[11px] text-[var(--color-fg3)] hover:bg-[var(--color-bg3)] transition-colors"
              >
                cancel
              </button>
            </div>
          </div>
        )}
      </div>
      </div>
      )}
      {/* Git commit/sync modal — at the Canvas root so it shows in BOTH view
          modes (opened per-frame via hivemind:frame-git). */}
      <GitCommitModal
        repoPath={gitModalRepo}
        open={gitModalRepo !== null}
        onOpenChange={(o) => { if (!o) setGitModalRepo(null); }}
      />
      {/* Single-file tile picker — choose a workspace file, then spawn a `file`
          tile bound to it into the target frame. */}
      <FilePickerModal
        repoPath={filePick?.repoPath ?? null}
        open={filePick !== null}
        onOpenChange={(o) => { if (!o) setFilePick(null); }}
        onPick={(file) => { if (filePick) spawnTile("file", filePick.frameId, { file }); setFilePick(null); }}
      />

      {/* Confirm before wiping the whole canvas (clear-all / reset layout). */}
      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="Clear the canvas?"
        description="This removes every frame and tile from this project's layout. Running agents and terminals are closed. This can't be undone."
        confirmLabel="Clear everything"
        danger
        onConfirm={() => { setSizes({}); setPositions({}); setFrames([]); setTiles([]); setEditorTabs({}); setFrameOf({}); }}
      />

      {/* Right-click spawn menu — opened on the empty pane / a frame body. */}
      {spawnMenu && (
        <CanvasSpawnMenu
          menu={spawnMenu}
          onClose={() => setSpawnMenu(null)}
          onSpawnAgent={menuSpawnAgent}
          onSpawnKind={menuSpawnKind}
          onSpawnFile={menuSpawnFile}
          onSpawnCommand={menuSpawnCommand}
          onSpawnTrigger={menuSpawnTrigger}
        />
      )}
    </div>
    </PinnedLayerContext.Provider>
  );
}

/** Excalidraw-style floating tool island — rounded panel of icon buttons,
 *  each with a single-key hotkey hint. Active tools highlight in brand color. */
// ToolIsland / ZoomIsland / FpsMeter / IslandBtn moved to canvas-islands.tsx

// ChipMeta + statusViz moved to canvas-overlays.tsx

// camera (FocusMode/FocusOnTile/PanMomentum/SelectZoomReset/ViewportSnap/useTileFocus) moved to canvas-camera.tsx

// Toasts + CanvasEmptyState moved to canvas-overlays.tsx
