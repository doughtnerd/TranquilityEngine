import { expect, test, type Page } from "@playwright/test";
import { menu } from "./menus";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

declare global {
  interface Window {
    engine?: { world: { time: { frameCount: number } } };
  }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
}

async function setBirdY(page: Page, value: string): Promise<void> {
  const y = page.getByRole("textbox", { name: "position y" });
  await y.fill(value);
  await y.press("Enter");
  await expect(y).toHaveValue(value);
}

/** Make two unsaved edits, then "close" the editor by reloading without saving. */
async function editThenClose(page: Page): Promise<void> {
  await openEditor(page);
  await page.locator('.tree .row[data-key="bird"]').click();
  await setBirdY(page, "2");
  await setBirdY(page, "3");
  await page.waitForTimeout(300); // history writes are asynchronous; give them a moment
  page.once("dialog", (d) => void d.accept()); // the browser's own "leave page?" prompt
  await page.reload();
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
}

test("unsaved changes survive the editor closing, and can be restored", async ({ page }) => {
  await editThenClose(page);
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Restore unsaved changes?");
  await expect(dialog).toContainText("Set position");
  await dialog.getByRole("button", { name: "Restore" }).click();

  await page.locator('.tree .row[data-key="bird"]').click();
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("3");
  await expect(page.locator(".scene-name")).toContainText("•"); // still unsaved
  await menu(page, "Edit", /^Undo/);
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("2"); // the history came back too
});

test("keeping the saved version leaves the unsaved changes reachable with redo", async ({ page }) => {
  await editThenClose(page);
  const dialog = page.getByRole("alertdialog");
  await dialog.getByRole("button", { name: "Keep saved version" }).click();
  await expect(page.locator(".status-text")).toContainText("still in the edit history");

  await page.locator('.tree .row[data-key="bird"]').click();
  const y = page.getByRole("textbox", { name: "position y" });
  await expect(y).toHaveValue("1"); // the saved file
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(y).toHaveValue("2");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(y).toHaveValue("3");
});

test("no prompt when there were no unsaved changes", async ({ page }) => {
  await openEditor(page);
  await page.reload();
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
  await page.waitForTimeout(500);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
});
