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
import type { RemoteItem, SyncProvider } from "./types.js";

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
  errors: SyncError[];
}

function hashSyncFields(issue: Issue): string {
  return createHash("sha1")
    .update(
      JSON.stringify({
        title: issue.title,
        description: issue.sections.description,
        acceptanceCriteria: issue.sections.acceptanceCriteria,
        state: issue.state,
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
  const report: SyncReport = { pushed: 0, pulled: 0, created: 0, errors: [] };

  let remoteItems: RemoteItem[];
  try {
    remoteItems = await provider.listRemoteItems(config, secret);
  } catch (e) {
    report.errors.push({ message: `listing ${provider.label} items: ${errMsg(e)}` });
    return report;
  }
  const remoteById = new Map(remoteItems.map((r) => [r.externalId, r]));
  const matchedRemoteIds = new Set<string>();

  const summaries = await listIssues(root);
  for (const summary of summaries) {
    const link = linkFor(summary, provider.id);
    try {
      if (!link) {
        await pushNew(root, provider, config, secret, summary.id);
        report.pushed++;
        continue;
      }

      const remote = remoteById.get(link.externalId);
      if (!remote) continue; // deleted upstream — no delete propagation
      matchedRemoteIds.add(link.externalId);

      const issue = await readIssue(root, summary.id);
      const remoteChanged = remote.rev !== link.remoteRev;
      const localChanged = hashSyncFields(issue) !== link.localFieldsHash;
      if (!remoteChanged && !localChanged) continue; // nothing to do

      if (remoteChanged && !localChanged) {
        await pull(root, provider, config, summary.id, remote);
        report.pulled++;
      } else {
        // Local changed, or both did — local is canonical.
        await push(root, provider, config, secret, issue, link.externalId);
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

function linkFor(summary: IssueSummary, providerId: string) {
  return (summary.sync ?? []).find((s) => s.provider === providerId);
}

async function pushNew<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  secret: string,
  id: string,
): Promise<void> {
  const issue = await readIssue(root, id);
  const result = await provider.createRemoteItem(config, secret, issue);
  await setSyncLink(root, id, {
    provider: provider.id,
    externalId: result.externalId,
    url: result.url,
    remoteRev: result.rev,
    localFieldsHash: hashSyncFields(issue),
    syncedAt: new Date().toISOString(),
  });
}

async function push<TConfig>(
  root: string,
  provider: SyncProvider<TConfig>,
  config: TConfig,
  secret: string,
  issue: Issue,
  externalId: string,
): Promise<void> {
  const result = await provider.updateRemoteItem(config, secret, externalId, issue);
  await setSyncLink(root, issue.id, {
    provider: provider.id,
    externalId: result.externalId,
    url: result.url,
    remoteRev: result.rev,
    localFieldsHash: hashSyncFields(issue),
    syncedAt: new Date().toISOString(),
  });
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
    fields,
    "sync",
    `pulled from ${provider.label} #${remote.externalId}`,
  );
  await setSyncLink(root, id, {
    provider: provider.id,
    externalId: remote.externalId,
    url: remote.url,
    remoteRev: remote.rev,
    localFieldsHash: hashSyncFields(updated),
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
  const issue = await createIssue(root, { ...fields, who: "sync" });
  await setSyncLink(root, issue.id, {
    provider: provider.id,
    externalId: remote.externalId,
    url: remote.url,
    remoteRev: remote.rev,
    localFieldsHash: hashSyncFields(issue),
    syncedAt: new Date().toISOString(),
  });
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}
