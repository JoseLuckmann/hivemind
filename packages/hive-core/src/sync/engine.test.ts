import { describe, expect, test } from "bun:test";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { createIssue, listIssues, readIssue, updateIssue, writeConfig } from "../storage.js";
import type { Issue, IssueState } from "../types.js";
import { runSync } from "./engine.js";
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
  state: IssueState;
  labels: string[];
}

/** An in-memory `SyncProvider` — exercises the engine's push/pull/conflict
 *  logic without touching a real Azure DevOps org. */
function makeFakeProvider() {
  const db = new Map<string, FakeRemote>();
  let nextId = 1;

  function toRemoteItem(id: string, r: FakeRemote): RemoteItem {
    return {
      externalId: id,
      url: `fake://${id}`,
      rev: String(r.rev),
      title: r.title,
      description: r.description,
      state: r.state,
      labels: r.labels,
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
      db.set(id, {
        rev: 1,
        title: issue.title,
        description: issue.sections.description,
        state: issue.state,
        labels: issue.labels,
      });
      return { externalId: id, url: `fake://${id}`, rev: "1" };
    },
    async updateRemoteItem(_config, _secret, externalId: string, issue: Issue): Promise<PushResult> {
      const cur = db.get(externalId);
      if (!cur) throw new Error(`fake remote item ${externalId} not found`);
      const rev = cur.rev + 1;
      db.set(externalId, {
        rev,
        title: issue.title,
        description: issue.sections.description,
        state: issue.state,
        labels: issue.labels,
      });
      return { externalId, url: `fake://${externalId}`, rev: String(rev) };
    },
    toIssueFields(remote: RemoteItem) {
      return {
        title: remote.title,
        description: remote.description,
        state: remote.state as IssueState,
        labels: remote.labels,
      };
    },
  };

  return { provider, db };
}

describe("runSync", () => {
  test("pushes a brand-new local issue and links it", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    const issue = await createIssue(root, { title: "New task", description: "desc" });

    const report = await runSync(root, provider, {}, "secret");

    expect(report).toEqual({ pushed: 1, pulled: 0, created: 0, errors: [] });
    expect(db.size).toBe(1);
    const [[externalId, remote]] = db.entries();
    expect(remote.title).toBe("New task");

    const synced = await readIssue(root, issue.id);
    expect(synced.sync).toEqual([
      expect.objectContaining({ provider: "fake", externalId, remoteRev: "1" }),
    ]);
  });

  test("creates a local issue for an unmatched remote item", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    db.set("100", {
      rev: 1,
      title: "From Azure",
      description: "remote desc",
      state: "todo",
      labels: ["urgent"],
    });

    const report = await runSync(root, provider, {}, "secret");

    expect(report).toEqual({ pushed: 0, pulled: 0, created: 1, errors: [] });
    const list = await listIssues(root);
    expect(list).toHaveLength(1);
    expect(list[0]?.title).toBe("From Azure");
    expect(list[0]?.sync?.[0]).toEqual(
      expect.objectContaining({ provider: "fake", externalId: "100", remoteRev: "1" }),
    );
  });

  test("second run with no changes is a no-op", async () => {
    const root = await mkRoot();
    const { provider } = makeFakeProvider();
    await createIssue(root, { title: "Stable", description: "" });
    await runSync(root, provider, {}, "secret");

    const report = await runSync(root, provider, {}, "secret");
    expect(report).toEqual({ pushed: 0, pulled: 0, created: 0, errors: [] });
  });

  test("pulls a remote-only change", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    const issue = await createIssue(root, { title: "Original", description: "" });
    await runSync(root, provider, {}, "secret");

    const [[externalId, remote]] = db.entries();
    db.set(externalId, { ...remote, rev: remote.rev + 1, title: "Edited on Azure" });

    const report = await runSync(root, provider, {}, "secret");
    expect(report).toEqual({ pushed: 0, pulled: 1, created: 0, errors: [] });
    const updated = await readIssue(root, issue.id);
    expect(updated.title).toBe("Edited on Azure");
  });

  test("local wins when both sides changed since the last sync", async () => {
    const root = await mkRoot();
    const { provider, db } = makeFakeProvider();
    const issue = await createIssue(root, { title: "Original", description: "" });
    await runSync(root, provider, {}, "secret");

    // Local edit.
    await updateIssue(root, issue.id, { title: "Local edit" });
    // Concurrent remote edit.
    const [[externalId, remote]] = db.entries();
    db.set(externalId, { ...remote, rev: remote.rev + 1, title: "Remote edit" });

    const report = await runSync(root, provider, {}, "secret");
    expect(report).toEqual({ pushed: 1, pulled: 0, created: 0, errors: [] });

    const finalIssue = await readIssue(root, issue.id);
    expect(finalIssue.title).toBe("Local edit");
    expect(db.get(externalId)?.title).toBe("Local edit");
  });
});
