/**
 * useNodeDragStop — the react-flow onNodeDragStop handler, lifted from Canvas.
 * Persists a dropped node's final ABSOLUTE position (converting react-flow's
 * parent-relative coords), carries a dragged frame's body (member tiles +
 * worktree child frames), detaches a worktree child dragged out of its parent,
 * and re-derives a tile's explicit frame membership from its drop location.
 */
import { useCallback, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Node } from "@xyflow/react";
import { defaultSizeForKind, defaultTileSize } from "./canvas-sizing";
import type { FrameState, TileInstance } from "./canvas-persistence";

export interface NodeDragStopCtx {
  framesRef: MutableRefObject<FrameState[]>;
  frameOfRef: MutableRefObject<Record<string, string>>;
  sizesRef: MutableRefObject<Record<string, { width: number; height: number }>>;
  tilesRef: MutableRefObject<TileInstance[]>;
  lastActiveFrameRef: MutableRefObject<string | null>;
  setPositions: Dispatch<SetStateAction<Record<string, { x: number; y: number }>>>;
  setFrames: Dispatch<SetStateAction<FrameState[]>>;
  setFrameOf: Dispatch<SetStateAction<Record<string, string>>>;
  parentFrameOf: (cx: number, cy: number) => { parentId: string; fx: number; fy: number } | null;
  moveFrame: (id: string, x: number, y: number) => void;
  commitPosition: (id: string, x: number, y: number) => void;
  clearDragging: () => void;
}

export function useNodeDragStop(ctx: NodeDragStopCtx) {
  const {
    framesRef, frameOfRef, sizesRef, tilesRef, lastActiveFrameRef,
    setPositions, setFrames, setFrameOf, parentFrameOf, moveFrame, commitPosition, clearDragging,
  } = ctx;

  return useCallback((_e: unknown, node: Node) => {
    clearDragging();
    // Persist final position. Frames update their own list. Tiles: react-flow
    // returns position RELATIVE to parentId when parented, but our positions map
    // stores ABSOLUTE so parentFrameOf can detect frame containment on re-render.
    if (node.type === "frame") {
      // Dragging a frame carries its body. Frame geometry is DERIVED from member
      // tiles (+ child frames), so the move persists by translating those —
      // react-flow's live drag is visual only and our positions map is stale.
      const old = framesRef.current.find((f) => f.id === node.id);
      if (!old) { moveFrame(node.id, node.position.x, node.position.y); return; }
      // A child (worktree) frame returns position RELATIVE to its parent.
      const dragParent = node.parentId ? framesRef.current.find((f) => f.id === node.parentId) : undefined;
      let nx = node.position.x;
      let ny = node.position.y;
      if (dragParent) { nx = dragParent.x + node.position.x; ny = dragParent.y + node.position.y; }
      const dx = nx - old.x;
      const dy = ny - old.y;
      // Re-derive this frame's parent from geometry — symmetric to the tile drop
      // path so nesting can be BROKEN *and* RE-ESTABLISHED by dragging:
      //   • drag a top-level frame's center into a repo frame → nest under it.
      //   • drag a child's center out of its parent → detach (top-level).
      //   • drag a child's center straight into a DIFFERENT repo frame → reparent.
      // Depth is capped at 2 (repo → worktree): a candidate parent must itself be
      // top-level, and a frame that already HAS children can't become a child.
      const ccx = nx + old.w / 2, ccy = ny + old.h / 2;
      const hasChildren = framesRef.current.some((f) => f.parentFrameId === node.id);
      const inside = (f: FrameState) =>
        ccx >= f.x && ccx <= f.x + f.w && ccy >= f.y && ccy <= f.y + f.h;
      // Topmost eligible parent under the frame's center (z-desc), excluding
      // itself and any candidate that is already a child (2-level rule).
      const target = hasChildren
        ? undefined
        : [...framesRef.current]
            .filter((f) => f.id !== node.id && !f.parentFrameId && inside(f))
            .sort((a, b) => b.z - a.z)[0];
      // What the parent SHOULD be after this drop: the hit frame, or none.
      const nextParent = target?.id;
      const parentChanged = nextParent !== old.parentFrameId;
      if (dx !== 0 || dy !== 0 || parentChanged) {
        // Everything that moves with this frame: its descendant child frames, plus
        // every member tile of the frame AND its descendants. Shifting member tiles
        // re-lands non-empty frames; shifting frame x/y re-lands empty ones.
        const descendants = framesRef.current
          .filter((f) => f.parentFrameId === node.id)
          .map((f) => f.id);
        const movedFrames = new Set<string>([node.id, ...descendants]);
        const moveIds = Object.keys(frameOfRef.current).filter((tid) =>
          movedFrames.has(frameOfRef.current[tid]!),
        );
        if (moveIds.length > 0) {
          setPositions((prev) => {
            const next = { ...prev };
            for (const tid of moveIds) {
              const p = next[tid];
              if (p) next[tid] = { x: p.x + dx, y: p.y + dy };
            }
            return next;
          });
        }
        lastActiveFrameRef.current = node.id;
        setFrames((fs) =>
          fs.map((f) => {
            if (f.id === node.id) {
              // Only rewrite parentFrameId when it actually changed (nest / detach /
              // reparent); otherwise a plain move must leave nesting untouched.
              if (parentChanged) return { ...f, x: nx, y: ny, parentFrameId: nextParent };
              return { ...f, x: nx, y: ny };
            }
            if (descendants.includes(f.id)) return { ...f, x: f.x + dx, y: f.y + dy };
            return f;
          }),
        );
        return;
      }
      moveFrame(node.id, nx, ny);
      return;
    }
    // xyflow v12.3.6 returns `positionAbsolute: undefined` for parented nodes —
    // only `node.position` (RELATIVE to parent) is populated. Compute absolute.
    const absRaw = (node as { positionAbsolute?: { x: number; y: number } }).positionAbsolute;
    let ax = node.position.x;
    let ay = node.position.y;
    if (absRaw) {
      ax = absRaw.x;
      ay = absRaw.y;
    } else if (node.parentId) {
      const parent = framesRef.current.find((f) => f.id === node.parentId);
      if (parent) {
        ax = parent.x + node.position.x;
        ay = parent.y + node.position.y;
      }
    }
    commitPosition(node.id, ax, ay);
    // Update EXPLICIT membership from the drop location: the tile joins whichever
    // frame contains its CENTER (topmost), or becomes loose if dropped outside.
    // The ONLY place geometry maps to membership — a one-shot user action.
    const dragKind = tilesRef.current.find((t) => t.id === node.id)?.kind;
    const s = sizesRef.current[node.id] ?? (dragKind ? defaultSizeForKind(dragKind) : defaultTileSize(node.id));
    const hit = parentFrameOf(ax + s.width / 2, ay + s.height / 2);
    setFrameOf((m) => {
      const cur = m[node.id];
      const nextId = hit?.parentId;
      if (cur === nextId) return m;
      const copy = { ...m };
      if (nextId) copy[node.id] = nextId;
      else delete copy[node.id];
      return copy;
    });
  }, [
    framesRef, frameOfRef, sizesRef, tilesRef, lastActiveFrameRef,
    setPositions, setFrames, setFrameOf, parentFrameOf, moveFrame, commitPosition, clearDragging,
  ]);
}
