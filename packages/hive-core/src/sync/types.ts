/**
 * External-tracker sync provider abstraction. A "sync provider" knows how to
 * talk to ONE external system (Azure DevOps now; Jira/Google Tasks later) —
 * the rest of the app (the engine, the CLI/desktop UI) stays provider-agnostic.
 * This mirrors the agent-CLI-provider pattern in
 * `apps/desktop/src/main/providers/{types,registry}.ts`: implement this
 * interface in one new file + register it in `registry.ts`, nothing else
 * changes.
 *
 * The hivemind `Issue` stays canonical. A provider only needs to translate
 * between its own remote shape and the handful of fields hivemind models
 * (title, description, state, labels) — it does NOT get to invent new
 * canonical fields. Anything provider-specific (work item type, area path,
 * a state-name map) lives in that provider's own `TConfig`.
 */
import type { Issue, IssueState } from "../types.js";

/** A remote item, already flattened to the fields hivemind understands. */
export interface RemoteItem {
  externalId: string;
  url: string;
  /** Opaque revision/version marker used for cheap change detection
   *  (Azure DevOps: `System.Rev`). */
  rev: string;
  title: string;
  description: string;
  state: string;
  labels: string[];
}

export interface PushResult {
  externalId: string;
  url: string;
  rev: string;
}

export interface ConnectionCheck {
  ok: boolean;
  error?: string;
}

export interface SyncProvider<TConfig = unknown> {
  /** Stable id, e.g. "azure-devops". Matches `SyncLink.provider` and the
   *  board's `Config.sync.providerId`. */
  id: string;
  /** Human label for UI, e.g. "Azure DevOps". */
  label: string;
  /** Validates + narrows a board's stored (non-secret) provider settings. */
  parseConfig(settings: unknown): TConfig;
  /** Verifies the config + secret actually work against the remote API. */
  testConnection(config: TConfig, secret: string): Promise<ConnectionCheck>;
  /** All remote items in this provider's configured scope (e.g. one Azure
   *  DevOps project + optional area path). */
  listRemoteItems(config: TConfig, secret: string): Promise<RemoteItem[]>;
  createRemoteItem(config: TConfig, secret: string, issue: Issue): Promise<PushResult>;
  updateRemoteItem(
    config: TConfig,
    secret: string,
    externalId: string,
    issue: Issue,
  ): Promise<PushResult>;
  /** Maps a remote item back onto the canonical fields hivemind owns. */
  toIssueFields(
    remote: RemoteItem,
    config: TConfig,
  ): { title: string; description: string; state: IssueState; labels: string[] };
}
