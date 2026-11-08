import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";

// Named avoidance layers (ADR 0066, Foxfire's Avoidance Layers page): the Project panel's Navigation section names
// a layer, puts an agent type on it and edits the who-avoids-whom matrix; project.json follows.

test.describe.configure({ timeout: 60_000 });

type Hooks = { engine?: { world: { time: { frameCount: number } } } };

const PROJECT = {
  "project.json": JSON.stringify({ name: "Layers" }, null, 2),
  "scenes/main.scene.json": JSON.stringify({ format: "myco.scene@1", nodes: [{ id: "camera", name: "Camera", components: [{ type: "engine.Transform", data: {} }, { type: "engine.Camera", data: {} }] }] }, null, 2),
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

/** Shows the Navigation settings, whether the Project panel lists categories as tabs or a dropdown (it waits for the lazy panel). */
const showNavigation = (page: Page) => pickCategory(page, "Navigation");

const navigation = async (page: Page) => JSON.parse((await readFile(page, "Layers/project.json")) ?? "{}").navigation ?? {};

test("names an avoidance layer, puts an agent type on it and edits the matrix", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Layers: PROJECT });
  await page.goto("/editor.html");
  await nextFolder(page, "Layers");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await showTab(page, /^Project/);
  await showNavigation(page);
  const nav = page.locator(".panel.project").getByRole("group", { name: "Navigation settings" });
  await expect(nav.getByRole("group", { name: "Avoidance layer names" })).toBeVisible();

  // Add a layer (the next free slot, 1) and name it.
  await nav.getByRole("button", { name: "+ Avoidance layer" }).click();
  const name = nav.getByRole("textbox", { name: "Avoidance layer 1 name" });
  await expect(name).toHaveValue("Layer 1");
  await name.fill("Enemy");
  await name.press("Enter");
  await expect.poll(async () => (await navigation(page)).avoidanceLayers).toEqual(["Default", "Enemy"]);

  // Put Humanoid on Enemy: one layer, bit 2.
  const card = nav.getByRole("group", { name: "Agent type Humanoid" });
  await card.getByRole("combobox", { name: "Humanoid avoidance layer" }).selectOption({ label: "Enemy" });
  await expect.poll(async () => (await navigation(page)).agentTypes?.[0]?.avoidance?.layers).toBe(2);
  const summary = card.getByLabel("Humanoid avoidance summary");
  await expect(summary).toContainText("On: Enemy");
  await expect(summary).toContainText("Avoids: Everything");
  await expect(summary).toContainText("Avoided by: Humanoid");

  // The matrix: one row (Enemy, with Humanoid), every cell ticked (it avoids Everything). Clearing Default.
  const matrix = nav.getByRole("table", { name: "Who avoids whom" });
  await expect(matrix.getByRole("rowheader", { name: "Enemy (Humanoid)" })).toBeVisible();
  const cell = matrix.getByRole("checkbox", { name: "Enemy avoids Default" });
  await expect(cell).toBeChecked();
  await cell.click();
  await expect(cell).not.toBeChecked();
  await expect.poll(async () => (await navigation(page)).agentTypes?.[0]?.avoidance?.avoidLayers).toBe(0xffffffff - 1);
  await expect(matrix.getByRole("checkbox", { name: "Enemy avoids Enemy" })).toBeChecked();

  // One undoable edit.
  await page.locator(".panel.project .project-settings-toolbar").getByRole("button", { name: "Undo" }).click();
  await expect(cell).toBeChecked();
  await expect.poll(async () => (await navigation(page)).agentTypes?.[0]?.avoidance?.avoidLayers).toBe(0xffffffff);

  expect(errors).toEqual([]);
});
