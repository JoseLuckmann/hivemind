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
import type { Issue, IssueState, IssueType } from "../types.js";

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
  /** The remote id of this item's PARENT work item (Azure hierarchy link), when
   *  it has one. Lets the engine reconstruct the Epic→Feature→Story tree locally
   *  by matching parents' externalIds to local issues. Undefined = top-level. */
  parentExternalId?: string;
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
  /** Whether a raw remote state name is TERMINAL (the item is closed/finished:
   *  Done / Closed / Resolved / Completed / Removed / …). Terminal remote states
   *  are the ONE case where the engine syncs remote → local state (a finished
   *  upstream item lands in the local Done/Cancelled column), overriding the
   *  usual decoupling. Non-terminal states stay decoupled (the local Kanban
   *  column is the user's to move). Optional: absent ⇒ the engine never forces a
   *  local state from the remote. */
  isTerminalRemoteState?(config: TConfig, remoteState: string): "done" | "cancelled" | null;
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
    /** Canonical hivemind type mapped from the remote work item type, or
     *  undefined when the remote type doesn't map to a known kind. */
    type?: IssueType;
  };

  // ── comments (optional; providers that support work-item comments) ────────
  /** Fetch the remote item's comments, oldest→newest. Each carries a stable
   *  remote `id` so the engine can tell which local activity entries have
   *  already been mirrored and avoid re-pulling them. Absent on providers with
   *  no comment concept. */
  listComments?(
    config: TConfig,
    secret: string,
    externalId: string,
  ): Promise<RemoteComment[]>;
  /** Post a new comment to the remote item. Returns the created comment's
   *  stable id so the engine can record it as already-synced. */
  addComment?(
    config: TConfig,
    secret: string,
    externalId: string,
    text: string,
  ): Promise<RemoteComment>;

  // ── board taxonomy (optional; for the New-issue Area/Team pickers) ────────
  /** List the area paths (boards) available in this provider's scope, so the
   *  New-issue modal can offer a dropdown instead of a free-text field. Flat
   *  list of full paths (Azure `System.AreaPath` values). Absent on providers
   *  with no area concept. */
  listAreas?(config: TConfig, secret: string): Promise<RemoteTaxonomyNode[]>;
  /** List the teams the authenticated user can see in this project — used to
   *  scope/label the area picker (an Azure team maps to a default area). */
  listTeams?(config: TConfig, secret: string): Promise<RemoteTaxonomyNode[]>;
}

/** A remote board-taxonomy node (an Azure area path or team), flattened for the
 *  UI pickers. `path` is the value stamped onto the issue (the full area path);
 *  `name` is the human label. */
export interface RemoteTaxonomyNode {
  /** The value to store (Azure full area path, e.g. "Proj\\Team\\Sub"). */
  path: string;
  /** Short display name (the leaf, or the team name). */
  name: string;
}

/** A remote work-item comment, flattened to what the engine needs to mirror it
 *  into (and out of) the local activity log without loops. */
export interface RemoteComment {
  /** Stable remote comment id (Azure comment id). */
  id: string;
  /** Comment body as plain text. */
  text: string;
  /** Author display name / email, for the activity `who`. */
  author?: string;
  /** ISO timestamp of when it was posted, if the provider reports it. */
  createdAt?: string;
}
