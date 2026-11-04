import { expect, test, type Locator, type Page } from "@playwright/test";
import { closeMenus, undoItem } from "./menus";

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

const box = async (l: Locator) => (await l.boundingBox())!;
const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const rootNames = (page: Page) => page.locator(".tree > li > .row .name");

async function showFolder(page: Page, name: string): Promise<void> {
  await page.locator(".asset-folder", { hasText: new RegExp(`^${name}$`) }).click();
}

/** Press on an asset tile and move to (x, y) in steps; optionally release. */
async function dragAsset(page: Page, file: string, x: number, y: number, release = true): Promise<void> {
  const t = await box(page.locator(".asset-tile", { hasText: file }));
  await page.mouse.move(t.x + t.width / 2, t.y + 20);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 20, t.y - 20, { steps: 3 });
  await page.mouse.move(x, y, { steps: 8 });
  if (release) await page.mouse.up();
}

test("dropping an image in the viewport adds a sprite under the cursor", async ({ page }) => {
  await openEditor(page);
  await showFolder(page, "images");
  const vp = await box(page.locator(".viewport-panel"));
  await dragAsset(page, "flappyBird.png", vp.x + vp.width * 0.7, vp.y + vp.height * 0.3, false);
  await expect(page.locator(".viewport-drop-highlight")).toBeVisible();
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Add flappyBird.png here");
  await page.mouse.up();

  await expect(page.locator(".tree .row.selected .name")).toHaveText("FlappyBird");
  await expect(page.locator(".inspector .component h3", { hasText: "SpriteRenderer" })).toBeVisible();
  // Right of and above the centre of a 2D view focused on the scene's camera at (0, 0).
  const x = Number(await page.getByRole("textbox", { name: "position x" }).inputValue());
  const y = Number(await page.getByRole("textbox", { name: "position y" }).inputValue());
  expect(x).toBeGreaterThan(1);
  expect(y).toBeGreaterThan(1);
});

test("dropping on a hierarchy node makes it the parent, with the node highlighted first", async ({ page }) => {
  await openEditor(page);
  await showFolder(page, "music");
  const bird = await box(row(page, "bird"));
  await dragAsset(page, "foo.mp3", bird.x + 40, bird.y + bird.height / 2, false);
  await expect(row(page, "bird")).toHaveClass(/drop-into/);
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Add foo.mp3 as a child of Bird");
  await page.mouse.up();

  await expect(row(page, "bird")).not.toHaveClass(/drop-into/);
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Foo");
  await expect(page.locator(".inspector .component h3", { hasText: "AudioSource" })).toBeVisible();
  // Nested under Bird: one level deeper than Bird's own row.
  const birdIndent = await row(page, "bird").evaluate((el) => parseFloat((el as HTMLElement).style.paddingLeft));
  const fooIndent = await row(page, "foo").evaluate((el) => parseFloat((el as HTMLElement).style.paddingLeft));
  expect(fooIndent).toBeGreaterThan(birdIndent);
});

test("dropping between hierarchy nodes adds a sibling, with a line showing where", async ({ page }) => {
  await openEditor(page);
  await showFolder(page, "prefabs");
  const ceiling = await box(row(page, "ceiling"));
  await dragAsset(page, "pipe-pair", ceiling.x + 40, ceiling.y + 2, false);
  await expect(row(page, "ceiling")).toHaveClass(/drop-before/);
  await page.mouse.up();
  const names = await rootNames(page).allTextContents();
  expect(names.indexOf("pipe-pair")).toBe(names.indexOf("Ceiling") - 1);
});

test("dropping in the hierarchy's empty space adds at the scene's top level", async ({ page }) => {
  await openEditor(page);
  await showFolder(page, "images");
  const tree = await box(page.locator(".panel.hierarchy .panel-body"));
  await dragAsset(page, "flappyBird.png", tree.x + tree.width / 2, tree.y + tree.height - 10, false);
  await expect(page.locator(".scene-name")).toHaveClass(/drop-into/);
  await page.mouse.up();
  await expect(rootNames(page).last()).toHaveText("FlappyBird");
});

test("assets with no node type, and invalid spots, change nothing", async ({ page }) => {
  await openEditor(page);
  const before = await page.locator(".tree .row").count();
  const vp = await box(page.locator(".viewport-panel"));

  await dragAsset(page, "project.json", vp.x + vp.width / 2, vp.y + vp.height / 2, false);
  await expect(page.locator(".asset-drag-ghost.invalid")).toContainText("no kind of scene node");
  await expect(page.locator(".viewport-drop-highlight")).toHaveCount(0);
  await page.mouse.up();

  await showFolder(page, "images");
  const inspector = await box(page.locator(".panel.inspector"));
  await dragAsset(page, "flappyBird.png", inspector.x + inspector.width / 2, inspector.y + 100); // the inspector isn't a drop zone

  expect(await page.locator(".tree .row").count()).toBe(before);
  await expect(await undoItem(page)).toBeDisabled();
  await closeMenus(page);
});
