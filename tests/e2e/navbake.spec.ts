import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, listFolder, nextFolder, readFile } from "./fakeFolders";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";

// Navigation baking in the editor (ADR 0065): a NavChunk added to a scene bakes in the bake worker into
// scenes/main.nav.bin, the Inspector shows the bake's summary and points the chunk at the file; the
// Project panel's Navigation section adds an agent type to project.json.

test.describe.configure({ timeout: 60_000 });

type Hooks = { engine?: { world: { time: { frameCount: number } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const PROJECT = {
  "project.json": JSON.stringify({ name: "Nav" }, null, 2),
  "scenes/main.scene.json": JSON.stringify(
    {
      format: "myco.scene@1",
      settings: { physics: "3d" },
      nodes: [
        { id: "camera", name: "Camera", components: [{ type: "engine.Transform", data: { position: [0, 8, 12], rotation: [-0.3, 0, 0, 0.95] } }, { type: "engine.Camera", data: {} }] },
        { id: "level", name: "Level", components: [{ type: "engine.Transform", data: {} }] },
        { id: "ground", name: "Ground", parent: "level", components: [{ type: "engine.Transform", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:plane" } }] },
        { id: "crate", name: "Crate", parent: "level", components: [{ type: "engine.Transform", data: { position: [1, 0.5, 1] } }, { type: "engine.BoxCollider", data: {} }, { type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }] },
      ],
    },
    null,
    2,
  ),
};

async function openNavProject(page: Page): Promise<void> {
  await installFakeFolders(page, { Nav: PROJECT });
  await page.goto("/editor.html");
  await nextFolder(page, "Nav");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

const card = (page: Page, name: string) => page.locator(".inspector-body .component", { has: page.locator("h3", { hasText: name }) });

test("a NavChunk bakes into scenes/main.nav.bin and the Inspector shows the bake", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openNavProject(page);

  await page.locator('.tree .row[data-key="level"]').click();
  await page.getByRole("button", { name: "Add Component" }).click();
  const search = page.getByRole("searchbox", { name: "Search components" });
  await search.fill("NavChunk");
  await search.press("Enter");
  const chunk = card(page, "NavChunk");
  await expect(chunk).toBeVisible();
  const bake = chunk.getByLabel("Navigation bake");
  await expect(bake.getByText("Not baked yet")).toBeVisible();

  await bake.getByRole("button", { name: "Bake", exact: true }).click();
  const summary = bake.getByLabel("Last bake");
  await expect(summary).toContainText(/scenes\/main\.nav\.bin: [\d,]+ polys/, { timeout: 30_000 });
  await expect(bake.getByText("Up to date")).toBeVisible();
  expect(await listFolder(page, "Nav")).toEqual(expect.arrayContaining(["scenes/main.nav.bin", ".myco/nav/scenes/main.nav.bin.json"]));
  // The chunk points at its file (an undoable edit; the scene shows unsaved changes).
  await expect(chunk.getByRole("combobox", { name: "bake" })).toHaveValue(/scenes\/main\.nav\.bin/);
  await expect(page.locator(".status-bar .status-text")).toContainText(/Baked Level/);

  // Moving geometry makes the bake stale; a rebake catches up.
  await page.locator('.tree .row[data-key="ground"]').click();
  const y = card(page, "Transform").getByRole("textbox", { name: "position y" });
  await y.fill("1");
  await y.press("Enter");
  await page.locator('.tree .row[data-key="level"]').click();
  await expect(bake.getByRole("status")).toContainText(/changed since this bake/, { timeout: 10_000 });
  await bake.getByRole("button", { name: "Rebake" }).click();
  await expect(bake.getByText("Up to date")).toBeVisible({ timeout: 30_000 });

  expect(errors).toEqual([]);
});

test("the Project panel's Navigation section adds an agent type to project.json", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openNavProject(page);
  await showTab(page, /^Project/);
  await pickCategory(page, "Navigation");
  const nav = page.locator(".panel.project").getByRole("group", { name: "Navigation settings" });
  await expect(nav.getByRole("group", { name: "Agent type Humanoid" })).toBeVisible();
  await expect(nav.getByLabel("Humanoid voxels")).toContainText("0.25 × 0.125");

  await nav.getByRole("button", { name: "+ Agent type" }).click();
  await expect(nav.getByRole("group", { name: "Agent type Agent" })).toBeVisible();
  await expect.poll(async () => JSON.parse((await readFile(page, "Nav/project.json")) ?? "{}").navigation?.agentTypes?.map((t: { name: string }) => t.name)).toEqual(["Humanoid", "Agent"]);

  // A value the settings reject is a problem and isn't saved; undo takes it back.
  const radius = nav.getByRole("spinbutton", { name: "Agent radius", exact: true });
  await radius.fill("-1");
  await radius.press("Enter");
  await expect(page.locator(".panel.project .project-settings-problems")).toContainText(/walk\.radius should be at least/);
  await page.locator(".panel.project .project-settings-toolbar").getByRole("button", { name: "Undo" }).click();
  await expect(page.locator(".panel.project .project-settings-problems")).toHaveCount(0);
  await page.locator(".panel.project .project-settings-toolbar").getByRole("button", { name: "Undo" }).click();
  await expect.poll(async () => JSON.parse((await readFile(page, "Nav/project.json")) ?? "{}").navigation?.agentTypes?.length ?? 1).toBe(1);

  expect(errors).toEqual([]);
});
