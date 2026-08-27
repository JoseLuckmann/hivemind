/**
 * Pure frame-layout geometry — kept out of Canvas.tsx so it's unit-testable in
 * isolation (no React, no xyflow). Two responsibilities:
 *
 *  1. resolveFrameCollisions — the canvas guarantees frames NEVER overlap. A
 *     frame's geometry is derived from its member tiles' bbox (auto-fit), so
 *     when one frame grows (a tile added/resized) it can expand into a
 *     neighbour. This computes per-frame {dx,dy} nudges that separate every
 *     frame, keeping an anchor (the frame you just touched) fixed so neighbours
 *     yield instead of your focus jumping. The caller applies each delta to the
 *     frame's MEMBER TILES (absolute positions) — auto-fit then re-derives the
 *     frame at the separated spot.
 *
 *  2. nextSlotInFrame — where a newly-spawned tile lands inside a frame. Packs
 *     left-to-right then WRAPS to a new row past a max row width, so a frame
 *     grows downward predictably instead of infinitely rightward.
 *
 *  4. arrangeBoxes — opt-in "tidy" for a frame's contents (tiles + worktree
 *     sub-frames). Free drag stays the default; this snaps the boxes into
 *     Columns / Rows / Grid only when the user asks. Pure: returns new absolute
 *     top-lefts; the caller applies them.
 *
 *  3. computeFrameLayout — the whole-canvas auto-fit, nesting-aware. Derives
 *     every frame's geometry from its member tiles AND (for a repo frame that
 *     owns worktree sub-frames) the bounding box of its child frames, then
 *     separates frames so siblings never overlap — but a child stays nested
 *     inside its parent. Pure: the React effect feeds it member rects and
 *     commits the geometry + member-tile shifts it returns.
 */

export interface LayoutRect {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Gap kept between separated frames (px). */
export const FRAME_GAP = 28;
/** Max width a row of tiles inside a frame reaches before wrapping (px). Sized
 *  to comfortably hold two large (claude) tiles side by side, then wrap. */
export const FRAME_ROW_MAX = 3400;

/** Do two rects overlap, treating a `gap`-wide margin as "touching"? */
function overlaps(a: LayoutRect, b: LayoutRect, gap: number): boolean {
  return (
    a.x < b.x + b.w + gap &&
    b.x < a.x + a.w + gap &&
    a.y < b.y + b.h + gap &&
    b.y < a.y + a.h + gap
  );
}

const cx = (r: LayoutRect) => r.x + r.w / 2;
const cy = (r: LayoutRect) => r.y + r.h / 2;

/**
 * Compute per-frame {dx,dy} so no two frames overlap (with FRAME_GAP between).
 * - `anchorId` (if present + still in the set) never moves; neighbours yield.
 * - Deterministic: frames processed in a stable order; ties break toward +.
 * - Convergent: each pass pushes the mover out of the smaller-penetration axis
 *   by exactly the penetration depth (+gap). Capped iterations guard against a
 *   pathological cascade; residual overlap (rare) is accepted over a hang.
 * Returns a map id -> {dx,dy}; ids with no movement are present with {0,0}.
 */
export function resolveFrameCollisions(
  input: LayoutRect[],
  anchorId?: string | null,
  gap: number = FRAME_GAP,
): Record<string, { dx: number; dy: number }> {
  // Work on copies; stable order so the result is deterministic.
  const order = [...input].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const cur = new Map<string, LayoutRect>(order.map((r) => [r.id, { ...r }]));
  const anchorPresent = !!anchorId && cur.has(anchorId);

  // Bound the work: separation converges in a handful of passes in practice, so
  // the n²-per-pass scan times an n²-iteration cap (O(n⁴)) is needless on a busy
  // board. Keep the quadratic iteration room for tiny sets (cheap + helps tight
  // cascades) but hard-cap it so large boards can't spike the auto-fit effect.
  const maxIter = Math.min(Math.max(8, order.length * order.length * 2), 96);
  for (let iter = 0; iter < maxIter; iter++) {
    let moved = false;
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = cur.get(order[i]!.id)!;
        const b = cur.get(order[j]!.id)!;
        if (!overlaps(a, b, gap)) continue;

        // Penetration depth on each axis (including the gap we want to keep).
        const ox = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x) + gap;
        const oy = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y) + gap;

        // Pick which one moves: never the anchor. If neither is the anchor,
        // move the later (b) — stable + keeps earlier frames put.
        let mover = b;
        let other = a;
        if (anchorPresent) {
          if (b.id === anchorId) { mover = a; other = b; }
          else { mover = b; other = a; }
          // If BOTH are the anchor that's impossible (unique id); fine.
        }

        if (ox <= oy) {
          const dir = cx(mover) >= cx(other) ? 1 : -1;
          mover.x += dir * ox;
        } else {
          const dir = cy(mover) >= cy(other) ? 1 : -1;
          mover.y += dir * oy;
        }
        moved = true;
      }
    }
    if (!moved) break;
  }

  const out: Record<string, { dx: number; dy: number }> = {};
  for (const r of input) {
    const c = cur.get(r.id)!;
    out[r.id] = { dx: Math.round(c.x - r.x), dy: Math.round(c.y - r.y) };
  }
  return out;
}

/**
 * Separate a group of SIBLING frames (worktree children of one repo frame),
 * returning per-frame {dx,dy}. Two strategies:
 *
 *  - ≤2 frames, or already non-overlapping: fall back to
 *    `resolveFrameCollisions` — a minimal nudge that keeps the anchor put and
 *    barely moves a neighbour. This preserves free-drag placement.
 *
 *  - 3+ OVERLAPPING frames: pairwise nudging picks the smaller-penetration axis
 *    per collision, which for a row of grown frames scatters them into a diagonal
 *    stagger (one wraps down, the next stays right, …) — the "nested layers get
 *    lost / dispersed" bug. Instead reflow them into a stable left→right row
 *    that wraps past FRAME_ROW_MAX, in READING ORDER of their current top-lefts,
 *    anchored at the group's top-left. The anchor keeps its slot (the reflow
 *    origin is the anchor's current corner when present) so the frame you just
 *    touched doesn't jump.
 *
 * Pure — returns deltas; the caller applies them (to member tiles).
 */
function separateSiblingFrames(
  rects: LayoutRect[],
  anchorId: string | null | undefined,
  gap: number,
): Record<string, { dx: number; dy: number }> {
  const anyOverlap = (() => {
    for (let i = 0; i < rects.length; i++)
      for (let j = i + 1; j < rects.length; j++)
        if (overlaps(rects[i]!, rects[j]!, gap)) return true;
    return false;
  })();
  // ≤2 frames, or nothing overlaps: the minimal-nudge separator is ideal — it
  // respects free-drag positions and only moves what must move.
  if (rects.length <= 2 || !anyOverlap) return resolveFrameCollisions(rects, anchorId, gap);

  // 3+ overlapping: reflow into a stable wrapping row in reading order. Origin
  // = the group's current top-left (or the anchor's corner, so it stays put).
  const sorted = [...rects].sort((a, b) => a.y - b.y || a.x - b.x || (a.id < b.id ? -1 : 1));
  const anchor = anchorId ? rects.find((r) => r.id === anchorId) : undefined;
  const originX = anchor ? anchor.x : Math.min(...rects.map((r) => r.x));
  const originY = anchor ? anchor.y : Math.min(...rects.map((r) => r.y));
  const out: Record<string, { dx: number; dy: number }> = {};
  let x = originX, y = originY, rowH = 0;
  for (const r of sorted) {
    if (x > originX && x + r.w - originX > FRAME_ROW_MAX) { x = originX; y += rowH + gap; rowH = 0; }
    out[r.id] = { dx: Math.round(x - r.x), dy: Math.round(y - r.y) };
    x += r.w + gap;
    if (r.h > rowH) rowH = r.h;
  }
  return out;
}

/**
 * Slot for a NEW tile inside a frame. Extends the current top row to the right
 * if the tile still fits within `maxRowWidth` (measured from the leftmost
 * member); otherwise wraps to a fresh row below everything. Top-aligned within
 * a row. `members` are the absolute rects of tiles already in the frame.
 */
export function nextSlotInFrame(
  origin: { x: number; y: number },
  members: LayoutRect[],
  tile: { w: number; h: number },
  opts: { padX: number; padTop: number; gap: number; maxRowWidth?: number },
): { x: number; y: number } {
  const startX = origin.x + opts.padX;
  const startY = origin.y + opts.padTop;
  if (members.length === 0) return { x: startX, y: startY };

  const maxRowWidth = opts.maxRowWidth ?? FRAME_ROW_MAX;
  // Single pass — avoid four array allocations per call.
  let leftX = Infinity, rightX = -Infinity, topY = Infinity, botY = -Infinity;
  for (const m of members) {
    if (m.x < leftX) leftX = m.x;
    if (m.x + m.w > rightX) rightX = m.x + m.w;
    if (m.y < topY) topY = m.y;
    if (m.y + m.h > botY) botY = m.y + m.h;
  }

  const candidateX = rightX + opts.gap;
  if (candidateX + tile.w - leftX <= maxRowWidth) {
    // Fits on the current row — top-align with the existing row.
    return { x: candidateX, y: topY };
  }
  // Wrap: new row below everything, back at the left edge.
  return { x: startX, y: botY + opts.gap };
}

// ── opt-in arrange (Columns / Rows / Grid) ──────────────────────────────────

export type ArrangeMode = "columns" | "rows" | "grid";

/** A box to arrange — a member tile or a worktree sub-frame, by absolute rect. */
export interface ArrangeBox { id: string; x: number; y: number; w: number; h: number }

/**
 * Tidy a frame's contents into the chosen layout, returning each box's new
 * absolute top-left. Boxes are taken in reading order (top→bottom, left→right)
 * so the result is stable and matches what the user sees.
 *  - columns: one horizontal band, boxes side by side, top-aligned.
 *  - rows:    one vertical stack, boxes left-aligned.
 *  - grid:    pack left→right, wrapping to a new row past maxRowWidth; each row
 *             advances by its tallest box.
 * Pure — no overlap because every box gets a fresh slot.
 */
export function arrangeBoxes(
  boxes: ArrangeBox[],
  mode: ArrangeMode,
  opts: { originX: number; originY: number; padX: number; padTop: number; gap: number; maxRowWidth?: number },
): Map<string, { x: number; y: number }> {
  const out = new Map<string, { x: number; y: number }>();
  const sorted = [...boxes].sort((a, b) => a.y - b.y || a.x - b.x);
  const startX = opts.originX + opts.padX;
  const startY = opts.originY + opts.padTop;

  if (mode === "rows") {
    let y = startY;
    for (const b of sorted) {
      out.set(b.id, { x: startX, y });
      y += b.h + opts.gap;
    }
  } else if (mode === "columns") {
    let x = startX;
    for (const b of sorted) {
      out.set(b.id, { x, y: startY });
      x += b.w + opts.gap;
    }
  } else {
    const maxW = opts.maxRowWidth ?? FRAME_ROW_MAX;
    let x = startX, y = startY, rowH = 0;
    for (const b of sorted) {
      if (x > startX && x + b.w - startX > maxW) { x = startX; y += rowH + opts.gap; rowH = 0; }
      out.set(b.id, { x, y });
      x += b.w + opts.gap;
      if (b.h > rowH) rowH = b.h;
    }
  }
  return out;
}

// ── nesting-aware whole-canvas auto-fit ─────────────────────────────────────

/** A frame's stored geometry (absolute x/y). `parentFrameId` set => this is a
 *  worktree sub-frame nested inside that repo frame. */
export interface FrameGeom {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  parentFrameId?: string;
}

/** Absolute bounding box of one member tile (right/bottom precomputed). */
export interface MemberRect { x: number; y: number; r: number; b: number }

/** Padding/sizing knobs — passed in so Canvas owns the single source of truth
 *  for FRAME_PAD/FRAME_HEADER/etc. and this stays pure. */
export interface FrameLayoutConst {
  /** Side + bottom padding from member tiles to the frame edge. */
  pad: number;
  /** Header bar height — room reserved above member tiles. */
  header: number;
  /** Collapsed placeholder size for an empty frame. */
  emptyW: number;
  emptyH: number;
  /** Gap between separated sibling frames. Default FRAME_GAP. */
  gap?: number;
  /** Extra inset a parent repo frame keeps around its nested child frames
   *  (on top of its own header room). Default = pad. */
  nestPad?: number;
}

interface Rect { x: number; y: number; w: number; h: number }

/** Bounding box of member tiles for one frame, padded to frame edges. Empty
 *  members → a collapsed placeholder anchored at the frame's current origin. */
function tileBox(f: FrameGeom, mem: MemberRect[] | undefined, k: FrameLayoutConst): Rect {
  if (!mem || mem.length === 0) return { x: f.x, y: f.y, w: k.emptyW, h: k.emptyH };
  // Single pass — `Math.min(...mem.map())` four times allocates four arrays per
  // frame per layout tick (hot path). One reduce, no intermediates.
  let minX = Infinity, minY = Infinity, maxR = -Infinity, maxB = -Infinity;
  for (const m of mem) {
    if (m.x < minX) minX = m.x;
    if (m.y < minY) minY = m.y;
    if (m.r > maxR) maxR = m.r;
    if (m.b > maxB) maxB = m.b;
  }
  return {
    x: Math.round(minX - k.pad),
    y: Math.round(minY - k.header),
    w: Math.round(maxR - minX + k.pad * 2),
    h: Math.round(maxB - minY + k.header + k.pad),
  };
}

/**
 * Whole-canvas frame geometry, nesting-aware — N levels deep.
 *
 * Frames form a forest (parentFrameId). A frame's geometry derives, bottom-up,
 * from its own member tiles PLUS its (recursively laid-out) child frames. The
 * algorithm, post-order (leaves first) so a parent can wrap already-sized
 * children:
 *
 *   1. Every frame's tile-derived box (`tileBox`).
 *   2. For each frame with children, lay the CHILD SUBTREES out first, then
 *      separate that sibling group among themselves (anchor pinned) — siblings
 *      never overlap. Record each child's LOCAL delta (within its parent).
 *   3. The frame's desired box = union(own tiles, separated child boxes), inset
 *      by `nestPad` + header room when it has children, so they sit visually
 *      inside it below its title bar.
 *   4. The ROOT sibling group (top-level frames) is separated last.
 *   5. Deltas accumulate top-down: a frame's TOTAL shift = its parent's total
 *      shift + its own local sibling delta. That total is what the caller
 *      applies to the frame's member tiles, and it moves a whole nest as one
 *      body at every depth.
 *
 * At each sibling group the anchor is projected to the ANCESTOR that belongs to
 * that group (see `groupAnchor`) — so dragging/spawning a deeply-nested frame
 * pins its enclosing branch at every level and only outsiders yield.
 *
 * Returns final per-frame geometry plus, per frame, the {dx,dy} to apply to
 * that frame's MEMBER TILES (absolute). For a nested frame this shift folds in
 * every ancestor's delta.
 */
export function computeFrameLayout(
  frames: FrameGeom[],
  memberRects: Map<string, MemberRect[]>,
  anchorId: string | null | undefined,
  k: FrameLayoutConst,
): {
  geometry: Map<string, Rect>;
  tileShift: Map<string, { dx: number; dy: number }>;
} {
  const gap = k.gap ?? FRAME_GAP;
  const nestPad = k.nestPad ?? k.pad;
  const byId = new Map(frames.map((f) => [f.id, f]));
  // A parentFrameId that points at a missing frame ⇒ treat as top-level. Also
  // guards a parentFrameId cycle: `depth`-cap the ancestor walk below.
  const parentOf = (f: FrameGeom) =>
    f.parentFrameId && byId.has(f.parentFrameId) ? f.parentFrameId : undefined;

  const childrenOf = new Map<string, FrameGeom[]>();
  const roots: FrameGeom[] = [];
  for (const f of frames) {
    const p = parentOf(f);
    if (p) (childrenOf.get(p) ?? childrenOf.set(p, []).get(p)!).push(f);
    else roots.push(f);
  }

  // 1) tile-derived box for every frame.
  const tBox = new Map<string, Rect>();
  for (const f of frames) tBox.set(f.id, tileBox(f, memberRects.get(f.id), k));

  // The set of ancestors of the anchor (anchor included). At each sibling group
  // we pin whichever member is on this path — so a nest stays put at every
  // level while outsiders yield. Cap the climb to guard a malformed cycle.
  const anchorPath = new Set<string>();
  if (anchorId && byId.has(anchorId)) {
    let cur: string | undefined = anchorId;
    for (let i = 0; i < 64 && cur; i++) {
      anchorPath.add(cur);
      cur = parentOf(byId.get(cur)!);
    }
  }
  // Which member of THIS sibling group lies on the anchor path (if any).
  const groupAnchor = (group: FrameGeom[]): string | null => {
    for (const f of group) if (anchorPath.has(f.id)) return f.id;
    return null;
  };

  // `desired[id]` — a frame's box in its PARENT's (unshifted) coordinate space,
  // i.e. after wrapping its already-separated children but before its own
  // sibling-group separation. `localDelta[id]` — the shift its sibling-group
  // separation applied (within the parent). Filled post-order.
  const desired = new Map<string, Rect>();
  const localDelta = new Map<string, { dx: number; dy: number }>();

  // Post-order layout of the subtree rooted at `f`: lay out + separate its
  // children first, then compute f's own desired box. Recursion depth = nesting
  // depth (small); a visited-guard defends against a parentFrameId cycle.
  const laidOut = new Set<string>();
  const layout = (f: FrameGeom): void => {
    if (laidOut.has(f.id)) return;
    laidOut.add(f.id);
    const kids = childrenOf.get(f.id) ?? [];
    for (const c of kids) layout(c);

    // Children whose desired box is known. A parentFrameId CYCLE creates a
    // back-edge (a "child" that is actually an ancestor mid-layout); its box
    // isn't computed yet, so exclude it here to avoid a use-before-set. The
    // orphan pass lays such frames out as their own roots afterward.
    const laidKids = kids.filter((c) => desired.has(c.id));

    // Separate this frame's children among themselves (their desired boxes are
    // now known). A lone child can't collide → zero delta.
    if (laidKids.length >= 2) {
      const rects: LayoutRect[] = laidKids.map((c) => ({ id: c.id, ...desired.get(c.id)! }));
      const d = separateSiblingFrames(rects, groupAnchor(laidKids), gap);
      for (const c of laidKids) localDelta.set(c.id, d[c.id] ?? { dx: 0, dy: 0 });
    } else {
      for (const c of laidKids) localDelta.set(c.id, { dx: 0, dy: 0 });
    }

    // f's desired box wraps its own tiles + its children's SEPARATED boxes.
    const boxes: Rect[] = [];
    const ownHasTiles = (memberRects.get(f.id)?.length ?? 0) > 0;
    if (ownHasTiles) boxes.push(tBox.get(f.id)!);
    for (const c of laidKids) {
      const b = desired.get(c.id)!;
      const d = localDelta.get(c.id) ?? { dx: 0, dy: 0 };
      boxes.push({ x: b.x + d.dx, y: b.y + d.dy, w: b.w, h: b.h });
    }
    if (boxes.length === 0) {
      desired.set(f.id, { x: f.x, y: f.y, w: k.emptyW, h: k.emptyH });
      return;
    }
    const minX = Math.min(...boxes.map((b) => b.x));
    const minY = Math.min(...boxes.map((b) => b.y));
    const maxR = Math.max(...boxes.map((b) => b.x + b.w));
    const maxB = Math.max(...boxes.map((b) => b.y + b.h));
    if (laidKids.length) {
      // Inset around the nest + extra header room so the title bar clears the
      // child frames sitting below it.
      desired.set(f.id, {
        x: minX - nestPad,
        y: minY - k.header,
        w: maxR - minX + nestPad * 2,
        h: maxB - minY + k.header + nestPad,
      });
    } else {
      desired.set(f.id, { x: minX, y: minY, w: maxR - minX, h: maxB - minY });
    }
  };
  for (const r of roots) layout(r);
  // A parentFrameId CYCLE (A→B→A) leaves no roots, so nothing above laid those
  // frames out. Treat any not-yet-laid-out frame as its own root so the call
  // still terminates with geometry for every frame (malformed input, but we
  // must never hang or drop frames).
  const orphans = frames.filter((f) => !laidOut.has(f.id));
  for (const f of orphans) layout(f);

  // 4) separate the ROOT sibling group (pinning the anchor's top ancestor).
  if (roots.length >= 2) {
    const rects: LayoutRect[] = roots.map((f) => ({ id: f.id, ...desired.get(f.id)! }));
    const d = resolveFrameCollisions(rects, groupAnchor(roots), gap);
    for (const f of roots) localDelta.set(f.id, d[f.id] ?? { dx: 0, dy: 0 });
  } else {
    for (const f of roots) localDelta.set(f.id, { dx: 0, dy: 0 });
  }

  // 5) accumulate deltas top-down + assemble geometry. A frame's TOTAL shift is
  // its parent's total plus its own local sibling delta; its final position is
  // its (parent-space) desired box shifted by that total.
  const geometry = new Map<string, Rect>();
  const tileShift = new Map<string, { dx: number; dy: number }>();
  const assemble = (f: FrameGeom, parentTotal: { dx: number; dy: number }): void => {
    if (geometry.has(f.id)) return; // already placed (cycle / shared-guard)
    const loc = localDelta.get(f.id) ?? { dx: 0, dy: 0 };
    const total = { dx: parentTotal.dx + loc.dx, dy: parentTotal.dy + loc.dy };
    const r = desired.get(f.id)!;
    geometry.set(f.id, { x: r.x + total.dx, y: r.y + total.dy, w: r.w, h: r.h });
    tileShift.set(f.id, total);
    for (const c of childrenOf.get(f.id) ?? []) assemble(c, total);
  };
  for (const r of roots) assemble(r, { dx: 0, dy: 0 });
  // Assemble cycle-orphan subtrees (see the orphan layout above). Guard against
  // re-assembling a frame already placed via a root.
  for (const f of orphans) if (!geometry.has(f.id)) assemble(f, { dx: 0, dy: 0 });
  return { geometry, tileShift };
}

/** Which frame contains the point (cx,cy)? Prefers the INNERMOST frame — a
 *  worktree child sits geometrically inside its repo parent, so a tile dropped
 *  there must join the CHILD (its PTY runs on the worktree's branch/cwd), not
 *  the parent. Among children / among parents, the first hit wins, so pass the
 *  frames z-DESCENDING for topmost-wins. Pure; used for drop-membership. */
export function frameAtPoint(
  framesZDesc: Array<{ id: string; x: number; y: number; w: number; h: number; parentFrameId?: string }>,
  cx: number,
  cy: number,
): { id: string; x: number; y: number } | null {
  const hit = (f: { x: number; y: number; w: number; h: number }) =>
    cx >= f.x && cx <= f.x + f.w && cy >= f.y && cy <= f.y + f.h;
  for (const f of framesZDesc) if (f.parentFrameId && hit(f)) return { id: f.id, x: f.x, y: f.y };
  for (const f of framesZDesc) if (!f.parentFrameId && hit(f)) return { id: f.id, x: f.x, y: f.y };
  return null;
}
