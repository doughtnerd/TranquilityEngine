import { expect, test, type Locator, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031)

declare global {
  interface Window {
    engine?: { world: { time: { frameCount: number } } };
  }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
}

const box = async (l: Locator) => (await l.boundingBox())!;
const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const rootNames = (page: Page) => page.locator(".tree > li > .row .name").allTextContents();
const indent = (page: Page, key: string) => row(page, key).evaluate((el) => parseFloat((el as HTMLElement).style.paddingLeft));

/** Press on a row and move to `fraction` of another row's height; optionally release. */
async function dragRow(page: Page, from: string, to: string, fraction: number, release = true): Promise<void> {
  const a = await box(row(page, from));
  const b = await box(row(page, to));
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + 40, b.y + b.height * fraction, { steps: 8 });
  if (release) await page.mouse.up();
}

test("dragging a node between rows reorders it, with a line showing where", async ({ page }) => {
  await openEditor(page);
  await dragRow(page, "game", "camera", 0.1, false);
  await expect(row(page, "camera")).toHaveClass(/drop-before/);
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Move GameManager above Camera");
  await page.mouse.up();
  expect((await rootNames(page))[0]).toBe("GameManager");
  await page.keyboard.press("ControlOrMeta+z");
  expect((await rootNames(page))[0]).toBe("Camera");
});

test("dragging a node onto another reparents it, keeping its place in the world", async ({ page }) => {
  await openEditor(page);
  await dragRow(page, "ceiling", "bird", 0.5, false);
  await expect(row(page, "bird")).toHaveClass(/drop-into/);
  await page.mouse.up();
  expect(await indent(page, "ceiling")).toBeGreaterThan(await indent(page, "bird"));
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Ceiling");
  await expect(page.getByRole("textbox", { name: "position x" })).toHaveValue("4"); // world (0, 11) under Bird at (-4, 1)
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("10");
});

test("dragging a child to empty space unparents it", async ({ page }) => {
  await openEditor(page);
  const sprite = await box(row(page, "bird-sprite"));
  const body = await box(page.locator(".panel.hierarchy .panel-body"));
  await page.mouse.move(sprite.x + 40, sprite.y + sprite.height / 2);
  await page.mouse.down();
  await page.mouse.move(sprite.x + 50, sprite.y + 20, { steps: 3 });
  await page.mouse.move(body.x + body.width / 2, body.y + body.height - 10, { steps: 8 });
  await expect(page.locator(".scene-name")).toHaveClass(/drop-into/);
  await page.mouse.up();
  expect(await rootNames(page)).toContain("Sprite");
});

test("nodes inside prefab instances can't be moved, and invalid drops change nothing", async ({ page }) => {
  await openEditor(page);
  // Expand a prefab instance with children: add one, then open it.
  await page.locator(".asset-folder", { hasText: /^prefabs$/ }).click();
  await page.locator(".asset-tile", { hasText: "pipe-pair" }).getByRole("button").click();
  await row(page, "pipe-pair").locator(".caret").click();
  const before = await rootNames(page);

  await dragRow(page, "pipe-pair/top", "camera", 0.1, false);
  await expect(page.locator(".asset-drag-ghost.invalid")).toContainText("moved in the prefab");
  await page.mouse.up();

  await dragRow(page, "bird", "bird-sprite", 0.5, false); // into its own child
  await expect(page.locator(".asset-drag-ghost.invalid")).toContainText("inside itself");
  await page.mouse.up();

  await dragRow(page, "camera", "pipe-pair/bottom", 0.5, false); // into a prefab's insides
  await expect(page.locator(".asset-drag-ghost.invalid")).toContainText("can't take children");
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await rootNames(page)).toEqual(before);
});

test("Delete removes the selected node; undo brings it back", async ({ page }) => {
  await openEditor(page);
  await row(page, "ceiling").click();
  await page.keyboard.press("Delete");
  await expect(row(page, "ceiling")).toHaveCount(0);
  await expect(page.locator(".status-text")).toHaveText("Deleted Ceiling.");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "ceiling")).toHaveCount(1);
});

test("deleting a referenced node asks first, and 'Don't ask again' is remembered and can be undone", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird").click();
  await page.getByRole("button", { name: "Delete node" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("GameManager.bird → Bird");

  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(row(page, "bird")).toHaveCount(1); // cancelled: nothing changed

  await page.keyboard.press("Delete");
  await dialog.getByLabel("Don't ask again").check();
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(row(page, "bird")).toHaveCount(0);
  await expect(page.locator(".status-text")).toContainText("set 1 reference to None");

  await page.keyboard.press("ControlOrMeta+z");
  await row(page, "bird").click();
  await page.keyboard.press("Delete");
  await expect(dialog).toHaveCount(0); // not asked again
  await expect(row(page, "bird")).toHaveCount(0);

  await page.getByRole("button", { name: "Ask before clearing references" }).click();
  await page.keyboard.press("ControlOrMeta+z");
  await row(page, "bird").click();
  await page.keyboard.press("Delete");
  await expect(dialog).toBeVisible(); // asking again
  await page.keyboard.press("Escape");
  await expect(row(page, "bird")).toHaveCount(1);
});
