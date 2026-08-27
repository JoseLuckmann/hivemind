/**
 * Azure DevOps sync provider. Talks to the Azure DevOps REST API (work items
 * + WIQL) directly over `fetch` — no SDK dependency. Auth is Basic with an
 * empty username and a Personal Access Token as the password, exactly what
 * Azure DevOps expects for PAT auth.
 *
 * Field mapping is intentionally the only place that knows Azure's field
 * names — the rest of the sync engine only ever sees `RemoteItem` /
 * canonical `Issue` fields (see ./types.ts).
 */
import { z } from "zod";
import type { Issue, IssueState } from "../types.js";
import type { PushResult, RemoteItem, SyncProvider } from "./types.js";

const API_VERSION = "7.1";

const AzureConfigZ = z.object({
  organization: z.string().min(1),
  project: z.string().min(1),
  /** Restrict sync to work items under this area path. Omit for the whole project. */
  areaPath: z.string().optional(),
  /** Work item types to pull. When more than one, the board aggregates every
   *  type that matches (Task + Bug + User Story + …) instead of a single kind.
   *  The FIRST entry is the default type used when creating a new item without
   *  an explicit type. Back-compat: a legacy single `workItemType` string is
   *  normalised into this array by `parseConfig`. */
  workItemTypes: z.array(z.string().min(1)).min(1).default(["Task"]),
  /** Legacy single-type field. Kept only so old stored configs parse; migrated
   *  into `workItemTypes` in `parseConfig`. Prefer `workItemTypes`. */
  workItemType: z.string().min(1).optional(),
  /** When set, restrict the pull to items assigned to this user (their Azure
   *  UPN/email). Powers the "only my tasks" default. Omit to pull everyone's. */
  assignedTo: z.string().optional(),
  /** Override the default hivemind-state ↔ Azure-state-name mapping — Azure's
   *  actual state names depend on the org's process template. */
  stateMap: z.record(z.string(), z.string()).optional(),
});
export type AzureDevOpsConfig = z.infer<typeof AzureConfigZ>;

/** The default work item type — the first configured type. Used when creating
 *  an item that doesn't carry its own type from a prior sync link. */
function defaultTypeFor(config: AzureDevOpsConfig): string {
  return config.workItemTypes[0] ?? "Task";
}

/** Default state names — a reasonable guess, not universal (Agile/Scrum/CMMI/
 *  Basic processes all name states differently). Override via `stateMap`. */
const DEFAULT_STATE_MAP: Record<IssueState, string> = {
  backlog: "New",
  todo: "To Do",
  in_progress: "Doing",
  in_review: "In Review",
  done: "Done",
  cancelled: "Removed",
};

function stateMapFor(config: AzureDevOpsConfig): Record<IssueState, string> {
  return { ...DEFAULT_STATE_MAP, ...(config.stateMap as Partial<Record<IssueState, string>>) };
}

function reverseStateMapFor(config: AzureDevOpsConfig): Record<string, IssueState> {
  const out: Record<string, IssueState> = {};
  for (const [k, v] of Object.entries(stateMapFor(config))) out[v] = k as IssueState;
  return out;
}

function authHeader(secret: string): string {
  return `Basic ${Buffer.from(`:${secret}`).toString("base64")}`;
}

async function azureFetch(
  url: string,
  secret: string,
  init?: { method?: string; body?: unknown; contentType?: string },
): Promise<unknown> {
  const res = await fetch(url, {
    method: init?.method ?? "GET",
    headers: {
      Authorization: authHeader(secret),
      "Content-Type": init?.contentType ?? "application/json",
    },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined,
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Azure DevOps ${res.status}: ${text.slice(0, 500)}`);
  }
  return text ? JSON.parse(text) : {};
}

function workItemUrl(config: AzureDevOpsConfig, id: string): string {
  return `https://dev.azure.com/${encodeURIComponent(config.organization)}/${encodeURIComponent(config.project)}/_workitems/edit/${id}`;
}

// ── field mapping ─────────────────────────────────────────────────

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

/** hivemind description + acceptance criteria → Azure's single rich-text
 *  System.Description. Acceptance criteria don't get their own field: Azure's
 *  dedicated AcceptanceCriteria field only exists on some work item types
 *  (backlog items, not tasks), so folding into the description works
 *  regardless of type. */
function buildDescriptionHtml(issue: Issue): string {
  const body = escapeHtml(issue.sections.description).replace(/\n/g, "<br>");
  const items = issue.sections.acceptanceCriteria;
  if (items.length === 0) return body;
  const list = items
    .map((it) => `<li>[${it.done ? "x" : " "}] ${escapeHtml(it.text)}</li>`)
    .join("");
  return `${body}<br><br><b>Acceptance Criteria</b><ul>${list}</ul>`;
}

/** Best-effort HTML → plain text for pulling a remote description in. Doesn't
 *  try to recover a structured acceptance-criteria list — remote-authored
 *  items land with an empty checklist and everything in `description`. */
function htmlToText(html: string): string {
  return html
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function fieldsToRemoteItem(config: AzureDevOpsConfig, item: AzureWorkItem): RemoteItem {
  const f = item.fields;
  const tags = typeof f["System.Tags"] === "string" ? f["System.Tags"] : "";
  // System.AssignedTo is an identity object ({ displayName, uniqueName, ... })
  // on modern APIs; older payloads sometimes send a bare "Name <email>" string.
  const assigned = f["System.AssignedTo"];
  let assignedTo: string | undefined;
  let assignedToName: string | undefined;
  if (assigned && typeof assigned === "object") {
    const a = assigned as { uniqueName?: unknown; displayName?: unknown };
    assignedTo = typeof a.uniqueName === "string" ? a.uniqueName : undefined;
    assignedToName = typeof a.displayName === "string" ? a.displayName : undefined;
  } else if (typeof assigned === "string" && assigned) {
    const m = assigned.match(/<([^>]+)>/);
    assignedTo = m ? m[1] : assigned;
    assignedToName = assigned.replace(/\s*<[^>]+>/, "").trim() || undefined;
  }
  return {
    externalId: String(item.id),
    url: workItemUrl(config, String(item.id)),
    rev: String(item.rev),
    title: typeof f["System.Title"] === "string" ? f["System.Title"] : "",
    description: typeof f["System.Description"] === "string" ? f["System.Description"] : "",
    state: typeof f["System.State"] === "string" ? f["System.State"] : "",
    labels: tags
      .split(";")
      .map((t) => t.trim())
      .filter(Boolean),
    assignedTo,
    assignedToName,
    workItemType: typeof f["System.WorkItemType"] === "string" ? f["System.WorkItemType"] : undefined,
    areaPath: typeof f["System.AreaPath"] === "string" ? f["System.AreaPath"] : undefined,
  };
}

function buildPatch(
  config: AzureDevOpsConfig,
  issue: Issue,
  hint?: { areaPath?: string },
): Record<string, unknown>[] {
  // NOTE: intentionally does NOT set System.State. The local Kanban state is
  // decoupled from the remote board (a task can be locally "done" while it's
  // still "in review" in Azure), so a routine field push must leave the remote
  // state alone. Moving the remote board is an explicit, separate action
  // (`setRemoteState`).
  const patch: Record<string, unknown>[] = [
    { op: "add", path: "/fields/System.Title", value: issue.title },
    { op: "add", path: "/fields/System.Description", value: buildDescriptionHtml(issue) },
    { op: "add", path: "/fields/System.Tags", value: issue.labels.join("; ") },
  ];
  // Assign the area (board) explicitly when the caller knows it — either the
  // item's remembered area (so it stays on its own board) or the area chosen at
  // create time. Falls back to the config's default area.
  const area = hint?.areaPath ?? config.areaPath;
  if (area) patch.push({ op: "add", path: "/fields/System.AreaPath", value: area });
  return patch;
}

interface AzureWorkItem {
  id: number;
  rev: number;
  url: string;
  fields: Record<string, unknown>;
}

// ── provider ──────────────────────────────────────────────────────

export const azureDevOpsProvider: SyncProvider<AzureDevOpsConfig> = {
  id: "azure-devops",
  label: "Azure DevOps",

  parseConfig(settings) {
    // Migrate a legacy single `workItemType` into `workItemTypes` before
    // validating, so configs saved by older versions keep working.
    const raw = (settings ?? {}) as Record<string, unknown>;
    if (
      !Array.isArray(raw.workItemTypes) &&
      typeof raw.workItemType === "string" &&
      raw.workItemType
    ) {
      raw.workItemTypes = [raw.workItemType];
    }
    return AzureConfigZ.parse(raw);
  },

  async testConnection(config, secret) {
    try {
      await azureFetch(
        `https://dev.azure.com/${encodeURIComponent(config.organization)}/_apis/projects/${encodeURIComponent(config.project)}?api-version=${API_VERSION}`,
        secret,
      );
      return { ok: true };
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : String(e) };
    }
  },

  async listRemoteItems(config, secret) {
    const org = encodeURIComponent(config.organization);
    const project = encodeURIComponent(config.project);
    // Query EVERY configured work item type in one shot (Task, Bug, User Story,
    // …) so a single board can aggregate all of my item kinds. An IN (...) list
    // keeps it to one round-trip; assignedTo narrows to "my tasks" when set.
    const typeList = config.workItemTypes
      .map((t) => `'${t.replace(/'/g, "''")}'`)
      .join(", ");
    const wiql = [
      "SELECT [System.Id] FROM WorkItems",
      `WHERE [System.TeamProject] = '${config.project.replace(/'/g, "''")}'`,
      `AND [System.WorkItemType] IN (${typeList})`,
      config.assignedTo ? `AND [System.AssignedTo] = '${config.assignedTo.replace(/'/g, "''")}'` : "",
      config.areaPath ? `AND [System.AreaPath] UNDER '${config.areaPath.replace(/'/g, "''")}'` : "",
      "ORDER BY [System.ChangedDate] DESC",
    ]
      .filter(Boolean)
      .join(" ");

    const wiqlResult = (await azureFetch(
      `https://dev.azure.com/${org}/${project}/_apis/wit/wiql?api-version=${API_VERSION}`,
      secret,
      { method: "POST", body: { query: wiql } },
    )) as { workItems: { id: number }[] };
    const ids = wiqlResult.workItems.map((w) => w.id);
    if (ids.length === 0) return [];

    const items: AzureWorkItem[] = [];
    const BATCH = 200; // Azure's per-request id limit
    const FIELDS =
      "System.Title,System.Description,System.State,System.Tags,System.AssignedTo,System.WorkItemType,System.AreaPath";
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const batch = (await azureFetch(
        `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=${FIELDS}&api-version=${API_VERSION}`,
        secret,
      )) as { value: AzureWorkItem[] };
      items.push(...batch.value);
    }
    return items.map((item) => fieldsToRemoteItem(config, item));
  },

  async createRemoteItem(config, secret, issue, hint): Promise<PushResult> {
    const org = encodeURIComponent(config.organization);
    const project = encodeURIComponent(config.project);
    const wtype = hint?.workItemType || defaultTypeFor(config);
    const type = encodeURIComponent(wtype);
    const created = (await azureFetch(
      `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$${type}?api-version=${API_VERSION}`,
      secret,
      { method: "POST", body: buildPatch(config, issue, hint), contentType: "application/json-patch+json" },
    )) as AzureWorkItem;
    return {
      externalId: String(created.id),
      url: workItemUrl(config, String(created.id)),
      rev: String(created.rev),
      workItemType: typeof created.fields?.["System.WorkItemType"] === "string"
        ? (created.fields["System.WorkItemType"] as string)
        : wtype,
      areaPath: typeof created.fields?.["System.AreaPath"] === "string"
        ? (created.fields["System.AreaPath"] as string)
        : hint?.areaPath ?? config.areaPath,
      remoteState: typeof created.fields?.["System.State"] === "string"
        ? (created.fields["System.State"] as string)
        : undefined,
    };
  },

  async updateRemoteItem(config, secret, externalId, issue, hint): Promise<PushResult> {
    const org = encodeURIComponent(config.organization);
    const updated = (await azureFetch(
      `https://dev.azure.com/${org}/_apis/wit/workitems/${externalId}?api-version=${API_VERSION}`,
      secret,
      { method: "PATCH", body: buildPatch(config, issue, hint), contentType: "application/json-patch+json" },
    )) as AzureWorkItem;
    return {
      externalId: String(updated.id),
      url: workItemUrl(config, String(updated.id)),
      rev: String(updated.rev),
      workItemType: typeof updated.fields?.["System.WorkItemType"] === "string"
        ? (updated.fields["System.WorkItemType"] as string)
        : hint?.workItemType,
      areaPath: typeof updated.fields?.["System.AreaPath"] === "string"
        ? (updated.fields["System.AreaPath"] as string)
        : hint?.areaPath,
      remoteState: typeof updated.fields?.["System.State"] === "string"
        ? (updated.fields["System.State"] as string)
        : undefined,
    };
  },

  async setRemoteState(config, secret, externalId, state): Promise<PushResult> {
    const org = encodeURIComponent(config.organization);
    const stateName = stateMapFor(config)[state];
    // PATCH ONLY System.State — this is an explicit remote board move, kept
    // separate from field sync so it never rides along with a routine push.
    const updated = (await azureFetch(
      `https://dev.azure.com/${org}/_apis/wit/workitems/${externalId}?api-version=${API_VERSION}`,
      secret,
      {
        method: "PATCH",
        body: [{ op: "add", path: "/fields/System.State", value: stateName }],
        contentType: "application/json-patch+json",
      },
    )) as AzureWorkItem;
    return {
      externalId: String(updated.id),
      url: workItemUrl(config, String(updated.id)),
      rev: String(updated.rev),
      remoteState: typeof updated.fields?.["System.State"] === "string"
        ? (updated.fields["System.State"] as string)
        : stateName,
    };
  },

  remoteStates(config) {
    // The configured (or default) state map's values, in canonical hivemind
    // order — a reasonable, process-agnostic picker. Deduped, blanks dropped.
    const map = stateMapFor(config);
    const order: IssueState[] = ["backlog", "todo", "in_progress", "in_review", "done", "cancelled"];
    const seen = new Set<string>();
    const out: string[] = [];
    for (const s of order) {
      const name = map[s];
      if (name && !seen.has(name)) { seen.add(name); out.push(name); }
    }
    return out;
  },

  toIssueFields(remote, config) {
    const reverse = reverseStateMapFor(config);
    return {
      title: remote.title,
      description: htmlToText(remote.description),
      state: reverse[remote.state] ?? "backlog",
      labels: remote.labels,
      assignee: remote.assignedTo ?? null,
    };
  },
};
