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
  /** Work item type used both to query existing items and to create new ones. */
  workItemType: z.string().min(1).default("Task"),
  /** Override the default hivemind-state ↔ Azure-state-name mapping — Azure's
   *  actual state names depend on the org's process template. */
  stateMap: z.record(z.string(), z.string()).optional(),
});
export type AzureDevOpsConfig = z.infer<typeof AzureConfigZ>;

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
  };
}

function buildPatch(config: AzureDevOpsConfig, issue: Issue): Record<string, unknown>[] {
  const stateMap = stateMapFor(config);
  return [
    { op: "add", path: "/fields/System.Title", value: issue.title },
    { op: "add", path: "/fields/System.Description", value: buildDescriptionHtml(issue) },
    { op: "add", path: "/fields/System.State", value: stateMap[issue.state] },
    { op: "add", path: "/fields/System.Tags", value: issue.labels.join("; ") },
  ];
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
    return AzureConfigZ.parse(settings);
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
    const wiql = [
      "SELECT [System.Id] FROM WorkItems",
      `WHERE [System.TeamProject] = '${config.project.replace(/'/g, "''")}'`,
      `AND [System.WorkItemType] = '${config.workItemType.replace(/'/g, "''")}'`,
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
    for (let i = 0; i < ids.length; i += BATCH) {
      const chunk = ids.slice(i, i + BATCH);
      const batch = (await azureFetch(
        `https://dev.azure.com/${org}/_apis/wit/workitems?ids=${chunk.join(",")}&fields=System.Title,System.Description,System.State,System.Tags&api-version=${API_VERSION}`,
        secret,
      )) as { value: AzureWorkItem[] };
      items.push(...batch.value);
    }
    return items.map((item) => fieldsToRemoteItem(config, item));
  },

  async createRemoteItem(config, secret, issue): Promise<PushResult> {
    const org = encodeURIComponent(config.organization);
    const project = encodeURIComponent(config.project);
    const type = encodeURIComponent(config.workItemType);
    const created = (await azureFetch(
      `https://dev.azure.com/${org}/${project}/_apis/wit/workitems/$${type}?api-version=${API_VERSION}`,
      secret,
      { method: "POST", body: buildPatch(config, issue), contentType: "application/json-patch+json" },
    )) as AzureWorkItem;
    return {
      externalId: String(created.id),
      url: workItemUrl(config, String(created.id)),
      rev: String(created.rev),
    };
  },

  async updateRemoteItem(config, secret, externalId, issue): Promise<PushResult> {
    const org = encodeURIComponent(config.organization);
    const updated = (await azureFetch(
      `https://dev.azure.com/${org}/_apis/wit/workitems/${externalId}?api-version=${API_VERSION}`,
      secret,
      { method: "PATCH", body: buildPatch(config, issue), contentType: "application/json-patch+json" },
    )) as AzureWorkItem;
    return {
      externalId: String(updated.id),
      url: workItemUrl(config, String(updated.id)),
      rev: String(updated.rev),
    };
  },

  toIssueFields(remote, config) {
    const reverse = reverseStateMapFor(config);
    return {
      title: remote.title,
      description: htmlToText(remote.description),
      state: reverse[remote.state] ?? "backlog",
      labels: remote.labels,
    };
  },
};
