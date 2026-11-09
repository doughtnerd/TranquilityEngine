import { expect, test, type Page } from "./fixtures";
import { showTab } from "./tabs";
import { menu } from "./menus";
import { pickCategory } from "./projectCategory";

// The Project panel (ADR 0038) on a writable in-memory copy of the Flappy sample: edits save into
// project.json beside the Worlds panel's bootstrap, problems keep the file at its last valid
// settings, and undo takes edits back.
const EDITOR = "/editor.html?sample=flappy"; // relative to baseURL (E2E_PORT)

// Each test opens the sample, then a copy of it; WebKit renders on the CPU, and with 8 workers
// these take 20–30 s there.
test.describe.configure({ timeout: 60_000 });

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  openTestProject(extra: Record<string, string>): Promise<void>;
  testFolder: { read(path: string): string | undefined };
};

async function waitForEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

async function openProject(page: Page): Promise<void> {
  await waitForEditor(page);
  await page.evaluate(() => (window as unknown as Hooks).openTestProject({}));
  await showTab(page, /^Project/);
}

const panel = (page: Page) => page.locator(".panel.project");
const projectJson = async (page: Page) => JSON.parse((await page.evaluate(() => (window as unknown as Hooks).testFolder.read("project.json")))!);
const status = (page: Page) => panel(page).locator(".project-settings-status");

async function commit(page: Page, label: string, value: string): Promise<void> {
  const box = panel(page).getByRole("textbox", { name: label, exact: true });
  await box.fill(value);
  await box.press("Enter");
}

test("edits save to project.json, problems hold the save back, and Ctrl+Z undoes", async ({ page }) => {
  await openProject(page);
  const p = panel(page);
  await expect(status(page)).toHaveText("Saved");
  await expect(p.getByRole("textbox", { name: "Project name" })).toHaveValue("flappy");

  await pickCategory(page, "Display");
  await commit(page, "Display width", "800");
  await expect.poll(async () => (await projectJson(page)).display.width).toBe(800);
  await expect(status(page)).toHaveText("Saved");

  // An invalid value is listed and not saved.
  await commit(page, "Display height", "0");
  await expect(p.getByRole("list", { name: "Problems" })).toContainText("Display height must be a whole number");
  await expect(status(page)).toHaveText("● Not saved: 1 problem");
  expect((await projectJson(page)).display.height).toBe(680);

  // Undo (button), then Ctrl+Z with the panel focused.
  await p.getByRole("button", { name: "Undo" }).click();
  await expect(p.getByRole("list", { name: "Problems" })).toHaveCount(0);
  await expect(p.getByRole("textbox", { name: "Display height" })).toHaveValue("680");
  await p.locator(".project-settings-toolbar").click();
  await page.keyboard.press("ControlOrMeta+z");
  await expect(p.getByRole("textbox", { name: "Display width" })).toHaveValue("720");
  await expect.poll(async () => (await projectJson(page)).display.width).toBe(720);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => (await projectJson(page)).display.width).toBe(800);

  // Renaming the project renames it in the toolbar too.
  await pickCategory(page, "Project");
  await commit(page, "Project name", "Flappy Deluxe");
  await expect.poll(async () => (await projectJson(page)).name).toBe("Flappy Deluxe");
  await expect(page.locator(".project-name")).toHaveText("Flappy Deluxe");
});

test("physics layers and the collision grid", async ({ page }) => {
  await openProject(page);
  await pickCategory(page, "Physics");
  const p = panel(page);
  const grid = p.locator(".collision-matrix");
  await expect(grid.getByRole("checkbox", { name: "Player collides with Ground" })).toBeChecked();
  await expect(grid.getByRole("checkbox", { name: "Player collides with Player" })).not.toBeChecked();

  await grid.getByRole("checkbox", { name: "Player collides with Ground" }).uncheck();
  await expect.poll(async () => (await projectJson(page)).physics.collisionMatrix).toEqual({ Player: ["Obstacle", "Score", "Bounds"] });

  // Add a layer and name it; the matrix gets a row and column for it.
  await p.getByRole("button", { name: "+ Layer" }).click();
  await commit(page, "layer 7", "Pickup");
  await expect.poll(async () => (await projectJson(page)).physics.layers.at(-1)).toBe("Pickup");
  await grid.getByRole("checkbox", { name: "Player collides with Pickup" }).check();
  await expect.poll(async () => (await projectJson(page)).physics.collisionMatrix.Player).toEqual(["Obstacle", "Score", "Bounds", "Pickup"]);

  // A duplicate name is a problem.
  await commit(page, "layer 7", "Ground");
  await expect(p.getByRole("list", { name: "Problems" })).toContainText('"Ground" is listed twice');
  await p.getByRole("button", { name: "Undo" }).click();
  await expect(p.getByRole("list", { name: "Problems" })).toHaveCount(0);
});

test("sorting layers reorder, and autoloads come and go", async ({ page }) => {
  await openProject(page);
  const p = panel(page);
  await pickCategory(page, "Rendering");
  // Sorting layers: move Player one step towards the back.
  const sorting = p.getByRole("group", { name: "Sorting layers" });
  await sorting.getByRole("button", { name: "Move Player up" }).click();
  await expect.poll(async () => (await projectJson(page)).render.sortingLayers).toEqual(["Background", "Pipes", "Default", "Player", "Foreground"]);

  // Autoloads: remove the music prefab, add it back.
  await pickCategory(page, "Autoloads");
  const autoloads = p.getByRole("group", { name: "Autoload list" });
  await autoloads.getByRole("button", { name: "Remove autoload prefabs/music.prefab.json" }).click();
  await expect.poll(async () => (await projectJson(page)).autoload).toEqual([]);
  await autoloads.getByRole("combobox", { name: "Add an autoload" }).selectOption("prefabs/music.prefab.json");
  await expect.poll(async () => (await projectJson(page)).autoload).toEqual(["prefabs/music.prefab.json"]);

  // Build settings for export (ADR 0041).
  await pickCategory(page, "Build");
  await commit(page, "Version", "1.0");
  await expect(p.getByRole("list", { name: "Problems" })).toContainText("must look like 1.2.3");
  await commit(page, "Version", "1.0.0");
  await commit(page, "App identifier", "com.example.flappy");
  await expect.poll(async () => (await projectJson(page)).build).toEqual({ version: "1.0.0", identifier: "com.example.flappy" });
});

test("the Project and Worlds panels both save into project.json without losing each other's edits", async ({ page }) => {
  await openProject(page);
  await pickCategory(page, "Rendering");
  await commit(page, "Pixels per unit", "64");
  await expect.poll(async () => (await projectJson(page)).render.pixelsPerUnit).toBe(64);

  await showTab(page, /^Worlds/);
  await page.locator(".panel.worlds").getByRole("button", { name: "+ World" }).click();
  await expect.poll(async () => (await projectJson(page)).bootstrap?.worlds?.length).toBe(2);
  expect((await projectJson(page)).render.pixelsPerUnit).toBe(64);

  await showTab(page, /^Project/);
  await expect(panel(page).getByRole("button", { name: "Undo" })).toBeEnabled(); // its history survived the Worlds save
  await pickCategory(page, "Time");
  await commit(page, "Max frame time", "0.1");
  await expect.poll(async () => (await projectJson(page)).time.maxFrameTime).toBe(0.1);
  expect((await projectJson(page)).bootstrap.worlds).toHaveLength(2);
  await showTab(page, /^Worlds/);
  await expect(page.locator(".panel.worlds").getByRole("button", { name: "Undo" })).toBeEnabled(); // and the Worlds panel's survived this one
});

test("a sample is read-only in the Project panel", async ({ page }) => {
  await waitForEditor(page);
  await showTab(page, /^Project/);
  await expect(status(page)).toHaveText("Read-only");
  await pickCategory(page, "Display");
  await expect(panel(page).getByRole("textbox", { name: "Display width" })).toBeDisabled();
  await pickCategory(page, "Physics");
  await expect(panel(page).locator(".collision-matrix input").first()).toBeDisabled();
});

test("the Project menu's Project Settings shows the panel", async ({ page }) => {
  await openProject(page);
  await showTab(page, /^Inspector/);
  await expect(panel(page)).toHaveCount(0);
  await menu(page, "File", "Project Settings");
  await expect(panel(page)).toBeVisible();
});
