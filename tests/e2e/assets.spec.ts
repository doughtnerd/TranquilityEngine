import { expect, test, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html";

declare global {
  interface Window {
    engine?: { world: { time: { frameCount: number } } };
  }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
}

const assets = (page: Page) => page.locator(".panel.assets");

test("browses folders with image thumbnails", async ({ page }) => {
  await openEditor(page);
  await assets(page).getByRole("button", { name: "images", exact: true }).click();
  const tiles = assets(page).locator(".asset-tile");
  await expect(tiles.filter({ hasText: "flappyBird.png" })).toHaveCount(1);
  // Thumbnails are real images that loaded.
  const thumb = tiles.filter({ hasText: "flappyBird.png" }).locator("img");
  await expect(thumb).toBeVisible();
  await expect.poll(() => thumb.evaluate((img) => (img as HTMLImageElement).naturalWidth)).toBeGreaterThan(0);
  await expect(tiles.filter({ hasText: "pipe-pair.prefab.json" })).toHaveCount(0); // other folders aren't listed
});

test("searches across folders and adds a prefab to the scene as an undoable step", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openEditor(page);
  await assets(page).getByRole("searchbox", { name: "Search assets" }).fill("pipe");
  const names = assets(page).locator(".asset-name");
  await expect(names).toHaveText(["pipe-pair.prefab.json", "PipeDown.png", "PipeUp.png"]);

  await assets(page).getByRole("button", { name: "Add pipe-pair.prefab.json to the scene" }).click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("pipe-pair");
  await expect(page.locator(".inspector .node-name")).toHaveValue("pipe-pair");
  await expect(page.getByRole("button", { name: "Undo" })).toHaveAttribute("title", /Add node/);

  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".tree .row .name").filter({ hasText: /^pipe-pair$/ })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("double-clicking a prefab opens it", async ({ page }) => {
  await openEditor(page);
  await assets(page).getByRole("button", { name: "prefabs", exact: true }).click();
  await assets(page).locator(".asset-tile").filter({ hasText: "pipe-pair.prefab.json" }).dblclick();
  await expect(page.locator(".scene-name")).toHaveText("pipe-pair.prefab.json");
  await expect(page.locator(".tree .row .name").first()).toHaveText("PipePair");
});
