// Renaming and deactivating nodes inside a prefab instance, and Open Prefab from an instance (ADR 0122).
import { expect, test, type Page } from "@playwright/test";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra?: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

/** The Flappy sample as a writable project folder in memory, with a pipe-pair instance added and expanded. */
async function openWithPipe(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject());
  await expect(page.locator(".scene-tab")).toHaveCount(1);
  const assets = page.locator(".panel.assets");
  await assets.getByRole("searchbox", { name: "Search assets" }).fill("pipe-pair");
  await assets.getByRole("button", { name: "Add pipe-pair.prefab.json to the scene" }).click();
  await row(page, "pipe-pair").locator(".caret").click();
}

const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const nameInput = (page: Page) => page.locator(".inspector .node-header .node-name");
const activeBox = (page: Page) => page.locator(".inspector .node-header").getByRole("checkbox", { name: "Active" });

test("renames and deactivates a node inside an instance as overrides, and Apply writes them", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openWithPipe(page);

  await row(page, "pipe-pair/top").click();
  await expect(nameInput(page)).toHaveValue("Top");
  await nameInput(page).fill("Lid");
  await nameInput(page).press("Enter");
  await expect(row(page, "pipe-pair/top").locator(".name")).toHaveText("Lid");
  await expect(row(page, "pipe-pair").locator(".badge")).toHaveClass(/modified/);

  await activeBox(page).uncheck();
  await expect(row(page, "pipe-pair/top")).toHaveClass(/inactive/);
  await expect(page.getByRole("button", { name: "Revert name and active" })).toBeVisible();

  await page.keyboard.press("ControlOrMeta+z"); // undo the deactivation
  await expect(row(page, "pipe-pair/top")).not.toHaveClass(/inactive/);

  await row(page, "pipe-pair").click();
  await page.locator(".inspector .prefab-actions").getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".inspector .override-count")).toHaveText("No overrides");
  const file = await page.evaluate(() => (window as unknown as Hooks).testFolder.read("prefabs/pipe-pair.prefab.json"));
  const top = (JSON.parse(file!) as { nodes: { id: string; name?: string }[] }).nodes.find((n) => n.id === "top");
  expect(top?.name).toBe("Lid");
  await expect(row(page, "pipe-pair/top").locator(".name")).toHaveText("Lid");
  expect(errors).toEqual([]);
});

test("Open Prefab edits the prefab in its own tab, and Back returns to the scene", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openWithPipe(page);

  await row(page, "pipe-pair/bottom").click();
  await page.locator(".inspector").getByRole("button", { name: "Open Prefab" }).click();
  await expect(page.locator(".scene-tab.active")).toContainText("pipe-pair");
  await expect(page.locator(".prefab-bar")).toContainText("Editing prefab prefabs/pipe-pair.prefab.json");
  await expect(row(page, "bottom")).toHaveClass(/selected/);

  // Rename in the prefab, save, and go back: the instance shows the new name.
  await nameInput(page).fill("Floor");
  await nameInput(page).press("Enter");
  await row(page, "bottom").click(); // focus out of the name field so the shortcut reaches the editor
  await page.keyboard.press("ControlOrMeta+s");
  await expect(page.locator(".scene-tab.active")).not.toContainText("•");
  const file = await page.evaluate(() => (window as unknown as Hooks).testFolder.read("prefabs/pipe-pair.prefab.json"));
  expect(file).toContain('"Floor"');
  await page.locator(".prefab-bar").getByRole("button", { name: /Back to/ }).click();
  await expect(page.locator(".prefab-bar")).toHaveCount(0);
  await expect(page.locator(".scene-tab.active")).toContainText("main");
  await expect(row(page, "pipe-pair/bottom").locator(".name")).toHaveText("Floor"); // its selection came back, so it's expanded
  expect(errors).toEqual([]);
});
