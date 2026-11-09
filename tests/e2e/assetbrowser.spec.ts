import { expect, test, type Locator, type Page } from "./fixtures";
import { closeMenus, undoItem } from "./menus";

// The Assets panel as a file browser, on a writable in-memory copy of the demo project.
const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

async function openProject(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({}));
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
}

const panel = (page: Page) => page.locator(".panel.assets");
const tile = (page: Page, name: string) => panel(page).locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`) }) });
const selectedNames = (page: Page) => panel(page).locator(".asset-item.selected .asset-name");
const treeFolder = (page: Page, name: string) => panel(page).locator(".asset-folder", { hasText: new RegExp(`^${name}$`) });
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
const box = async (l: Locator) => (await l.boundingBox())!;

test("click, Ctrl+click, Shift+click and the arrow keys select; Ctrl+A selects all; Escape clears", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "images").click();
  await tile(page, "background.png").click();
  await tile(page, "PipeDown.png").click({ modifiers: ["ControlOrMeta"] });
  await expect(selectedNames(page)).toHaveText(["background.png", "PipeDown.png"]);
  await tile(page, "flappyBird.png").click();
  await tile(page, "PipeDown.png").click({ modifiers: ["Shift"] });
  await expect(selectedNames(page)).toHaveText(["flappyBird.png", "ground.jpg", "PipeDown.png"]);
  await page.keyboard.press("ArrowRight");
  await expect(selectedNames(page)).toHaveText(["PipeUp.png"]);
  await page.keyboard.press("Shift+ArrowLeft");
  await expect(selectedNames(page)).toHaveText(["PipeDown.png", "PipeUp.png"]);
  await page.keyboard.press("ControlOrMeta+a");
  await expect(selectedNames(page)).toHaveCount(5);
  await page.keyboard.press("Escape");
  await expect(selectedNames(page)).toHaveCount(0);
});

test("a box dragged on empty space selects what it touches; Ctrl toggles", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "images").click();
  const list = await box(panel(page).locator(".asset-items"));
  const first = await box(tile(page, "background.png"));
  const third = await box(tile(page, "ground.jpg"));
  // From the empty space below the tiles, up over the first three.
  await page.mouse.move(third.x + third.width - 4, list.y + list.height - 6);
  await page.mouse.down();
  await page.mouse.move(first.x + 4, first.y + first.height / 2, { steps: 5 });
  await expect(panel(page).locator(".asset-box")).toBeVisible();
  await page.mouse.up();
  await expect(selectedNames(page)).toHaveText(["background.png", "flappyBird.png", "ground.jpg"]);
  await expect(panel(page).locator(".asset-box")).toHaveCount(0);

  await page.keyboard.down("Control");
  await page.mouse.move(third.x + third.width - 4, list.y + list.height - 6);
  await page.mouse.down();
  await page.mouse.move(third.x + 4, third.y + third.height / 2, { steps: 5 });
  await page.mouse.up();
  await page.keyboard.up("Control");
  await expect(selectedNames(page)).toHaveText(["background.png", "flappyBird.png"]);

  // A click on empty space clears.
  await page.mouse.click(list.x + list.width - 10, list.y + list.height - 10);
  await expect(selectedNames(page)).toHaveCount(0);
});

test("F2 renames in place, updating the prefab that uses the file", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "images").click();
  await tile(page, "background.png").click();
  await page.keyboard.press("F2");
  const input = panel(page).getByRole("textbox", { name: "New name for background.png" });
  await expect(input).toBeFocused();
  // The name is selected without its extension, so typing replaces just that.
  await page.keyboard.type("sky");
  await page.keyboard.press("Enter");
  await expect(tile(page, "sky.png")).toHaveClass(/selected/);
  await expect(page.locator(".status-text")).toHaveText("Renamed images/background.png to images/sky.png. Updated references in prefabs/background.prefab.json.");
  expect(await read(page, "prefabs/background.prefab.json")).toContain("asset:images/sky.png");
  expect(await read(page, "images/background.png")).toBeUndefined();

  await page.keyboard.press("F2");
  await page.keyboard.type("nope");
  await page.keyboard.press("Escape");
  await expect(tile(page, "sky.png")).toHaveCount(1);
});

test("dragging selected files onto a folder moves them", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "images").click();
  await tile(page, "PipeDown.png").click();
  await tile(page, "PipeUp.png").click({ modifiers: ["ControlOrMeta"] });
  const from = await box(tile(page, "PipeUp.png"));
  const to = await box(treeFolder(page, "music"));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(to.x + to.width / 2, to.y + to.height / 2, { steps: 8 });
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Move 2 items to music");
  await expect(treeFolder(page, "music")).toHaveClass(/drop-target/);
  await page.mouse.up();
  await expect(tile(page, "PipeUp.png")).toHaveCount(0);
  await expect(page.locator(".status-text")).toHaveText(/^Moved 2 items\./);
  expect(await read(page, "music/PipeUp.png")).toBeDefined();
});

test("the right-click menu makes folders, duplicates, and copies and pastes", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "images").click();
  const list = await box(panel(page).locator(".asset-items"));
  await page.mouse.click(list.x + list.width - 10, list.y + list.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Folder" }).click();
  const input = panel(page).getByRole("textbox", { name: "New name for New Folder" });
  await expect(input).toBeFocused();
  await page.keyboard.type("tiles");
  await page.keyboard.press("Enter");
  await expect(tile(page, "tiles")).toHaveClass(/selected/);
  await expect(treeFolder(page, "tiles")).toHaveCount(1);

  await tile(page, "ground.jpg").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Duplicate/ }).click();
  await expect(tile(page, "ground copy.jpg")).toHaveClass(/selected/);

  await tile(page, "flappyBird.png").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Copy/ }).click();
  await tile(page, "tiles").dblclick();
  await expect(panel(page).locator(".asset-crumb")).toContainText("tiles");
  const empty = await box(panel(page).locator(".asset-items"));
  await page.mouse.click(empty.x + 40, empty.y + 40, { button: "right" });
  await page.getByRole("menuitem", { name: /^Paste/ }).click();
  await expect(tile(page, "flappyBird.png")).toHaveCount(1);
  expect(await read(page, "images/tiles/flappyBird.png")).toBeDefined();
  expect(await read(page, "images/flappyBird.png")).toBeDefined();
});

test("Back, Forward, Up and the path bar move between folders", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "prefabs").click();
  await treeFolder(page, "images").click();
  await panel(page).getByRole("button", { name: "Back", exact: true }).click();
  await expect(tile(page, "pipe-pair.prefab.json")).toHaveCount(1);
  await panel(page).getByRole("button", { name: "Forward", exact: true }).click();
  await expect(tile(page, "flappyBird.png")).toHaveCount(1);
  await panel(page).getByRole("button", { name: "Up", exact: true }).click();
  await expect(tile(page, "images")).toHaveCount(1);
  await tile(page, "images").dblclick();
  await panel(page).locator(".asset-crumb .crumb").first().click();
  await expect(tile(page, "project.json")).toHaveCount(1);
});

test("the list view shows kind and size; the view and tile size are remembered", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "prefabs").click();
  const before = (await box(tile(page, "music.prefab.json").locator(".asset-thumb"))).width;
  await panel(page).getByRole("slider", { name: "Tile size" }).fill("100");
  await expect.poll(async () => (await box(tile(page, "music.prefab.json").locator(".asset-thumb"))).width).toBeGreaterThan(before + 20);

  await panel(page).getByRole("button", { name: "List" }).click();
  const row = tile(page, "music.prefab.json");
  await expect(row.locator(".asset-col-kind")).toHaveText("Prefab");
  await expect(row.locator(".asset-col-size")).toHaveText(/\d+ B$/);

  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  await expect(panel(page).getByRole("button", { name: "List" })).toHaveAttribute("aria-pressed", "true");
});

test("deleting several files asks once", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "images").click();
  await tile(page, "PipeDown.png").click();
  await tile(page, "PipeUp.png").click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("Delete");
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("Delete 2 items?");
  await dialog.getByRole("button", { name: "Delete" }).click();
  await expect(tile(page, "PipeUp.png")).toHaveCount(0);
  await expect(tile(page, "PipeDown.png")).toHaveCount(0);
  await expect(page.locator(".status-text")).toHaveText(/^Deleted 2 items\./);
});

test("several selected images drag into the hierarchy together, as one undo step", async ({ page }) => {
  await openProject(page);
  await treeFolder(page, "images").click();
  await tile(page, "PipeDown.png").click();
  await tile(page, "PipeUp.png").click({ modifiers: ["ControlOrMeta"] });
  const from = await box(tile(page, "PipeUp.png"));
  const tree = await box(page.locator(".panel.hierarchy .panel-body"));
  await page.mouse.move(from.x + from.width / 2, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(tree.x + tree.width / 2, tree.y + tree.height - 10, { steps: 8 });
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Add 2 items to the scene");
  await page.mouse.up();
  const roots = page.locator(".tree > li > .row .name");
  await expect(roots.last()).toHaveText("PipeUp");
  await expect(roots.nth(-2)).toHaveText("PipeDown");
  await expect(await undoItem(page)).toContainText(/Add 2 assets/);
  await closeMenus(page);
});

test("the Inspector follows the latest selection, between the Hierarchy and the Assets panel", async ({ page }) => {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  const material = JSON.stringify({ format: "myco.material@1", shader: "lit", color: "#ffffff" });
  await page.evaluate((m) => (window as unknown as Hooks).openTestProject({ "materials/sail.material.json": m }), material);
  await page.locator(".dock-tab", { hasText: "Assets" }).click();
  const inspector = page.locator(".panel.inspector .inspector-body");
  const assetInspector = page.locator(".panel.inspector .asset-inspector");
  const node = (name: string) => page.locator(".panel.hierarchy .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
  const showsNode = async () => {
    await expect(assetInspector).toHaveCount(0);
    await expect(inspector.locator(".component").first()).toBeVisible();
  };

  // A node, then a material: the material's editor replaces the node.
  await node("Bird").click();
  await showsNode();
  await treeFolder(page, "materials").click();
  await tile(page, "sail.material.json").click();
  await expect(assetInspector).toContainText("sail.material.json");
  await expect(page.locator(".panel.hierarchy .row.selected")).toHaveCount(0);

  // The material, then a node: the node replaces it, and deselecting the node doesn't bring it back.
  await node("Bird").click();
  await showsNode();
  await expect(selectedNames(page)).toHaveCount(0);
  await node("Bird").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".panel.hierarchy .row.selected")).toHaveCount(0);
  await expect(assetInspector).toHaveCount(0);

  // Other kinds with an inspector: an image and a prefab, each after a node.
  for (const [folder, file] of [["images", "PipeUp.png"], ["prefabs", "ground.prefab.json"]]) {
    await node("Camera").click();
    await showsNode();
    await treeFolder(page, folder).click();
    await tile(page, file).click();
    await expect(assetInspector).toContainText(file);
  }

  // Several nodes, then the material.
  await node("Camera").click();
  await node("Bird").click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".panel.hierarchy .row.selected")).toHaveCount(2);
  await expect(assetInspector).toHaveCount(0);
  await treeFolder(page, "materials").click();
  await tile(page, "sail.material.json").click();
  await expect(assetInspector).toContainText("sail.material.json");
  await expect(page.locator(".panel.hierarchy .row.selected")).toHaveCount(0);
});
