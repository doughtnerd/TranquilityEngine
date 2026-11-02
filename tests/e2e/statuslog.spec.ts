import { expect, test, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html";

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

const log = (page: Page) => page.getByRole("log", { name: "Message log" });

test("clicking the status bar opens a log of full messages with their details", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({ "scripts/Broken.ts": "export const = 1;\n", "scripts/Throws.ts": 'throw new Error("bad setup");\n' }));
  await expect(page.locator(".status-bar")).toHaveClass(/error/);
  await page.locator(".status-text").click();
  await expect(log(page)).toBeVisible();
  const entry = log(page).locator(".message-entry.error").filter({ hasText: "2 scripts didn't load" });
  await expect(entry.locator(".message-detail")).toContainText("scripts/Broken.ts: line 1");
  await expect(entry.locator(".message-detail")).toContainText("scripts/Throws.ts: bad setup");

  await page.keyboard.press("Escape");
  await expect(log(page)).toHaveCount(0);
});

test("uncaught errors are logged with their stack, and flagged in the status bar", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => {
    setTimeout(() => {
      throw new Error("kaboom");
    });
  });
  await expect(page.locator(".status-text")).toHaveText("Something went wrong: kaboom. Click the status bar for details.");
  await expect(page.locator(".status-unseen")).toHaveText("1 error");
  await page.getByRole("button", { name: "Log" }).click();
  const entry = log(page).locator(".message-entry").filter({ hasText: "Uncaught error: kaboom" });
  await expect(entry.locator(".message-detail")).toContainText("Error: kaboom");
  await expect(page.locator(".status-unseen")).toHaveCount(0);

  await log(page).getByRole("button", { name: "Clear" }).click();
  await expect(log(page).locator(".message-entry")).toHaveCount(0);
  await log(page).getByRole("button", { name: "Close the message log" }).click();
  await expect(log(page)).toHaveCount(0);
});

test("deleting an asset asks first, listing what uses it; Don't ask again skips the question next time", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({}));
  await page.locator(".asset-folder", { hasText: /^images$/ }).click();
  const background = page.locator(".asset-tile", { hasText: "background.png" });
  await background.click();
  await page.getByRole("button", { name: "Delete", exact: true }).click();

  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete background.png?");
  await expect(dialog.locator(".dialog-items")).toHaveText("prefabs/background.prefab.json");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(background).toBeVisible();

  await page.getByRole("button", { name: "Delete", exact: true }).click();
  await dialog.getByRole("checkbox", { name: "Don't ask again" }).check();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(background).toHaveCount(0);
  await expect(page.locator(".status-text")).toHaveText("Deleted images/background.png. 1 file still refers to it: prefabs/background.prefab.json.");
  expect(await page.evaluate(() => (window as unknown as Hooks).testFolder.read("images/background.png"))).toBeUndefined();

  // No question now; the Delete key on a focused tile works too.
  const pipe = page.locator(".asset-tile", { hasText: "PipeUp.png" });
  await pipe.focus();
  await page.keyboard.press("Delete");
  await expect(pipe).toHaveCount(0);
  await expect(page.getByRole("alertdialog")).toHaveCount(0);
  await page.locator(".status-bar").getByRole("button", { name: "Ask before deleting" }).click();
});

test("the open scene and project.json can't be deleted", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({}));
  await page.locator(".asset-tile", { hasText: "project.json" }).click();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toBeDisabled();
  await expect(page.getByRole("button", { name: "Delete", exact: true })).toHaveAttribute("title", /defines the project/);
});
