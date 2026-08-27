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
  /** Remote assignee's stable identity (Azure: `System.AssignedTo.uniqueName`,
   *  usually the user's email/UPN). Empty/undefined when unassigned. Lets the
   *  board default to "my tasks" without inventing a canonical identity field. */
  assignedTo?: string;
  /** Human display name for the assignee, for UI (Azure: `.displayName`). */
  assignedToName?: string;
  /** Provider-specific work item type — e.g. Azure "Task"/"Bug"/"User Story".
   *  Carried so the board can filter by type and so pushes/state-moves target
   *  the type the item actually is (its "board pattern"). */
  workItemType?: string;
  /** Provider-specific area/board path (Azure: `System.AreaPath`). The board an
   *  item belongs to; a state move must respect the pattern of THIS area. */
  areaPath?: string;
}

export interface PushResult {
  externalId: string;
  url: string;
  rev: string;
  /** The provider work item type + area the pushed item now is, so the engine
   *  can remember them on the sync link and target them on the next push. */
  workItemType?: string;
  areaPath?: string;
  /** The remote board's state name after the push — recorded on the link for
   *  display (the local Kanban state is independent). */
  remoteState?: string;
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
  /** Create a remote item. `hint` carries the specific work item type + area
   *  the caller wants (e.g. chosen in the New-issue modal, or remembered from a
   *  prior sync link) — the provider falls back to its config default when a
   *  field is absent. */
  createRemoteItem(
    config: TConfig,
    secret: string,
    issue: Issue,
    hint?: { workItemType?: string; areaPath?: string },
  ): Promise<PushResult>;
  updateRemoteItem(
    config: TConfig,
    secret: string,
    externalId: string,
    issue: Issue,
    hint?: { workItemType?: string; areaPath?: string },
  ): Promise<PushResult>;
  /** Move the remote item to a specific remote STATE (board column), by its
   *  hivemind state — mapped to the provider's own state name. This is the ONLY
   *  path that changes remote state: routine field sync leaves it alone, since
   *  the local Kanban state is decoupled from the remote board. Returns the
   *  fresh rev + the applied remote state name. */
  setRemoteState(
    config: TConfig,
    secret: string,
    externalId: string,
    state: IssueState,
  ): Promise<PushResult>;
  /** The provider's ordered list of remote state names for a given work item
   *  type (fallback to a generic list) — powers the "move on the remote board"
   *  picker. Best-effort: may return the configured state map's values. */
  remoteStates?(config: TConfig, workItemType?: string): string[];
  /** Maps a remote item back onto the canonical fields hivemind owns. `assignee`
   *  is the remote assignee's stable id (email/UPN) or null when unassigned —
   *  the engine turns it into a `member` assignee so the board can default to
   *  "my tasks". */
  toIssueFields(
    remote: RemoteItem,
    config: TConfig,
  ): {
    title: string;
    description: string;
    state: IssueState;
    labels: string[];
    assignee?: string | null;
  };
}
