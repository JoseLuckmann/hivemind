import { z } from "zod";

export const IssueStateZ = z.enum([
  "backlog",
  "todo",
  "in_progress",
  "in_review",
  "done",
  "cancelled",
]);
export type IssueState = z.infer<typeof IssueStateZ>;

export const AssigneeZ = z.object({
  type: z.enum(["agent", "member"]),
  id: z.string().min(1),
  model: z.string().optional(),
});
export type Assignee = z.infer<typeof AssigneeZ>;

/** ISO-8601 timestamp string (UTC). */
export const IsoZ = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/);

/** Full issue id incl. dotted sub-issues — `PAY-42`, `PAY-1.2.3`. The prefix
 *  (chars before `-`) names the workspace, so a full id is globally unique and
 *  is itself the cross-repo address — no extra repo qualifier needed. */
export const IssueIdZ = z.string().regex(/^[A-Z][A-Z0-9]{1,9}-\d+(\.\d+)*$/);

/** Relationship types for cross-repo (and intra-repo non-parent) links. Each
 *  has a reciprocal recorded on the other end (see `reciprocalLinkType`):
 *  blocks↔blocked-by, parent-of↔child-of, moved-to↔moved-from; relates &
 *  duplicates are symmetric. The `parent` frontmatter field stays the
 *  single-repo hierarchy; these links span repos and express softer links. */
export const LinkTypeZ = z.enum([
  "relates",
  "blocks",
  "blocked-by",
  "duplicates",
  "parent-of",
  "child-of",
  "moved-to",
  "moved-from",
]);
export type LinkType = z.infer<typeof LinkTypeZ>;

export const IssueLinkZ = z.object({
  /** Target issue id (may live in another workspace — resolve via registry). */
  id: IssueIdZ,
  type: LinkTypeZ.default("relates"),
});
export type IssueLink = z.infer<typeof IssueLinkZ>;

/** A link from this issue to its mirror in an external tracker (Azure DevOps,
 *  and later Jira/Google Tasks/etc.). The hivemind issue stays canonical —
 *  this is just enough state for the sync engine to find its remote
 *  counterpart and tell a real edit apart from its own last write. */
export const SyncLinkZ = z.object({
  /** Provider id, e.g. "azure-devops" — matches `SyncProvider.id`. */
  provider: z.string().min(1),
  /** The remote system's id for this item (Azure DevOps work item id). */
  externalId: z.string().min(1),
  /** Deep link back to the remote item, for UI. */
  url: z.string().optional(),
  /** Opaque remote revision/version marker (Azure's `System.Rev`) — cheap
   *  "did the remote side change" check without comparing full payloads. */
  remoteRev: z.string().optional(),
  /** Hash of the synced fields (title/description/acceptance criteria/state/
   *  labels) as of the last successful sync — "did a human change something
   *  sync cares about" without re-diffing full payloads. NOT `issue.updated`:
   *  that timestamp bumps on every write (including the engine's own pulls)
   *  and can collide at millisecond resolution between back-to-back writes,
   *  so it can't reliably distinguish "we just wrote this" from "a real edit
   *  landed in the same millisecond". A content hash has neither problem,
   *  and also ignores edits to fields sync doesn't touch (assignee, parent). */
  localFieldsHash: z.string().optional(),
  /** Provider-specific work item type this item is (Azure "Task"/"Bug"/...).
   *  Captured on pull/create so a later push (incl. a board state move) targets
   *  the type the item actually is — its board pattern — instead of the board's
   *  default type. Read as `link.workItemType`. */
  workItemType: z.string().optional(),
  /** Provider-specific area/board path (Azure `System.AreaPath`). Which board
   *  the item belongs to; carried so aggregated cross-board views and state
   *  moves respect the item's own board. */
  areaPath: z.string().optional(),
  /** The remote board's CURRENT state name (Azure `System.State`), as of the
   *  last sync. Display-only: the local Kanban `state` is decoupled from this
   *  (a task can be locally "done" while the remote is "in review"). The user
   *  moves the remote board explicitly; this shows where it currently sits. */
  remoteState: z.string().optional(),
  /** When this link was last successfully synced. */
  syncedAt: IsoZ.optional(),
});
export type SyncLink = z.infer<typeof SyncLinkZ>;

/** Sentinel `externalId` for a sync link that only stashes a desired work item
 *  type + area for an issue not yet pushed to the tracker (created via the UI
 *  with an explicit Area/Type). The sync engine treats such a link as "push as
 *  new, honoring this hint". Lives here (node-free) so both storage.ts and the
 *  sync engine can reference it without an import cycle. */
export const PENDING_EXTERNAL_ID = "__pending__";

/** YAML frontmatter schema for an issue file. */
export const IssueFrontmatterZ = z.object({
  id: IssueIdZ,
  title: z.string().min(1),
  state: IssueStateZ.default("backlog"),
  parent: z.string().nullable().default(null),
  labels: z.array(z.string()).default([]),
  assignee: AssigneeZ.nullable().default(null),
  github: z.number().int().positive().nullable().default(null),
  // Cross-repo / soft links. Optional (not `.default([])`) so existing issue
  // literals and on-disk files without the field stay valid without churn;
  // read it as `issue.links ?? []`.
  links: z.array(IssueLinkZ).optional(),
  // Links to mirrors in external trackers (Azure DevOps, ...). Same
  // optional-not-defaulted convention as `links` above; read as
  // `issue.sync ?? []`. At most one entry per `provider`.
  sync: z.array(SyncLinkZ).optional(),
  created: IsoZ,
  updated: IsoZ,
});
export type IssueFrontmatter = z.infer<typeof IssueFrontmatterZ>;

/** Body sections parsed out from the markdown. */
export interface IssueSections {
  description: string;
  acceptanceCriteria: AcceptanceItem[];
  activity: ActivityEntry[];
  /** Untouched body text for sections we don't model yet. */
  extra: string;
}

export interface AcceptanceItem {
  done: boolean;
  text: string;
}

export interface ActivityEntry {
  /** Always a parseable ISO-with-Z string after `parseActivity` normalization. */
  at: string;
  /** Raw on-disk timestamp form (legacy `YYYY-MM-DD HH:MM` or ISO). When set,
   *  the serializer round-trips it as-is so loading + re-writing an issue
   *  doesn't churn timestamp tokens across the file (would otherwise produce
   *  noisy diffs on the very first updateIssue after upgrade). */
  rawAt?: string;
  who: string; // user id or agent id
  message: string;
}

export interface Issue extends IssueFrontmatter {
  /** Absolute filesystem path of the issue file. */
  path: string;
  sections: IssueSections;
  /** Raw markdown body (everything after frontmatter). */
  raw: string;
}

/** Lightweight pre-parse view used for fast `list`. */
export interface IssueSummary
  extends Pick<
    IssueFrontmatter,
    | "id"
    | "title"
    | "state"
    | "parent"
    | "labels"
    | "assignee"
    | "github"
    | "sync"
    | "created"
    | "updated"
  > {
  path: string;
}

/** Partial update to an issue. The SINGLE source of truth for this shape — both
 *  core's updateIssue and the desktop IPC contract import it from here (it lives
 *  in types.ts, which is node-free, so the web bundle can use it without pulling
 *  storage.ts's node:fs deps). */
export type IssuePatch = Partial<{
  title: string;
  state: IssueSummary["state"];
  parent: string | null;
  labels: string[];
  assignee: Issue["assignee"];
  github: number | null;
  description: string;
  acceptanceCriteria: Issue["sections"]["acceptanceCriteria"];
  extra: string;
}>;

/** Non-secret sync settings for this board's ONE active external-tracker
 *  link (e.g. `{ providerId: "azure-devops", settings: { organization, project, ... } }`).
 *  `settings` is provider-shaped and validated by that provider's own zod
 *  schema (see `sync/types.ts`), not here — this stays provider-agnostic.
 *  The credential (PAT) is never stored here; see the desktop secret store. */
export const SyncConfigZ = z.object({
  providerId: z.string().min(1),
  settings: z.record(z.string(), z.unknown()),
});
export type SyncConfig = z.infer<typeof SyncConfigZ>;

export const ConfigZ = z.object({
  prefix: z.string().regex(/^[A-Z][A-Z0-9]{1,9}$/, "prefix must be UPPERCASE 2-10 chars"),
  next_id: z.number().int().positive(),
  agents: z
    .record(
      z.string(),
      z.object({
        bin: z.string(),
        model: z.string().optional(),
      })
    )
    .default({}),
  sync: SyncConfigZ.nullable().default(null),
});
export type Config = z.infer<typeof ConfigZ>;

/** Common JSON envelope used by all CLI commands when `--json` is passed. */
export type CliResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; code: string };
