/**
 * Provider-agnostic two-way sync between a hivemind board and ONE external
 * tracker. The hivemind issue is canonical: on a genuine conflict (both
 * sides changed since the last sync) local wins. Deletes are never
 * propagated either direction — a remote item that disappears is just
 * skipped, a locally-deleted issue simply stops being pushed to.
 *
 * "Did the local side change" is answered with a hash of the synced fields
 * (see `hashSyncFields`), NOT `issue.updated`: that timestamp bumps on every
 * write — including the engine's own pulls — and can collide at millisecond
 * resolution between back-to-back writes, so it can't reliably tell "we just
 * wrote this" apart from "a real edit landed in the same millisecond". A
 * content hash has neither problem, and as a bonus ignores edits to fields
 * sync doesn't touch (assignee, parent, ...).
 */
import { createHash } from "node:crypto";
import { listIssues, readIssue, createIssue, updateIssue, setSyncLink } from "../storage.js";
import type { Issue, IssueSummary } from "../types.js";
import { PENDING_EXTERNAL_ID } from "../types.js";
import type { RemoteItem, SyncProvider } from "./types.js";

export { PENDING_EXTERNAL_ID };

export interface SyncError {
  /** Local issue id, when the failure happened on the local side. */
  id?: string;
  /** Remote item id, when the failure happened on the remote side. */
  externalId?: string;
  message: string;
}

export interface SyncReport {
  pushed: number;
  pulled: number;
  created: number;
  /** Local-only issues left untouched because they were never explicitly linked
   *  or marked for creation — sync NEVER auto-creates them in the tracker (that
   *  would duplicate your whole local board upstream). */
  skippedLocalOnly: number;
  errors: SyncError[];
}

function hashSyncFields(issue: Issue): string {
  // Deliberately EXCLUDES `state`: the local Kanban is NOT a mirror of the
  // remote board. A task can be "done" locally while it's still "in review" in
  // Azure (e.g. handed to QA), so a local state move must NOT push to the remote
  // and a remote state change must NOT overwrite the local column. Remote state
  // is moved only via an explicit user action (see `setRemoteState`).
  return createHash("sha1")
    .update(
      JSON.stringify({
        title: issue.title,
        description: issue.sections.description,
        acceptanceCriteria: issue.sections.acceptanceCriteria,
        labels: issue.labels,
      }),
    )
    .digest("hex");
}

export async function runSync<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  secret: string,
): Promise<SyncReport> {
  const report: SyncReport = { pushed: 0, pulled: 0, created: 0, skippedLocalOnly: 0, errors: [] };

  let remoteItems: RemoteItem[];
  try {
    remoteItems = await provider.listRemoteItems(config, secret);
  } catch (e) {
    report.errors.push({ message: `listing ${provider.label} items: ${errMsg(e)}` });
    return report;
  }
  const remoteById = new Map(remoteItems.map((r) => [r.externalId, r]));
  const matchedRemoteIds = new Set<string>();
  // Dedupe helper: a normalized-title → remote item index, so an explicit
  // create can adopt an existing upstream item with the same title instead of
  // making a second copy (guards a re-run after a partial failure).
  const remoteByTitle = new Map<string, RemoteItem>();
  for (const r of remoteItems) {
    const key = r.title.trim().toLowerCase();
    if (key && !remoteByTitle.has(key)) remoteByTitle.set(key, r);
  }

  const summaries = await listIssues(root);
  for (const summary of summaries) {
    const link = linkFor(summary, provider.id);
    try {
      if (!link) {
        // No link at all → this is a LOCAL-ONLY issue. Do NOT auto-create it in
        // the tracker: that would duplicate the entire local board upstream on
        // every sync. Creating a remote item is an explicit, opt-in action
        // (the New-issue "file onto this board" flow, which stamps a pending
        // link, or a deliberate "push to tracker" command).
        report.skippedLocalOnly++;
        continue;
      }

      if (link.externalId === PENDING_EXTERNAL_ID) {
        // Explicitly marked for creation. Dedupe first: if an upstream item with
        // the same title already exists and isn't spoken for, ADOPT it (link +
        // sync) instead of creating a duplicate — this makes a re-run after a
        // failed/partial create idempotent.
        const issue = await readIssue(root, summary.id);
        const twin = remoteByTitle.get(issue.title.trim().toLowerCase());
        if (twin && !matchedRemoteIds.has(twin.externalId)) {
          matchedRemoteIds.add(twin.externalId);
          await adoptRemote(root, provider, config, issue, twin);
          report.pushed++;
          continue;
        }
        const created = await pushNew(root, provider, config, secret, summary.id, {
          workItemType: link.workItemType,
          areaPath: link.areaPath,
        });
        if (created) matchedRemoteIds.add(created);
        report.pushed++;
        continue;
      }

      const remote = remoteById.get(link.externalId);
      if (!remote) continue; // deleted upstream — no delete propagation
      matchedRemoteIds.add(link.externalId);

      const issue = await readIssue(root, summary.id);
      const remoteChanged = remote.rev !== link.remoteRev;
      const localChanged = hashSyncFields(issue) !== link.localFieldsHash;
      // Always refresh the recorded remote state (display-only) even when
      // nothing else changed, so the card shows where Azure currently sits.
      if (!remoteChanged && !localChanged) {
        if (remote.state && remote.state !== link.remoteState) {
          await touchRemoteState(root, provider.id, summary.id, remote);
        }
        continue;
      }

      if (remoteChanged && !localChanged) {
        await pull(root, provider, config, summary.id, remote);
        report.pulled++;
      } else {
        // Local field change (title/description/labels) → push those fields.
        // State is NOT part of this (decoupled); it moves only via setRemoteState.
        await push(root, provider, config, secret, issue, link, remote);
        report.pushed++;
      }
    } catch (e) {
      report.errors.push({ id: summary.id, message: errMsg(e) });
    }
  }

  for (const remote of remoteItems) {
    if (matchedRemoteIds.has(remote.externalId)) continue;
    try {
      await createLocal(root, provider, config, remote);
      report.created++;
    } catch (e) {
      report.errors.push({ externalId: remote.externalId, message: errMsg(e) });
    }
  }

  return report;
}

/** Explicitly move an issue's REMOTE board state (Azure column) — the only path
 *  that changes remote state, kept separate from field sync because the local
 *  Kanban state is decoupled from the remote board. Requires the issue to be
 *  linked (a pending/unlinked issue has no remote item to move yet). Records the
 *  new remote state on the link for display. */
export async function setRemoteState<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  secret: string,
  id: string,
  state: Issue["state"],
): Promise<void> {
  const issue = await readIssue(root, id);
  const link = (issue.sync ?? []).find((s) => s.provider === provider.id);
  if (!link || link.externalId === PENDING_EXTERNAL_ID) {
    throw new Error(`${id} isn't linked to ${provider.label} yet — sync it first`);
  }
  const result = await provider.setRemoteState(config, secret, link.externalId, state);
  await setSyncLink(root, id, {
    ...link,
    remoteRev: result.rev,
    remoteState: result.remoteState,
    syncedAt: new Date().toISOString(),
  });
}

function linkFor(summary: IssueSummary, providerId: string) {
  return (summary.sync ?? []).find((s) => s.provider === providerId);
}

/** Map a provider's flat field set onto a hivemind IssuePatch. Turns the
 *  provider's assignee id (email/UPN) into a canonical `member` assignee so the
 *  board can default to "my tasks"; a null assignee clears it, undefined leaves
 *  it untouched. Deliberately OMITS `state`: the local Kanban column is owned by
 *  the user and is never overwritten from the remote board (see
 *  `hashSyncFields`). */
function toPatch(fields: {
  title: string;
  description: string;
  state: Issue["state"];
  labels: string[];
  assignee?: string | null;
}): {
  title: string;
  description: string;
  labels: string[];
  assignee?: Issue["assignee"];
} {
  const patch: {
    title: string;
    description: string;
    labels: string[];
    assignee?: Issue["assignee"];
  } = {
    title: fields.title,
    description: fields.description,
    labels: fields.labels,
  };
  if (fields.assignee !== undefined) {
    patch.assignee = fields.assignee ? { type: "member", id: fields.assignee } : null;
  }
  return patch;
}

async function pushNew<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  secret: string,
  id: string,
  hint?: { workItemType?: string; areaPath?: string },
): Promise<string> {
  const issue = await readIssue(root, id);
  const result = await provider.createRemoteItem(config, secret, issue, hint);
  await setSyncLink(root, id, {
    provider: provider.id,
    externalId: result.externalId,
    url: result.url,
    remoteRev: result.rev,
    localFieldsHash: hashSyncFields(issue),
    workItemType: result.workItemType ?? hint?.workItemType,
    areaPath: result.areaPath ?? hint?.areaPath,
    remoteState: result.remoteState,
    syncedAt: new Date().toISOString(),
  });
  return result.externalId;
}

/** Link a pending local issue to an ALREADY-EXISTING remote twin (matched by
 *  title) instead of creating a duplicate. No remote write — just records the
 *  link so future syncs treat them as the same item. */
async function adoptRemote<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  _config: TConfig,
  issue: Issue,
  remote: RemoteItem,
): Promise<void> {
  await setSyncLink(root, issue.id, {
    provider: provider.id,
    externalId: remote.externalId,
    url: remote.url,
    remoteRev: remote.rev,
    localFieldsHash: hashSyncFields(issue),
    workItemType: remote.workItemType,
    areaPath: remote.areaPath,
    remoteState: remote.state,
    syncedAt: new Date().toISOString(),
  });
}

async function push<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  secret: string,
  issue: Issue,
  link: { externalId: string; workItemType?: string; areaPath?: string },
  remote: RemoteItem,
): Promise<void> {
  // Carry the item's remembered type + area so a push targets the item's OWN
  // board pattern, not the board's default type. State is intentionally NOT
  // pushed here (decoupled) — updateRemoteItem leaves System.State alone.
  const result = await provider.updateRemoteItem(config, secret, link.externalId, issue, {
    workItemType: link.workItemType,
    areaPath: link.areaPath,
  });
  await setSyncLink(root, issue.id, {
    provider: provider.id,
    externalId: result.externalId,
    url: result.url,
    remoteRev: result.rev,
    localFieldsHash: hashSyncFields(issue),
    workItemType: result.workItemType ?? link.workItemType,
    areaPath: result.areaPath ?? link.areaPath,
    remoteState: result.remoteState ?? remote.state,
    syncedAt: new Date().toISOString(),
  });
}

/** Refresh ONLY the recorded remote state on the link (display) without any
 *  local field write — used when nothing else changed but Azure's column moved. */
async function touchRemoteState(
  root: string,
  providerId: string,
  id: string,
  remote: RemoteItem,
): Promise<void> {
  const issue = await readIssue(root, id);
  const link = (issue.sync ?? []).find((s) => s.provider === providerId);
  if (!link) return;
  await setSyncLink(root, id, { ...link, remoteState: remote.state });
}

async function pull<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  id: string,
  remote: RemoteItem,
): Promise<void> {
  const fields = provider.toIssueFields(remote, config);
  const updated = await updateIssue(
    root,
    id,
    toPatch(fields),
    "sync",
    `pulled from ${provider.label} #${remote.externalId}`,
  );
  await setSyncLink(root, id, {
    provider: provider.id,
    externalId: remote.externalId,
    url: remote.url,
    remoteRev: remote.rev,
    localFieldsHash: hashSyncFields(updated),
    workItemType: remote.workItemType,
    areaPath: remote.areaPath,
    remoteState: remote.state,
    syncedAt: new Date().toISOString(),
  });
}

async function createLocal<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  remote: RemoteItem,
): Promise<void> {
  const fields = provider.toIssueFields(remote, config);
  const issue = await createIssue(root, {
    title: fields.title,
    description: fields.description,
    state: fields.state,
    labels: fields.labels,
    assignee: fields.assignee ? { type: "member", id: fields.assignee } : null,
    who: "sync",
  });
  await setSyncLink(root, issue.id, {
    provider: provider.id,
    externalId: remote.externalId,
    url: remote.url,
    remoteRev: remote.rev,
    localFieldsHash: hashSyncFields(issue),
    workItemType: remote.workItemType,
    areaPath: remote.areaPath,
    remoteState: remote.state,
    syncedAt: new Date().toISOString(),
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
