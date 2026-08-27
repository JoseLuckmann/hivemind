import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createIssue, listIssues, readIssue, updateIssue, commentOnIssue, writeConfig } from "../storage.js";
import type { Issue, IssueState } from "../types.js";
import { PENDING_EXTERNAL_ID } from "../types.js";
import { runSync, setRemoteState } from "./engine.js";
import type { PushResult, RemoteItem, SyncProvider } from "./types.js";

async function mkRoot(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hive-sync-test-"));
  const root = path.join(dir, ".hivemind");
  await fs.mkdir(path.join(root, "issues"), { recursive: true });
  await writeConfig(root, { prefix: "PAY", next_id: 1, agents: {} });
  return root;
}

interface FakeRemote {
  rev: number;
  title: string;
  description: string;
  state: string;
  labels: string[];
  parentExternalId?: string;
}

/** An in-memory `SyncProvider` — exercises the engine's push/pull/conflict
 *  logic without touching a real Azure DevOps org. State names mirror Azure's
 *  ("New"/"Doing"/…) so the state-decoupling behavior is exercised realistically. */
function makeFakeProvider() {
  const db = new Map<string, FakeRemote>();
  // Per-item comment log: externalId → list of { id, text, author }.
  const comments = new Map<string, { id: string; text: string; author?: string }[]>();
  let nextId = 1;
  let nextCommentId = 1;

  const STATE_MAP: Record<IssueState, string> = {
    backlog: "New",
    todo: "To Do",
    in_progress: "Doing",
    in_review: "In Review",
    done: "Done",
    cancelled: "Removed",
  };
  const REVERSE: Record<string, IssueState> = Object.fromEntries(
    Object.entries(STATE_MAP).map(([k, v]) => [v, k as IssueState]),
  );

  function toRemoteItem(id: string, r: FakeRemote): RemoteItem {
    return {
      externalId: id,
      url: `fake://${id}`,
      rev: String(r.rev),
      title: r.title,
      description: r.description,
      state: r.state,
      labels: r.labels,
      parentExternalId: r.parentExternalId,
    };
  }

  const provider: SyncProvider<Record<string, never>> = {
    id: "fake",
    label: "Fake",
    parseConfig: () => ({}),
    async testConnection() {
      return { ok: true };
    },
    async listRemoteItems() {
      return [...db.entries()].map(([id, r]) => toRemoteItem(id, r));
    },
    async createRemoteItem(_config, _secret, issue: Issue): Promise<PushResult> {
      const id = String(nextId++);
      // A brand-new remote item defaults to the "New" backlog column — creation
      // never carries the local state (decoupled).
      db.set(id, {
        rev: 1,
        title: issue.title,
        description: issue.sections.description,
        state: "New",
        labels: issue.labels,
      });
      return { externalId: id, url: `fake://${id}`, rev: "1", remoteState: "New" };
    },
    async updateRemoteItem(_config, _secret, externalId: string, issue: Issue): Promise<PushResult> {
      const cur = db.get(externalId);
      if (!cur) throw new Error(`fake remote item ${externalId} not found`);
      const rev = cur.rev + 1;
      // NB: state is preserved (not overwritten from the local issue) — the
      // engine must not push local state on a field update.
      db.set(externalId, {
        rev,
        title: issue.title,
        description: issue.sections.description,
        state: cur.state,
        labels: issue.labels,
      });
      return { externalId, url: `fake://${externalId}`, rev: String(rev), remoteState: cur.state };
    },
    async setRemoteState(_config, _secret, externalId: string, state: IssueState): Promise<PushResult> {
      const cur = db.get(externalId);
      if (!cur) throw new Error(`fake remote item ${externalId} not found`);
      const rev = cur.rev + 1;
      const name = STATE_MAP[state];
      db.set(externalId, { ...cur, rev, state: name });
      return { externalId, url: `fake://${externalId}`, rev: String(rev), remoteState: name };
    },
    toIssueFields(remote: RemoteItem) {
      return {
        title: remote.title,
        description: remote.description,
        state: REVERSE[remote.state] ?? "backlog",
        labels: remote.labels,
      };
    },
    async listComments(_config, _secret, externalId: string) {
      return (comments.get(externalId) ?? []).map((c) => ({ id: c.id, text: c.text, author: c.author }));
    },
    async addComment(_config, _secret, externalId: string, text: string) {
      const id = `c${nextCommentId++}`;
      const list = comments.get(externalId) ?? [];
      list.push({ id, text, author: "remote-user" });
      comments.set(externalId, list);
      return { id, text, author: "remote-user" };
    },
  };

  return { provider, db, comments };
}

describe("runSync", () => {
  test("does NOT auto-create an unlinked local issue upstream (opt-in only)", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    await createIssue(root, { title: "Local only", description: "desc" });

    const report = await runSync(root, provider, {}, "secret");

    // The local-only issue is skipped, NOT pushed — no duplicate created in Azure.
    expect(report).toEqual({ pushed: 0, pulled: 0, created: 0, skippedLocalOnly: 1, errors: [] });
    expect(db.size).toBe(0);
  });

  test("pushes a local issue explicitly marked for creation (pending link)", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    const issue = await createIssue(root, {
      title: "New task",
      description: "desc",
      sync: { provider: "fake", workItemType: "Bug", areaPath: "Proj\\Team" },
    });

    const report = await runSync(root, provider, {}, "secret");

    expect(report).toEqual({ pushed: 1, pulled: 0, created: 0, skippedLocalOnly: 0, errors: [] });
    expect(db.size).toBe(1);
    const [[externalId, remote]] = db.entries();
    expect(remote.title).toBe("New task");

    const synced = await readIssue(root, issue.id);
    expect(synced.sync).toEqual([
      expect.objectContaining({ provider: "fake", externalId, remoteRev: "1" }),
    ]);
    // The pending sentinel was replaced with the real external id.
    expect(synced.sync?.[0]?.externalId).not.toBe(PENDING_EXTERNAL_ID);
  });

  test("a pending create ADOPTS an existing remote twin by title (dedupe)", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    // Simulate a prior partial run: the remote already has this item.
    db.set("500", { rev: 3, title: "Dup task", description: "x", state: "Doing", labels: [] });

    const issue = await createIssue(root, {
      title: "Dup task",
      description: "x",
      sync: { provider: "fake" },
    });

    const report = await runSync(root, provider, {}, "secret");

    // Adopted (pushed count), NOT created — the db still has exactly one item.
    expect(report).toEqual({ pushed: 1, pulled: 0, created: 0, skippedLocalOnly: 0, errors: [] });
    expect(db.size).toBe(1);
    const synced = await readIssue(root, issue.id);
    expect(synced.sync?.[0]?.externalId).toBe("500");
    expect(synced.sync?.[0]?.remoteState).toBe("Doing");
  });

  test("creates a local issue for an unmatched remote item", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    db.set("100", {
      rev: 1,
      title: "From Azure",
      description: "remote desc",
      state: "To Do",
      labels: ["urgent"],
    });

    const report = await runSync(root, provider, {}, "secret");

    expect(report).toEqual({ pushed: 0, pulled: 0, created: 1, skippedLocalOnly: 0, errors: [] });
    const list = await listIssues(root);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("From Azure");
    expect(list[0]?.sync?.[0]).toEqual(
      expect.objectContaining({ provider: "fake", externalId: "100", remoteRev: "1", remoteState: "To Do" }),
    );
  });

  test("second run with no changes is a no-op", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    // A remote-only item so there IS a linked issue after the first run.
    db.set("7", { rev: 1, title: "Stable", description: "", state: "New", labels: [] });
    await runSync(root, provider, {}, "secret");

    const report = await runSync(root, provider, {}, "secret");
    expect(report).toEqual({ pushed: 0, pulled: 0, created: 0, skippedLocalOnly: 0, errors: [] });
  });

  test("pulls a remote-only field change but NEVER overwrites local state", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    db.set("9", { rev: 1, title: "Original", description: "", state: "New", labels: [] });
    await runSync(root, provider, {}, "secret");
    const [issue] = await listIssues(root);
    const id = issue!.id;

    // Move the issue locally to done; then Azure changes title AND its own state.
    await updateIssue(root, id, { state: "done" });
    db.set("9", { rev: 2, title: "Edited on Azure", description: "", state: "In Review", labels: [] });

    const report = await runSync(root, provider, {}, "secret");
    expect(report.pulled).toBe(1);
    const updated = await readIssue(root, id);
    expect(updated.title).toBe("Edited on Azure"); // field pulled
    expect(updated.state).toBe("done"); // local state UNCHANGED by the remote "In Review"
    // Remote state recorded for display.
    expect(updated.sync?.[0]?.remoteState).toBe("In Review");
  });

  test("a local field change pushes fields but NOT state", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    db.set("11", { rev: 1, title: "Original", description: "", state: "Doing", labels: [] });
    await runSync(root, provider, {}, "secret");
    const [issue] = await listIssues(root);
    const id = issue!.id;

    // Local: edit title AND move column to done.
    await updateIssue(root, id, { title: "Local edit", state: "done" });

    const report = await runSync(root, provider, {}, "secret");
    expect(report.pushed).toBe(1);
    // Title pushed, but the remote state stayed "Doing" (local state not pushed).
    expect(db.get("11")?.title).toBe("Local edit");
    expect(db.get("11")?.state).toBe("Doing");
  });
});

describe("setRemoteState", () => {
  test("moves the remote board explicitly, leaving local state alone", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    db.set("21", { rev: 1, title: "Task", description: "", state: "New", labels: [] });
    await runSync(root, provider, {}, "secret");
    const [issue] = await listIssues(root);
    const id = issue!.id;
    // Local column is "backlog" (pulled default); move it locally to done first.
    await updateIssue(root, id, { state: "done" });

    await setRemoteState(root, provider, {}, "secret", id, "in_review");

    // Remote moved to "In Review"; local stays "done".
    expect(db.get("21")?.state).toBe("In Review");
    const after = await readIssue(root, id);
    expect(after.state).toBe("done");
    expect(after.sync?.[0]?.remoteState).toBe("In Review");
  });

  test("refuses to move a not-yet-linked (pending) issue", async () => {
    const root = await mkRoot();
    const { provider } = makeFakeProvider();
    const issue = await createIssue(root, { title: "Pending", sync: { provider: "fake" } });
    await expect(setRemoteState(root, provider, {}, "secret", issue.id, "done")).rejects.toThrow();
  });
});

describe("comment sync", () => {
  test("pushes local comments to the remote and pulls remote comments in", async () => {
    const root = await mkRoot();
    const { provider, db, comments } = makeFakeProvider();
    // A linked issue (created from a remote item).
    db.set("30", { rev: 1, title: "Commented", description: "", state: "New", labels: [] });
    await runSync(root, provider, {}, "secret");
    const [issue] = await listIssues(root);
    const id = issue!.id;

    // A human adds a local comment; the remote gets an independent comment.
    await commentOnIssue(root, id, "my local progress note", "ui");
    comments.set("30", [{ id: "r1", text: "azure side comment", author: "PM" }]);

    await runSync(root, provider, {}, "secret");

    // PUSH: the local comment reached the remote (plus its own author tag).
    const remoteTexts = (comments.get("30") ?? []).map((c) => c.text);
    expect(remoteTexts).toContain("my local progress note");

    // PULL: the remote comment is mirrored into the activity log, tagged so it
    // won't be pushed back.
    const after = await readIssue(root, id);
    const mirrored = after.sections.activity.find((a) => a.message === "azure side comment");
    expect(mirrored).toBeTruthy();
    expect(mirrored?.who.startsWith("azure")).toBe(true);
  });

  test("re-sync is idempotent — no duplicate pushes or pulls", async () => {
    const root = await mkRoot();
    const { provider, db, comments } = makeFakeProvider();
    db.set("31", { rev: 1, title: "Once", description: "", state: "New", labels: [] });
    await runSync(root, provider, {}, "secret");
    const [issue] = await listIssues(root);
    const id = issue!.id;

    await commentOnIssue(root, id, "single note", "ui");
    comments.set("31", [{ id: "r9", text: "remote once", author: "PM" }]);

    await runSync(root, provider, {}, "secret");
    await runSync(root, provider, {}, "secret"); // second pass must be a no-op

    // Remote got the local note exactly once.
    const pushedCount = (comments.get("31") ?? []).filter((c) => c.text === "single note").length;
    expect(pushedCount).toBe(1);

    // Local mirrored the remote comment exactly once.
    const after = await readIssue(root, id);
    const mirroredCount = after.sections.activity.filter((a) => a.message === "remote once").length;
    expect(mirroredCount).toBe(1);
  });

  test("a mirrored-in remote comment is never echoed back to the remote", async () => {
    const root = await mkRoot();
    const { provider, db, comments } = makeFakeProvider();
    db.set("32", { rev: 1, title: "Echo guard", description: "", state: "New", labels: [] });
    await runSync(root, provider, {}, "secret");
    const [issue] = await listIssues(root);
    const id = issue!.id;

    comments.set("32", [{ id: "r1", text: "from PM", author: "PM" }]);
    await runSync(root, provider, {}, "secret"); // pulls "from PM"
    await runSync(root, provider, {}, "secret"); // must NOT re-post it upstream

    const echoed = (comments.get("32") ?? []).filter((c) => c.text === "from PM").length;
    expect(echoed).toBe(1); // still just the original remote one
  });
});

describe("type mapping", () => {
  test("createIssue with a type round-trips through storage", async () => {
    const root = await mkRoot();
    const issue = await createIssue(root, { title: "An epic", type: "epic" });
    const read = await readIssue(root, issue.id);
    expect(read.type).toBe("epic");
  });

  test("updateIssue can set and clear the type", async () => {
    const root = await mkRoot();
    const issue = await createIssue(root, { title: "T" });
    await updateIssue(root, issue.id, { type: "feature" });
    expect((await readIssue(root, issue.id)).type).toBe("feature");
    await updateIssue(root, issue.id, { type: null });
    expect((await readIssue(root, issue.id)).type).toBeUndefined();
  });
});

describe("hierarchy import", () => {
  test("maps remote parent links onto local issue parents", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    db.set("200", { rev: 1, title: "Parent feature", description: "", state: "New", labels: [] });
    db.set("201", { rev: 1, title: "Child story", description: "", state: "New", labels: [], parentExternalId: "200" });

    await runSync(root, provider, {}, "secret");

    const list = await listIssues(root);
    const parent = list.find((i) => i.title === "Parent feature")!;
    const child = list.find((i) => i.title === "Child story")!;
    const childFull = await readIssue(root, child.id);
    expect(childFull.parent).toBe(parent.id);
  });

  test("a parent that isn't synced locally leaves the child top-level", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    db.set("300", { rev: 1, title: "Orphan", description: "", state: "New", labels: [], parentExternalId: "999" });

    await runSync(root, provider, {}, "secret");

    const [issue] = await listIssues(root);
    const full = await readIssue(root, issue!.id);
    expect(full.parent).toBeNull();
  });
});
