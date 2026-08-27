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
import { listIssues, readIssue, createIssue, updateIssue, setSyncLink, commentOnIssue } from "../storage.js";
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
    // OFFLINE issues are deliberately kept out of sync — never pushed, pulled,
    // or matched to a remote item. Skip before any link handling so an offline
    // issue that happens to carry a stale link is still left untouched.
    if (summary.offline) {
      report.skippedLocalOnly++;
      continue;
    }
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
        // Even with no field/rev change, reconcile a TERMINAL remote state onto
        // the local column: an item that was already Done/Closed/Removed upstream
        // when this feature (or the link) came online must still land in the
        // local Done/Cancelled column — not just newly-transitioned ones. Cheap
        // and idempotent: updateIssue only writes when the state actually differs.
        const terminal = provider.isTerminalRemoteState?.(config, remote.state) ?? null;
        if (terminal && issue.state !== terminal) {
          await updateIssue(
            root,
            summary.id,
            { state: terminal },
            "sync",
            `state → ${terminal} (remote ${remote.state} is terminal in ${provider.label})`,
          );
          report.pulled++;
        }
        if (remote.state && remote.state !== link.remoteState) {
          await touchRemoteState(root, provider.id, summary.id, remote);
        }
        // Comments are tracked independently of the field hash/rev (a new
        // comment on either side isn't a field edit), so ALWAYS reconcile them.
        await syncComments(root, provider, config, secret, summary.id).catch((e) => {
          report.errors.push({ id: summary.id, message: `comments: ${errMsg(e)}` });
        });
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
      // Reconcile comments in the same pass (both directions), after fields.
      await syncComments(root, provider, config, secret, summary.id).catch((e) => {
        report.errors.push({ id: summary.id, message: `comments: ${errMsg(e)}` });
      });
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

  // Reconstruct the hierarchy (Epic→Feature→Story): now that every remote item
  // has a local counterpart, map each item's remote parent id to the local
  // parent issue id and set `parent` where it differs. Skipped when the provider
  // doesn't report parents. Best-effort — a missing/unsynced parent is left
  // untouched (top-level locally).
  const anyParents = remoteItems.some((r) => r.parentExternalId);
  if (anyParents) {
    try {
      await resolveHierarchy(root, provider.id, remoteItems);
    } catch (e) {
      report.errors.push({ message: `hierarchy: ${errMsg(e)}` });
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
  type?: Issue["type"];
}): {
  title: string;
  description: string;
  labels: string[];
  assignee?: Issue["assignee"];
  type?: Issue["type"];
} {
  const patch: {
    title: string;
    description: string;
    labels: string[];
    assignee?: Issue["assignee"];
    type?: Issue["type"];
  } = {
    title: fields.title,
    description: fields.description,
    labels: fields.labels,
  };
  if (fields.assignee !== undefined) {
    patch.assignee = fields.assignee ? { type: "member", id: fields.assignee } : null;
  }
  // Only set type when the remote mapped to a known kind — never clobber a
  // locally-set type with `undefined`.
  if (fields.type !== undefined) patch.type = fields.type;
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
  const patch = toPatch(fields);
  // Terminal remote state is the ONE exception to the state-decoupling rule: a
  // remote item that's Done/Closed/Resolved/Completed (or Removed → cancelled)
  // pulls its local counterpart into Done/Cancelled, so a finished/archived
  // upstream task lands in the right column instead of lingering in the local
  // board. Non-terminal states stay decoupled (see toPatch / hashSyncFields).
  const terminal = provider.isTerminalRemoteState?.(config, remote.state) ?? null;
  const updated = await updateIssue(
    root,
    id,
    terminal ? { ...patch, state: terminal } : patch,
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
  // A remote item that's already in a terminal state (Done/Closed/…/Removed)
  // should be CREATED locally in Done/Cancelled — not the reverse-map fallback,
  // which lands unmapped terminal names (e.g. "Closed"/"Resolved") in backlog.
  const terminal = provider.isTerminalRemoteState?.(config, remote.state) ?? null;
  const issue = await createIssue(root, {
    title: fields.title,
    description: fields.description,
    state: terminal ?? fields.state,
    type: fields.type,
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

/** Reconstruct the local parent hierarchy from the remote items' parent links.
 *  Builds a remote-externalId → local-issue-id index from every issue's sync
 *  link, then for each remote item that has a parent, sets the local issue's
 *  `parent` to the local id of that parent — but only when BOTH ends are synced
 *  locally and the value actually changes (avoids churn). A remote parent that
 *  isn't synced locally (out of scope) is left as top-level. */
async function resolveHierarchy(
  root: string,
  providerId: string,
  remoteItems: RemoteItem[],
): Promise<void> {
  const summaries = await listIssues(root);
  // externalId → local issue id
  const localByExternal = new Map<string, string>();
  for (const s of summaries) {
    const link = (s.sync ?? []).find((x) => x.provider === providerId);
    if (link && link.externalId && link.externalId !== PENDING_EXTERNAL_ID) {
      localByExternal.set(link.externalId, s.id);
    }
  }
  for (const remote of remoteItems) {
    if (!remote.parentExternalId) continue;
    const childLocal = localByExternal.get(remote.externalId);
    const parentLocal = localByExternal.get(remote.parentExternalId);
    if (!childLocal || !parentLocal || childLocal === parentLocal) continue;
    const issue = await readIssue(root, childLocal);
    if (issue.parent === parentLocal) continue;
    await updateIssue(root, childLocal, { parent: parentLocal }, "sync", `parent set from ${providerId} hierarchy`);
  }
}

// ── comment reconciliation ──────────────────────────────────────────

/** The activity `who` value stamped on comments mirrored IN from the remote.
 *  Prefix so the pusher can recognize (and skip) them — never echo a remote
 *  comment back to the remote. */
export const SYNC_COMMENT_WHO_PREFIX = "azure";

/** Non-pushable activity actors — the sync engine's own writes. Anything else
 *  (a human "ui" comment, an "agent" note) is user content eligible to push. */
function isSyncAuthored(who: string): boolean {
  return who === "sync" || who.startsWith(SYNC_COMMENT_WHO_PREFIX);
}

/** Two-way comment reconciliation for ONE linked issue:
 *   • PULL — append remote comments not yet mirrored (tracked by remote id on
 *     the link) into the activity log, stamped with a sync actor so they're
 *     never pushed back.
 *   • PUSH — post local activity entries authored by a human/agent that are
 *     past the link's high-water mark up to the remote as work-item comments.
 *
 *  Loop-safe: mirrored-in comments are excluded from push (by actor), and
 *  pulled ids are remembered so a re-sync is idempotent. No-op when the
 *  provider doesn't support comments. */
async function syncComments<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  secret: string,
  id: string,
): Promise<void> {
  if (!provider.listComments || !provider.addComment) return;
  const issue = await readIssue(root, id);
  const link = (issue.sync ?? []).find((s) => s.provider === provider.id);
  if (!link || link.externalId === PENDING_EXTERNAL_ID) return;

  const knownRemoteIds = new Set(link.syncedCommentIds ?? []);

  // ── PULL: mirror new remote comments into the activity log ──
  const remoteComments = await provider.listComments(config, secret, link.externalId);
  const newRemote = remoteComments.filter((c) => !knownRemoteIds.has(c.id));
  for (const c of newRemote) {
    const who = c.author
      ? `${SYNC_COMMENT_WHO_PREFIX}:${c.author}`
      : SYNC_COMMENT_WHO_PREFIX;
    await commentOnIssue(root, id, c.text, who);
    knownRemoteIds.add(c.id);
  }

  // ── PUSH: post local human/agent comments past the high-water mark ──
  // Re-read so the just-appended mirror comments are present; they're
  // sync-authored so they won't be pushed, but count only user-authored entries
  // for a stable high-water mark that survives re-parsing.
  const after = await readIssue(root, id);
  const userEntries = after.sections.activity.filter((a) => !isSyncAuthored(a.who));
  const pushed = link.pushedCommentCount ?? 0;
  const toPush = userEntries.slice(pushed);
  for (const entry of toPush) {
    await provider.addComment(config, secret, link.externalId, entry.message);
  }

  // Persist bookkeeping only when something moved, to avoid a noisy write.
  const newPushed = pushed + toPush.length;
  if (newRemote.length > 0 || toPush.length > 0) {
    const fresh =
      (await readIssue(root, id)).sync?.find((s) => s.provider === provider.id) ?? link;
    await setSyncLink(root, id, {
      ...fresh,
      syncedCommentIds: [...knownRemoteIds],
      pushedCommentCount: newPushed,
      syncedAt: new Date().toISOString(),
    });
  }
}
