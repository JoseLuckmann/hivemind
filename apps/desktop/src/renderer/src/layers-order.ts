/**
 * Layers-panel ordering — persistence + pure helpers for the user's manual
 * drag-to-reorder of the left rail. Kept out of LayersPanel/Canvas so the
 * load/save shapes and the reordering math are isolated and unit-testable
 * (mirrors windows-view-state.ts / canvas-persistence.ts's split).
 *
 * What's persisted (PER-REPO — a manual order is a property of that repo's
 * canvas, keyed by the same repoPath sentinel the layout blob uses):
 *   • a frame order:  frameId[]           — the top-level workspace sequence
 *   • per-frame tile orders: { [frameId]: tileId[] } — tiles within a frame,
 *     plus the "__canvas__" bucket for loose (frameless) tiles.
 *
 * The stored orders are ADVISORY, not authoritative: tiles/frames open and
 * close outside the panel's control, so `applyOrder` treats the saved list as
 * a sort key and always appends anything it hasn't seen (in the live order) at
 * the end. That way a brand-new tile shows up predictably and a closed one just
 * drops out — the manual order survives across both.
 */

/** Sentinel bucket key for loose (frameless) tiles in the per-frame map. */
export const LOOSE_BUCKET = "__canvas__";

export interface LayersOrder {
  /** Top-level frame sequence (frame ids). */
  frames: string[];
  /** Tile sequence within each frame id (and LOOSE_BUCKET for loose tiles). */
  tiles: Record<string, string[]>;
}

const EMPTY: LayersOrder = { frames: [], tiles: {} };

/** Per-repo key. Mirrors the layout blob's sentinel so a no-repo (welcome/e2e)
 *  session doesn't leak a manual order across projects. */
export const LAYERS_ORDER_KEY = (repoPath: string | null): string =>
  `hivemind:layers-order:${repoPath ?? "__global__"}`;

export function loadLayersOrder(repoPath: string | null): LayersOrder {
  if (typeof window === "undefined" || !repoPath) return { frames: [], tiles: {} };
  try {
    const raw = window.localStorage.getItem(LAYERS_ORDER_KEY(repoPath));
    if (!raw) return { frames: [], tiles: {} };
    const parsed = JSON.parse(raw) as unknown;
    return normalize(parsed);
  } catch {
    return { frames: [], tiles: {} };
  }
}

export function saveLayersOrder(repoPath: string | null, order: LayersOrder): void {
  if (typeof window === "undefined" || !repoPath) return;
  try {
    window.localStorage.setItem(LAYERS_ORDER_KEY(repoPath), JSON.stringify(normalize(order)));
  } catch {
    /* private mode / quota — best-effort */
  }
}

/** Coerce arbitrary parsed JSON into a well-formed LayersOrder (drops non-string
 *  entries and non-array buckets), so a corrupted blob can never crash a render. */
function normalize(value: unknown): LayersOrder {
  if (!value || typeof value !== "object") return { frames: [], tiles: {} };
  const v = value as Partial<LayersOrder>;
  const frames = Array.isArray(v.frames) ? v.frames.filter((x): x is string => typeof x === "string") : [];
  const tiles: Record<string, string[]> = {};
  if (v.tiles && typeof v.tiles === "object") {
    for (const [k, list] of Object.entries(v.tiles)) {
      if (Array.isArray(list)) tiles[k] = list.filter((x): x is string => typeof x === "string");
    }
  }
  return { frames, tiles };
}

/**
 * Sort `live` ids by a saved `order`, then append any live id not in the order
 * (preserving its live relative position). Pure; the workhorse behind both the
 * frame sequence and each frame's tile sequence.
 *
 *   applyOrder(["a","b","c"], ["c","a"])      → ["c","a","b"]
 *   applyOrder(["a","b"],     ["x","b","a"])  → ["b","a"]   (unknown "x" dropped)
 */
export function applyOrder<T>(live: readonly T[], order: readonly T[]): T[] {
  const liveSet = new Set(live);
  const seen = new Set<T>();
  const head: T[] = [];
  for (const id of order) {
    if (liveSet.has(id) && !seen.has(id)) {
      head.push(id);
      seen.add(id);
    }
  }
  const tail = live.filter((id) => !seen.has(id));
  return [...head, ...tail];
}

/**
 * Move the item `dragId` so it lands immediately BEFORE `beforeId` in `ids`
 * (append to the end when `beforeId` is null). Pure + returns a new array;
 * a no-op move (drop onto self) returns an equivalent order. Both ids must be
 * present — an unknown drag id yields the input unchanged.
 */
export function reorder<T>(ids: readonly T[], dragId: T, beforeId: T | null): T[] {
  if (!ids.includes(dragId)) return [...ids];
  // Dropping an item onto itself is a no-op (the natural gesture when you pick a
  // row up and set it back) — guard it before the remove/insert, which would
  // otherwise fall through to the append branch and move it to the end.
  if (beforeId === dragId) return [...ids];
  const without = ids.filter((id) => id !== dragId);
  if (beforeId == null || !without.includes(beforeId)) {
    return [...without, dragId];
  }
  const at = without.indexOf(beforeId);
  return [...without.slice(0, at), dragId, ...without.slice(at)];
}

/**
 * Compute the destination bucket's new id order when a tile is REPARENTED into
 * it (moved from another frame / the loose canvas). The moved id lands
 * immediately BEFORE `beforeId`, or appended when `beforeId` is null/absent.
 * Any pre-existing copy of `movedId` in `destIds` is removed first (defensive —
 * a reparent shouldn't duplicate). Pure; returns a new array.
 *
 *   placeInto(["a","b"], "x", "b")  → ["a","x","b"]
 *   placeInto(["a","b"], "x", null) → ["a","b","x"]
 */
export function placeInto<T>(destIds: readonly T[], movedId: T, beforeId: T | null): T[] {
  const without = destIds.filter((id) => id !== movedId);
  if (beforeId == null || beforeId === movedId || !without.includes(beforeId)) {
    return [...without, movedId];
  }
  const at = without.indexOf(beforeId);
  return [...without.slice(0, at), movedId, ...without.slice(at)];
}
