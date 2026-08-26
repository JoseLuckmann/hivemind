// E2E for the single-file tile: seed a repo, open the file picker (the event the
// spawn menus fire), choose a file, and assert a `file` tile mounts the editor
// with the file's content. Then type + Ctrl+S and verify the edit hits disk.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import fs from "node:fs/promises";
import { execFileSync } from "node:child_process";
import os from "node:os";

let app: ElectronApplication;
let page: Page;
let repo: string;
const FILE = "config.yaml";
const ORIGINAL = "prefix: DEMO\nnext_id: 1\n";

test.beforeAll(async () => {
  repo = await fs.mkdtemp(path.join(os.tmpdir(), "hm-filetile-"));
  await fs.writeFile(path.join(repo, FILE), ORIGINAL, "utf8");
  const git = (...args: string[]) => execFileSync("git", args, { cwd: repo });
  git("init", "-q");
  git("config", "user.email", "e2e@test.dev");
  git("config", "user.name", "e2e");
  git("add", "-A");
  git("commit", "-q", "-m", "seed");

  app = await electron.launch({
    args: [path.join(process.cwd(), "out/main/index.js"), "--no-sandbox", `--user-data-dir=/tmp/hm-filetile-ud-${Date.now()}`],
    cwd: repo,
  });
  page = await app.firstWindow();
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow", { timeout: 15_000 });
  await page.waitForTimeout(400);
  // A frame to spawn into (the file tile lands in a frame like every tile).
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  await page.waitForSelector(".react-flow__node-frame", { timeout: 8_000 });
  await page.waitForTimeout(300);
});

test.afterAll(async () => {
  await app?.close();
  await fs.rm(repo, { recursive: true, force: true }).catch(() => {});
});

test("file picker opens a single-file tile with the file's content", async () => {
  // Fire the same event the spawn menus' "File…" entry fires.
  const fid = await page.evaluate(() => document.querySelector(".react-flow__node-frame")?.getAttribute("data-id"));
  await page.evaluate((id) => window.dispatchEvent(new CustomEvent("hivemind:frame-open-file", { detail: { frameId: id } })), fid);
  // The picker modal appears; filter + Enter to choose config.yaml.
  const input = page.getByRole("textbox", { name: "Filter files" });
  await expect(input).toBeVisible();
  await input.fill("config");
  await page.getByRole("button", { name: /config\.yaml/ }).first().click();
  // A file tile mounts with the file content (CodeMirror).
  const fileNode = page.locator(".react-flow__node-file");
  await expect(fileNode).toBeVisible({ timeout: 8_000 });
  await expect(fileNode.locator("header")).toContainText("config.yaml");
  await expect.poll(async () => fileNode.locator(".cm-content").textContent(), { timeout: 6_000, intervals: [300] })
    .toContain("prefix: DEMO");
});

test("editing the single-file tile and Ctrl+S saves to disk", async () => {
  const fileNode = page.locator(".react-flow__node-file");
  await fileNode.locator(".cm-content").click();
  await page.keyboard.type("# edited by e2e\n");
  await page.keyboard.press("ControlOrMeta+s");
  await expect.poll(async () => fs.readFile(path.join(repo, FILE), "utf8"), { timeout: 6_000, intervals: [300] })
    .toContain("# edited by e2e");
});
