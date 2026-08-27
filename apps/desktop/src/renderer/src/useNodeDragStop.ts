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
      // N-level nesting: a candidate parent may be ANY frame (nested or not) as
      // long as it isn't the dragged frame itself or one of its OWN descendants
      // (that would create a cycle). Innermost frame under the center wins so a
      // drop into a deeply-nested area picks the deepest legal parent.
      const ccx = nx + old.w / 2, ccy = ny + old.h / 2;
      const inside = (f: FrameState) =>
        ccx >= f.x && ccx <= f.x + f.w && ccy >= f.y && ccy <= f.y + f.h;
      // The dragged frame's whole subtree (itself + all descendants) — both to
      // exclude them as drop targets (no cycle) and to move them as one body.
      const subtree = (() => {
        const kidsOf = new Map<string, string[]>();
        for (const f of framesRef.current) {
          if (!f.parentFrameId) continue;
          (kidsOf.get(f.parentFrameId) ?? kidsOf.set(f.parentFrameId, []).get(f.parentFrameId)!).push(f.id);
        }
        const set = new Set<string>([node.id]);
        const stack = [node.id];
        while (stack.length) {
          const cur = stack.pop()!;
          for (const c of kidsOf.get(cur) ?? []) if (!set.has(c)) { set.add(c); stack.push(c); }
        }
        return set;
      })();
      // Depth of a frame (for innermost-wins), cycle-guarded.
      const depthOf = (f: FrameState): number => {
        let d = 0;
        let cur: FrameState | undefined = f;
        for (let i = 0; i < 64 && cur?.parentFrameId; i++) {
          const p: FrameState | undefined = framesRef.current.find((x) => x.id === cur!.parentFrameId);
          if (!p) break;
          d++; cur = p;
        }
        return d;
      };
      // Topmost-then-deepest eligible parent under the center, excluding the
      // dragged frame's own subtree. Prefer greater depth (innermost), then z.
      const target = [...framesRef.current]
        .filter((f) => !subtree.has(f.id) && inside(f))
        .sort((a, b) => depthOf(b) - depthOf(a) || b.z - a.z)[0];
      // What the parent SHOULD be after this drop: the hit frame, or none.
      const nextParent = target?.id;
      const parentChanged = nextParent !== old.parentFrameId;
      if (dx !== 0 || dy !== 0 || parentChanged) {
        // Everything that moves with this frame: its ENTIRE descendant subtree,
        // plus every member tile of the frame AND its descendants. Shifting
        // member tiles re-lands non-empty frames; shifting frame x/y re-lands
        // empty ones.
        const movedFrames = subtree;
        const descendants = [...subtree].filter((id) => id !== node.id);
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
