// Windowed ("editor-like") view mode: toggle from the canvas into a single
// tab-strip + active-body layout, confirm a spawned tile shows as a tab and its
// body renders, then minimize the tab (gone from the strip, still in the graph
// rail) and restore it from the rail.
import { test, expect, _electron as electron, type ElectronApplication, type Page } from "@playwright/test";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const APP_DIR = path.resolve(__dirname, "../..");

let app: ElectronApplication;
let page: Page;

test.beforeAll(async () => {
  app = await electron.launch({
    args: [
      path.join(APP_DIR, "out/main/index.js"),
      "--no-sandbox",
      `--user-data-dir=/tmp/hivemind-ud-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    ],
    cwd: APP_DIR,
  });
  page = await app.firstWindow();
  page.on("console", (m) => console.log(`[r.${m.type()}]`, m.text()));
  await page.waitForLoadState("domcontentloaded");
  await page.waitForSelector(".react-flow");
  await page.waitForTimeout(300);
  // Spawn a shell tile so there's something to tab into.
  await page.evaluate(() =>
    window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })),
  );
  await page.waitForSelector(".react-flow__node-terminal");
  await page.waitForTimeout(400);
});

test.afterAll(async () => {
  await app?.close();
});

test("toggle into windows mode shows a tab strip + active tile body", async () => {
  // Enter windows mode via the same event ⌘E dispatches.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
  // The react-flow canvas is gone; a tablist appears.
  await page.waitForSelector('[role="tablist"]');
  expect(await page.locator(".react-flow").count()).toBe(0);
  // Exactly one tab (the shell), and it's selected + its terminal body mounts.
  const tabs = page.locator('[role="tab"]');
  await expect(tabs).toHaveCount(1);
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  // The terminal body renders inside the active-body host (xterm mounts a canvas).
  await page.waitForSelector(".xterm");
});

test("minimize hides the tab but keeps it in the graph rail; restore brings it back", async () => {
  const tab = page.locator('[role="tab"]').first();
  await tab.hover();
  await tab.getByRole("button", { name: /^Minimize/ }).click();
  // Tab strip is now empty.
  await expect(page.locator('[role="tab"]')).toHaveCount(0);
  // But the tile is still listed in the Layers rail (aside[aria-label="Layers"]).
  const rail = page.locator('aside[aria-label="Layers"]');
  await expect(rail).toBeVisible();
  const railRow = rail.locator("button", { hasText: /shell/i }).first();
  await railRow.click();
  // Restored → back as a tab, selected again.
  await expect(page.locator('[role="tab"]')).toHaveCount(1);
  await expect(page.locator('[role="tab"]').first()).toHaveAttribute("aria-selected", "true");
});

test("toggle back to canvas restores react-flow", async () => {
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:toggle-view-mode")));
  await page.waitForSelector(".react-flow");
  expect(await page.locator('[role="tablist"]').count()).toBe(0);
});

test("right-click a frame in the rail opens the actions menu and spawns into it", async () => {
  // Create a frame (the add-frame event) so the rail has a group.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:add-frame")));
  await page.waitForSelector(".react-flow__node-frame");
  await page.waitForTimeout(300);
  const rail = page.locator('aside[aria-label="Layers"]');
  await expect(rail).toBeVisible();
  // The frame group header's title button (title="Focus …"). Right-click it;
  // the contextmenu bubbles to the row div that carries onContextMenu.
  const titleBtn = rail.locator('button[title^="Focus"]').first();
  await expect(titleBtn).toBeVisible();
  await titleBtn.click({ button: "right" });
  // Menu appears; hover the "Open" submenu, then click "Terminal".
  await expect(page.getByText("Spawn agent")).toBeVisible();
  await page.getByRole("menu").getByRole("button", { name: "Open" }).click();
  const terminalItem = page.getByRole("button", { name: "Terminal", exact: true });
  await expect(terminalItem).toBeVisible();
  const beforeTerms = await page.locator(".react-flow__node-terminal").count();
  await terminalItem.click();
  await page.waitForTimeout(700);
  const afterTerms = await page.locator(".react-flow__node-terminal").count();
  expect(afterTerms).toBe(beforeTerms + 1);
});

test("rename a frame inline from the rail context menu", async () => {
  const rail = page.locator('aside[aria-label="Layers"]');
  const titleBtn = rail.locator('button[title^="Focus"]').first();
  await titleBtn.click({ button: "right" });
  // Click the Rename item in the just-opened menu (last portal if any stacked).
  await page.getByRole("button", { name: "Rename" }).last().click();
  // An input appears in the row; type a new name + Enter.
  const input = rail.getByRole("textbox", { name: "Rename frame" }).first();
  await expect(input).toBeVisible();
  await input.fill("Renamed Frame");
  await input.press("Enter");
  // The row now shows the new title.
  await expect(rail.locator('button[title^="Focus"]').filter({ hasText: "Renamed Frame" }).first()).toBeVisible();
});

test("Git submenu in the rail menu opens the commit modal", async () => {
  const rail = page.locator('aside[aria-label="Layers"]');
  await rail.locator('button[title^="Focus"]').first().click({ button: "right" });
  // The menu has a "Git" submenu row.
  const gitRow = page.getByRole("menu").getByRole("button", { name: "Git" });
  await expect(gitRow.first()).toBeVisible();
  await gitRow.first().click();
  const commit = page.getByRole("button", { name: "Commit…" });
  await expect(commit.first()).toBeVisible();
  // Push + Pull live in the same submenu.
  await expect(page.getByRole("button", { name: "Push", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pull", exact: true })).toBeVisible();
  await commit.first().click();
  await expect(page.getByRole("textbox", { name: "Commit summary" })).toBeVisible();
  await expect(page.getByRole("button", { name: /Commit & Push/ })).toBeVisible();
  await page.mouse.click(5, 5); // dismiss via backdrop
});

test("frame header shows a git button", async () => {
  // In canvas mode a repo frame's header carries a git button (same action as
  // the rail Git ▸ Commit… — both fire hivemind:frame-git, proven above).
  const frame = page.locator(".react-flow__node-frame").first();
  await expect(frame).toBeVisible();
  await expect(frame.getByRole("button", { name: "git" }).first()).toBeVisible();
});

test("Ctrl+Tab cycles tabs in windows mode", async () => {
  // Ensure ≥2 terminals, then enter windows mode.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:canvas-toggle", { detail: "shell" })));
  await page.waitForTimeout(300);
  // Enter windows mode (idempotent set via toggle if currently canvas).
  const inWindows = await page.locator('[role="tablist"]').count();
  if (inWindows === 0) {
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "windows" } })));
    await page.waitForSelector('[role="tablist"]');
  }
  const tabs = page.locator('[role="tab"]');
  const count = await tabs.count();
  expect(count).toBeGreaterThanOrEqual(2);
  // Note which tab is selected, Ctrl+Tab, expect a DIFFERENT one selected.
  const before = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("title");
  await page.keyboard.press("Control+Tab");
  await page.waitForTimeout(150);
  const after = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("title");
  expect(after).not.toBe(before);
  // Ctrl+Shift+Tab goes back to the original.
  await page.keyboard.press("Control+Shift+Tab");
  await page.waitForTimeout(150);
  const back = await page.locator('[role="tab"][aria-selected="true"]').getAttribute("title");
  expect(back).toBe(before);
  // Return to canvas for later tests' assumptions.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("hivemind:set-view-mode", { detail: { mode: "canvas" } })));
  await page.waitForSelector(".react-flow");
});
