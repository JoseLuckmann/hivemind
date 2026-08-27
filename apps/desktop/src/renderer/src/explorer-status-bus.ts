/**
 * Explorer status bus — a tiny pub/sub so a File Explorer tile can broadcast
 * metadata about the folder it's watching (how many files it has, the most
 * recent add/modify/remove) without prop drilling. Mirrors `agent-status-bus.ts`'s
 * shape (publish/subscribe-with-replay/clear/lookup) so other canvas surfaces
 * (Layers rail badges, a future notification, another tile) can consume a File
 * Explorer's live state the same way they already consume agent status.
 *
 * One-way, Explorer tile → subscribers. Keyed by tileId (a canvas can have
 * several Explorer tiles open on different folders at once).
 */
export interface ExplorerFileEvent {
  type: "added" | "modified" | "removed";
  /** Path relative to the explorer's bound folder. */
  path: string;
  ts: number;
}

export interface ExplorerStats {
  tileId: string;
  /** Absolute folder this Explorer tile is bound to. */
  folder: string;
  fileCount: number;
  /** The most recent live fs event seen for this folder, if any yet. */
  lastEvent?: ExplorerFileEvent;
}

type Listener = (e: ExplorerStats) => void;

const listeners = new Set<Listener>();
const stats = new Map<string, ExplorerStats>();

/** Publish (or update) a tile's stats. Callers pass the full current snapshot —
 *  there's no partial-merge here, so include `lastEvent` from the previous
 *  publish when only `fileCount` changed (and vice versa) if both should stay
 *  visible to subscribers. */
export function publishExplorerStats(e: ExplorerStats): void {
  stats.set(e.tileId, e);
  for (const l of listeners) l(e);
}

/** Subscribe to every Explorer tile's stats. Replays the last-known snapshot
 *  of every live tile immediately, so a panel that mounts late isn't stale
 *  until the next change (same replay-on-subscribe behavior as agent-status-bus). */
export function subscribeExplorerStats(l: Listener): () => void {
  listeners.add(l);
  for (const e of stats.values()) l(e);
  return () => {
    listeners.delete(l);
  };
}

/** Drop a tile's stats (call on Explorer tile unmount/close). */
export function clearExplorerStats(tileId: string): void {
  stats.delete(tileId);
}

/** Last-known stats for one tile, or null if none published yet. */
export function explorerStatsOf(tileId: string): ExplorerStats | null {
  return stats.get(tileId) ?? null;
}

/** Every Explorer tile's last-known stats, e.g. for a panel listing them all. */
export function allExplorerStats(): ExplorerStats[] {
  return Array.from(stats.values());
}
