import { expect, openTestProject, type Page, test } from "./fixtures";
import { closeMenus, undoItem } from "./menus";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra?: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

/** The Flappy sample as a writable project folder in memory. */
async function openProject(page: Page): Promise<void> {
  await openTestProject(page);
  await expect(page.locator(".scene-tab")).toHaveCount(1);
}

const tabs = (page: Page) => page.locator(".scene-tab .scene-tab-name").allTextContents();
const tab = (page: Page, name: string) => page.locator(".scene-tab", { hasText: name });
const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const assets = (page: Page) => page.locator(".panel.assets");
const birdY = (page: Page) => page.getByRole("textbox", { name: "position y" });

async function setBirdY(page: Page, value: string): Promise<void> {
  await row(page, "bird").click();
  await birdY(page).fill(value);
  await birdY(page).press("Enter");
  await expect(birdY(page)).toHaveValue(value);
}

async function openPipePair(page: Page): Promise<void> {
  await assets(page).getByRole("navigation", { name: "Folders" }).getByRole("button", { name: "prefabs", exact: true }).click();
  await assets(page).locator(".asset-tile").filter({ hasText: "pipe-pair.prefab.json" }).dblclick();
  await expect(page.locator(".scene-name")).toHaveText("pipe-pair.prefab.json");
}

test("each open scene has a tab with its own unsaved edits and undo history", async ({ page }) => {
  await openEditor(page);
  expect(await tabs(page)).toEqual(["main.scene.json"]);
  await setBirdY(page, "5");
  await expect(tab(page, "main.scene.json")).toContainText("•");

  await openPipePair(page);
  expect(await tabs(page)).toEqual(["main.scene.json •", "pipe-pair.prefab.json"]);
  await expect(tab(page, "pipe-pair")).toHaveAttribute("aria-selected", "true");
  await expect(await undoItem(page)).toBeDisabled(); // its own history
  await closeMenus(page);
  await expect(row(page, "bird")).toHaveCount(0);

  // Back to the scene: the edit and its undo are still there. (Clicking the prefab in the Assets
  // panel deselected the nodes, so the selection is made again here.)
  await tab(page, "main.scene.json").click();
  await expect(page.locator(".scene-name")).toContainText("main.scene.json");
  await row(page, "bird").click();
  await expect(row(page, "bird")).toHaveClass(/selected/);
  // A tab keeps its selection while another is active.
  await tab(page, "pipe-pair").click();
  await expect(row(page, "bird")).toHaveCount(0);
  await tab(page, "main.scene.json").click();
  await expect(row(page, "bird")).toHaveClass(/selected/);
  await expect(birdY(page)).toHaveValue("5");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(birdY(page)).not.toHaveValue("5");
  await expect(tab(page, "main.scene.json")).not.toContainText("•");

  // Opening an open scene again switches to its tab.
  await openPipePair(page);
  expect(await tabs(page)).toEqual(["main.scene.json", "pipe-pair.prefab.json"]);
});

test("closing a tab with unsaved changes asks first", async ({ page }) => {
  await openEditor(page);
  await openPipePair(page);
  await tab(page, "main.scene.json").click();
  await setBirdY(page, "6");
  await page.getByRole("button", { name: "Close main.scene.json" }).click();
  const dialog = page.getByRole("alertdialog");
  await expect(dialog).toContainText("unsaved changes");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  expect(await tabs(page)).toEqual(["main.scene.json •", "pipe-pair.prefab.json"]);

  await page.getByRole("button", { name: "Close main.scene.json" }).click();
  await page.getByRole("alertdialog").getByRole("button", { name: "Close without saving" }).click();
  expect(await tabs(page)).toEqual(["pipe-pair.prefab.json"]);
  await expect(page.locator(".scene-name")).toHaveText("pipe-pair.prefab.json"); // the neighbour is active

  await page.getByRole("button", { name: "Close pipe-pair.prefab.json" }).click(); // clean: no question
  await expect(page.locator(".scene-tab")).toHaveCount(0);
  await expect(page.locator(".panel.hierarchy")).toContainText("No scene open");
});

test("New Scene in the Assets panel writes a scene with a camera and opens it; Save saves the active tab", async ({ page }) => {
  await openProject(page);
  const empty = (await assets(page).locator(".asset-items").boundingBox())!;
  await page.mouse.click(empty.x + empty.width - 10, empty.y + empty.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Scene" }).click();
  expect(await tabs(page)).toEqual(["main.scene.json", "New Scene.scene.json"]);
  await expect(page.locator(".scene-name")).toHaveText("New Scene.scene.json");
  await expect(row(page, "camera")).toHaveCount(1);
  const text = await page.evaluate(() => (window as unknown as Hooks).testFolder.read("New Scene.scene.json"));
  expect(JSON.parse(text!)).toMatchObject({ format: "myco.scene@1", nodes: [{ id: "camera", components: [{ type: "engine.Transform" }, { type: "engine.Camera" }] }] });

  // The clipboard survives switching scenes: copy Bird from the main scene, paste it here.
  await tab(page, "main.scene.json").click();
  await row(page, "bird").click();
  await page.keyboard.press("ControlOrMeta+c");
  await tab(page, "New Scene").click();
  await row(page, "camera").click();
  await page.keyboard.press("ControlOrMeta+v");
  await expect(row(page, "bird")).toHaveClass(/selected/);
  await expect(tab(page, "New Scene")).toContainText("•");

  await page.keyboard.press("ControlOrMeta+s");
  await expect(tab(page, "New Scene")).not.toContainText("•");
  const saved = await page.evaluate(() => (window as unknown as Hooks).testFolder.read("New Scene.scene.json"));
  expect(saved).toContain('"bird"');
  expect(await page.evaluate(() => (window as unknown as Hooks).testFolder.read("scenes/main.scene.json"))).not.toContain('"bird-2"');
});

test("Play plays the active tab", async ({ page }) => {
  await openEditor(page);
  await openPipePair(page);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.locator(".status-bar")).toContainText("Playing prefabs/pipe-pair.prefab.json");
});
