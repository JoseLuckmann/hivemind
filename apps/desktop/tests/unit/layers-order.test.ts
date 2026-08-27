// Layers-panel ordering — per-repo persistence + the pure reorder/applyOrder
// helpers behind the Layers panel's drag-to-reorder. Unit-testable because they
// are plain module functions; a tiny in-memory localStorage shim stands in for
// the browser store (same pattern as windows-view-state.test.ts).
import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";

const store = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
    setItem: (k: string, v: string) => void store.set(k, v),
    removeItem: (k: string) => void store.delete(k),
  },
};

const {
  loadLayersOrder, saveLayersOrder, applyOrder, reorder, LAYERS_ORDER_KEY, LOOSE_BUCKET,
} = await import("../../src/renderer/src/layers-order.ts");

beforeEach(() => store.clear());

// ── applyOrder ──────────────────────────────────────────────────────────────

test("applyOrder sorts by saved order then appends unseen live ids", () => {
  assert.deepEqual(applyOrder(["a", "b", "c"], ["c", "a"]), ["c", "a", "b"]);
});

test("applyOrder drops saved ids that are no longer live", () => {
  assert.deepEqual(applyOrder(["a", "b"], ["x", "b", "a"]), ["b", "a"]);
});

test("applyOrder is identity when there is no saved order", () => {
  assert.deepEqual(applyOrder(["a", "b", "c"], []), ["a", "b", "c"]);
});

test("applyOrder tolerates duplicate saved ids without duplicating output", () => {
  assert.deepEqual(applyOrder(["a", "b"], ["b", "b", "a"]), ["b", "a"]);
});

test("applyOrder returns empty for empty live regardless of saved order", () => {
  assert.deepEqual(applyOrder<string>([], ["a", "b"]), []);
});

// ── reorder ─────────────────────────────────────────────────────────────────

test("reorder moves an item immediately before the target", () => {
  assert.deepEqual(reorder(["a", "b", "c"], "c", "a"), ["c", "a", "b"]);
});

test("reorder appends when beforeId is null", () => {
  assert.deepEqual(reorder(["a", "b", "c"], "a", null), ["b", "c", "a"]);
});

test("reorder appends when beforeId is not present", () => {
  assert.deepEqual(reorder(["a", "b", "c"], "a", "zzz"), ["b", "c", "a"]);
});

test("reorder dropping an item onto itself is a stable no-op-equivalent", () => {
  assert.deepEqual(reorder(["a", "b", "c"], "b", "b"), ["a", "b", "c"]);
});

test("reorder moving down before a later sibling", () => {
  assert.deepEqual(reorder(["a", "b", "c", "d"], "a", "c"), ["b", "a", "c", "d"]);
});

test("reorder leaves the list unchanged when the drag id is unknown", () => {
  assert.deepEqual(reorder(["a", "b"], "zzz", "a"), ["a", "b"]);
});

test("reorder returns a NEW array (does not mutate input)", () => {
  const input = ["a", "b", "c"];
  const out = reorder(input, "c", "a");
  assert.deepEqual(input, ["a", "b", "c"]);
  assert.notEqual(out, input);
});

// ── persistence ───────────────────────────────────────────────────────────

test("layers order is per-repo and round-trips", () => {
  const repoA = "/tmp/a";
  const repoB = "/tmp/b";
  saveLayersOrder(repoA, { frames: ["f1", "f2"], tiles: { f1: ["t1", "t2"] } });
  saveLayersOrder(repoB, { frames: ["fz"], tiles: {} });
  assert.deepEqual(loadLayersOrder(repoA), { frames: ["f1", "f2"], tiles: { f1: ["t1", "t2"] } });
  assert.deepEqual(loadLayersOrder(repoB), { frames: ["fz"], tiles: {} });
  // Distinct keys → no cross-repo leak.
  assert.notEqual(LAYERS_ORDER_KEY(repoA), LAYERS_ORDER_KEY(repoB));
});

test("loose-tile bucket persists under the LOOSE_BUCKET key", () => {
  const repo = "/tmp/loose";
  saveLayersOrder(repo, { frames: [], tiles: { [LOOSE_BUCKET]: ["x", "y"] } });
  assert.deepEqual(loadLayersOrder(repo).tiles[LOOSE_BUCKET], ["x", "y"]);
});

test("no-repo order never touches storage and loads empty", () => {
  saveLayersOrder(null, { frames: ["f"], tiles: { f: ["t"] } });
  assert.equal(store.size, 0);
  assert.deepEqual(loadLayersOrder(null), { frames: [], tiles: {} });
});

test("loadLayersOrder tolerates malformed json → empty order", () => {
  const repo = "/tmp/bad";
  store.set(LAYERS_ORDER_KEY(repo), "{not json");
  assert.deepEqual(loadLayersOrder(repo), { frames: [], tiles: {} });
});

test("loadLayersOrder normalizes non-string / non-array garbage", () => {
  const repo = "/tmp/garbage";
  // Numbers in frames, a non-array bucket, and a good bucket with a stray number.
  store.set(
    LAYERS_ORDER_KEY(repo),
    JSON.stringify({ frames: ["a", 3, "b"], tiles: { f1: ["t1", 9, "t2"], f2: "nope" } }),
  );
  assert.deepEqual(loadLayersOrder(repo), { frames: ["a", "b"], tiles: { f1: ["t1", "t2"] } });
});

test("loadLayersOrder defaults to an empty order when nothing is stored", () => {
  assert.deepEqual(loadLayersOrder("/tmp/empty"), { frames: [], tiles: {} });
});
