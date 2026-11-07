import { expect, test, type Locator, type Page } from "@playwright/test";

// Import settings (ADR 0040): the Asset Inspector, the Sprite Editor, and slices in the Assets
// panel and the scene, on a writable in-memory copy of the Flappy sample.
const EDITOR = "/editor.html?sample=flappy"; // relative to baseURL (E2E_PORT)

type Rect = { left: number; top: number; right: number; bottom: number };
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
  nodeRect(key: string): Rect | null;
};

async function openProject(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate((files) => (window as unknown as Hooks).openTestProject(files), extra);
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await panel(page).locator(".asset-folder", { hasText: /^images$/ }).click();
}

const panel = (page: Page) => page.locator(".panel.assets");
const tile = (page: Page, name: string) => panel(page).locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
const sidecar = async (page: Page, path: string) => JSON.parse((await read(page, path)) ?? "null");
const box = async (l: Locator) => (await l.boundingBox())!;
const inspector = (page: Page) => page.locator(".asset-inspector");
const editor = (page: Page) => page.getByRole("dialog", { name: /^Sprite Editor/ });

const BIRD_SLICES = JSON.stringify({
  format: "myco.import@1",
  sprites: [
    { name: "left", rect: [0, 0, 250, 500], pivot: [0.5, 0.5] },
    { name: "right", rect: [250, 0, 250, 500], pivot: [0.5, 0.5] },
  ],
});

test("the Asset Inspector edits an image's import settings and applies them to its sidecar", async ({ page }) => {
  await openProject(page);
  await tile(page, "flappyBird.png").click();
  await expect(inspector(page)).toBeVisible();
  await expect(inspector(page).locator(".asset-inspector-name")).toHaveText("flappyBird.png");
  await expect(inspector(page).locator(".asset-inspector-size")).toHaveText("500 × 500 px");
  const apply = inspector(page).getByRole("button", { name: "Apply" });
  await expect(apply).toBeDisabled();

  await inspector(page).getByLabel("Filter Mode", { exact: true }).selectOption("point");
  await inspector(page).getByLabel("Pixels Per Unit").fill("50");
  await inspector(page).getByLabel("Pixels Per Unit").press("Tab");
  await inspector(page).getByLabel("Pivot", { exact: true }).selectOption("Bottom");
  await apply.click();
  await expect(page.locator(".status-text")).toHaveText("Saved import settings for flappyBird.png.");
  expect(await sidecar(page, "images/flappyBird.png.meta.json")).toEqual({ format: "myco.import@1", pixelsPerUnit: 50, filter: "point", pivot: [0.5, 0] });
  await expect(apply).toBeDisabled();

  // Revert drops unapplied edits; the sidecar file isn't listed.
  await inspector(page).getByLabel("Wrap Mode", { exact: true }).selectOption("repeat");
  await inspector(page).getByRole("button", { name: "Revert" }).click();
  await expect(inspector(page).getByLabel("Wrap Mode", { exact: true })).toHaveValue("clamp");
  await expect(tile(page, "flappyBird.png.meta.json")).toHaveCount(0);

  // Audio has its own settings.
  await panel(page).locator(".asset-folder", { hasText: /^music$/ }).click();
  await tile(page, "town.mp3").click();
  await inspector(page).getByLabel("Stream").check();
  await inspector(page).getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => sidecar(page, "music/town.mp3.meta.json")).toEqual({ format: "myco.import@1", stream: true });
});

test("the sidecar's pixels per unit sizes sprites in the scene", async ({ page }) => {
  await openProject(page, { "images/flappyBird.png.meta.json": JSON.stringify({ format: "myco.import@1", pixelsPerUnit: 50 }) });
  // The image is 500 px: at 50 px per unit it's 10 units, twice its size at the project's 100.
  await panel(page).getByRole("button", { name: "Add flappyBird.png to the scene" }).click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("FlappyBird");
  const width = async () => page.evaluate(() => {
    const r = (window as unknown as Hooks).nodeRect("flappy-bird");
    return r ? r.right - r.left : 0;
  });
  await expect.poll(width).toBeGreaterThan(0);
  const at50 = await width();
  await tile(page, "flappyBird.png").click(); // shows its import settings in place of the node
  await inspector(page).getByLabel("Pixels Per Unit").fill("");
  await inspector(page).getByLabel("Pixels Per Unit").press("Tab");
  await inspector(page).getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await width()) / at50).toBeCloseTo(0.5, 1);
});

test("the Sprite Editor slices by grid, renames a slice, and the slice drags into the scene at its own size", async ({ page }) => {
  await openProject(page);
  await tile(page, "flappyBird.png").click();
  await inspector(page).getByRole("button", { name: "Sprite Editor…" }).click();
  const dlg = editor(page);
  await expect(dlg).toBeVisible();
  await dlg.getByLabel("Slice type").selectOption("count");
  await dlg.getByLabel("Columns").fill("2");
  await dlg.getByLabel("Rows").fill("1");
  await dlg.getByLabel("Rows").press("Tab");
  await dlg.getByText("Skip empty cells").click(); // keep every cell
  await dlg.getByRole("button", { name: "Slice", exact: true }).click();
  await expect(dlg.locator(".sprite-slice")).toHaveCount(2);
  await expect(dlg.locator(".sprite-list button")).toHaveText(["flappyBird_0", "flappyBird_1"]);

  await dlg.locator(".sprite-list button", { hasText: "flappyBird_0" }).click();
  await expect(dlg.getByLabel("W", { exact: true })).toHaveValue("250");
  await dlg.getByLabel("Slice name").fill("wing");
  await dlg.getByLabel("Slice name").press("Enter");
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect(page.locator(".status-text")).toHaveText("Saved 2 slices of flappyBird.png.");
  const saved = await sidecar(page, "images/flappyBird.png.meta.json");
  expect(saved.sprites).toEqual([
    { name: "wing", rect: [0, 0, 250, 500], pivot: [0.5, 0.5] },
    { name: "flappyBird_1", rect: [250, 0, 250, 500], pivot: [0.5, 0.5] },
  ]);
  await dlg.getByRole("button", { name: "Close" }).click();
  await expect(dlg).toHaveCount(0);

  // The image lists its slices; a slice drags into the viewport as a sprite of that slice.
  await panel(page).getByRole("button", { name: "Show the slices of flappyBird.png" }).click();
  await expect(tile(page, "wing")).toHaveCount(1);
  await expect(tile(page, "wing")).toHaveClass(/kind-sprite/);
  const from = await box(tile(page, "wing"));
  const vp = await box(page.locator(".viewport-panel"));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(vp.x + vp.width * 0.3, vp.y + vp.height * 0.5, { steps: 8 });
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Add flappyBird.png#wing here");
  await page.mouse.up();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Wing");
  // Half the bird's width (250 of 500 px), the full height.
  const size = (key: string) => page.evaluate((k) => {
    const r = (window as unknown as Hooks).nodeRect(k);
    return r ? [r.right - r.left, r.bottom - r.top] : null;
  }, key);
  await expect.poll(() => size("wing")).not.toBeNull();
  const [w, h] = (await size("wing"))!;
  expect(w / h).toBeCloseTo(0.5, 1);
});

test("slices are drawn, moved and resized by hand; automatic slicing finds the opaque area", async ({ page }) => {
  await openProject(page);
  await tile(page, "PipeUp.png").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Sprite Editor/ }).click();
  const dlg = editor(page);
  const stage = dlg.locator(".sprite-stage");
  await expect.poll(async () => (await box(stage)).height).toBeGreaterThan(100);
  const s = await box(stage);
  const scale = s.width / 30; // the image is 30 × 160 px

  // Draw from (5, 10) to (25, 50) in image pixels.
  await page.mouse.move(s.x + 5 * scale, s.y + 10 * scale);
  await page.mouse.down();
  await page.mouse.move(s.x + 15 * scale, s.y + 30 * scale, { steps: 4 });
  await page.mouse.move(s.x + 25 * scale, s.y + 50 * scale, { steps: 4 });
  await page.mouse.up();
  await expect(dlg.locator(".sprite-slice")).toHaveCount(1);
  const field = (name: string) => dlg.getByLabel(name, { exact: true });
  await expect(field("X")).toHaveValue("5");
  await expect(field("Y")).toHaveValue("10");
  await expect(field("W")).toHaveValue("20");
  await expect(field("H")).toHaveValue("40");

  // Move it 10 px down by dragging its middle.
  await page.mouse.move(s.x + 15 * scale, s.y + 30 * scale);
  await page.mouse.down();
  await page.mouse.move(s.x + 15 * scale, s.y + 40 * scale, { steps: 5 });
  await page.mouse.up();
  await expect(field("Y")).toHaveValue("20");
  await expect(field("X")).toHaveValue("5");

  // Resize from the bottom-right handle, 5 px right and down.
  const handle = await box(dlg.locator(".sprite-handle.handle-se"));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 5 * scale, handle.y + handle.height / 2 + 5 * scale, { steps: 5 });
  await page.mouse.up();
  await expect(field("W")).toHaveValue("25");
  await expect(field("H")).toHaveValue("45");
  await expect(field("X")).toHaveValue("5");

  // Delete removes the selected slice.
  await dlg.locator(".sprite-slice").click();
  await page.keyboard.press("Delete");
  await expect(dlg.locator(".sprite-slice")).toHaveCount(0);

  await dlg.getByLabel("Slice type").selectOption("auto");
  await dlg.getByRole("button", { name: "Slice", exact: true }).click();
  await expect.poll(() => dlg.locator(".sprite-slice").count()).toBeGreaterThan(0);
  await dlg.getByRole("button", { name: "Apply" }).click();
  await expect.poll(async () => (await sidecar(page, "images/PipeUp.png.meta.json"))?.sprites?.length ?? 0).toBeGreaterThan(0);

  // Closing with unapplied changes asks first.
  await dlg.getByRole("button", { name: "Clear" }).click();
  await dlg.getByRole("button", { name: "Close" }).click();
  const confirm = page.getByRole("alertdialog");
  await expect(confirm).toContainText("Discard slice changes?");
  await confirm.getByRole("button", { name: "Discard" }).click();
  await expect(dlg).toHaveCount(0);
});

test("renaming an image takes its sidecar along and updates slice references; deleting warns about them", async ({ page }) => {
  const scene = JSON.stringify({
    format: "myco.scene@1",
    nodes: [{ id: "w", name: "W", components: [{ type: "engine.Transform" }, { type: "engine.SpriteRenderer", data: { sprite: "asset:images/flappyBird.png#right" } }] }],
  });
  await openProject(page, { "images/flappyBird.png.meta.json": BIRD_SLICES, "prefabs/wing.prefab.json": scene });
  await tile(page, "flappyBird.png").click();
  await page.keyboard.press("F2");
  await expect(panel(page).getByRole("textbox", { name: "New name for flappyBird.png" })).toBeFocused();
  await page.keyboard.type("bird");
  await page.keyboard.press("Enter");
  await expect(tile(page, "bird.png")).toHaveClass(/selected/);
  await expect.poll(() => read(page, "images/bird.png.meta.json")).toBe(BIRD_SLICES);
  expect(await read(page, "images/flappyBird.png.meta.json")).toBeUndefined();
  expect(await read(page, "prefabs/wing.prefab.json")).toContain('"asset:images/bird.png#right"');

  await tile(page, "bird.png").click();
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("prefabs/wing.prefab.json");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(tile(page, "bird.png")).toHaveCount(0);
  await expect.poll(() => read(page, "images/bird.png.meta.json")).toBeUndefined();
  expect(await read(page, "prefabs/wing.prefab.json")).not.toContain("bird.png");
});
