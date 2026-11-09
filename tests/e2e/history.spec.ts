import { expect, test, type Page } from "./fixtures";
import { showTab } from "./tabs";
import { menu } from "./menus";

const EDITOR = process.env.EDITOR_URL ?? "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

declare global {
  interface Window {
    engine?: { world: { time: { frameCount: number } } };
  }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
}

const birdY = (page: Page) => page.getByRole("textbox", { name: "position y" });

async function setBirdY(page: Page, value: string): Promise<void> {
  await birdY(page).fill(value);
  await birdY(page).press("Enter");
  await expect(birdY(page)).toHaveValue(value);
}

test("the History panel draws branches, and clicking a state goes there", async ({ page }) => {
  await openEditor(page);
  await page.locator(`.tree .row[data-key="bird"]`).click();
  await setBirdY(page, "2"); // state 1
  await setBirdY(page, "3"); // state 2
  await page.keyboard.press("ControlOrMeta+z"); // back to state 1
  await expect(birdY(page)).toHaveValue("2");
  await setBirdY(page, "4"); // state 3: a new branch beside state 2

  await showTab(page, "History");
  const rows = page.locator(".history-row");
  await expect(rows).toHaveCount(4);
  await expect(page.locator(".history-row.current")).toHaveAttribute("data-seq", "3");
  await expect(page.locator(".history-row", { hasText: "saved" })).toHaveAttribute("data-seq", "0");
  // Two branches: the abandoned state sits in a second column of the gutter.
  const xs = await page.locator(".history-dot").evaluateAll((dots) => [...new Set(dots.map((d) => d.getAttribute("cx")))]);
  expect(xs).toHaveLength(2);

  await page.locator('.history-row[data-seq="2"]').click(); // the abandoned branch
  await expect(page.locator(".history-row.current")).toHaveAttribute("data-seq", "2");
  await showTab(page, "Inspector");
  await expect(birdY(page)).toHaveValue("3");

  // Ctrl+Alt+Z steps back in creation order: state 2 → state 1.
  await page.keyboard.press("ControlOrMeta+Alt+z");
  await expect(birdY(page)).toHaveValue("2");
  await page.keyboard.press("ControlOrMeta+Alt+Shift+z"); // and forward again
  await expect(birdY(page)).toHaveValue("3");
});

test("Settings: history location is remembered, and the reference prompt checkbox follows the preference", async ({ page }) => {
  await openEditor(page);
  await menu(page, "Edit", "Settings…");
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog.getByLabel("Project folder (.myco/history)")).toBeChecked();
  await dialog.getByLabel("Per user (outside the project)").check();
  await expect(dialog.getByLabel("Ask before deleting a node other nodes reference")).toBeChecked();
  await dialog.getByLabel("Ask before deleting a node other nodes reference").uncheck();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);

  await page.reload();
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
  await menu(page, "Edit", "Settings…");
  await expect(dialog.getByLabel("Per user (outside the project)")).toBeChecked();
  await expect(dialog.getByLabel("Ask before deleting a node other nodes reference")).not.toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem("myco.editor.historyLocation"))).toBe('"user"');
  await dialog.getByRole("button", { name: "Close" }).click();
  await expect(dialog).toHaveCount(0);
});
