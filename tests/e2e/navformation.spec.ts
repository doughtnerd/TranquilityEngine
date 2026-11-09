import { expect, test, type Locator, type Page } from "./fixtures";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// Formation assets (ADR 0065, Foxfire's NavFormation): New Navigation Formation in the Assets panel's menu makes
// navigation/New Formation.formation.json; the Inspector's formation editor paints cells (left drag paints, right
// drag erases), which writes the file and can be undone; a NavGroup takes the asset in its formationAsset field and
// shows its preview with an Edit button that selects the asset again.

test.describe.configure({ timeout: 60_000 });

type Hooks = { engine?: { world: { time: { frameCount: number } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const PROJECT = {
  "project.json": JSON.stringify({ name: "Formations" }, null, 2),
  "navigation/.keep": "",
  "scenes/main.scene.json": JSON.stringify(
    {
      format: "myco.scene@1",
      nodes: [
        { id: "camera", name: "Camera", components: [{ type: "engine.Transform", data: { position: [0, 8, 12] } }, { type: "engine.Camera", data: {} }] },
        { id: "squad", name: "Squad", components: [{ type: "engine.Transform", data: {} }] },
      ],
    },
    null,
    2,
  ),
};

async function open(page: Page): Promise<void> {
  await installFakeFolders(page, { Formations: PROJECT });
  await page.goto("/editor.html");
  await nextFolder(page, "Formations");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("not visible");
  return b;
}

const FILE = "Formations/navigation/New Formation.formation.json";
const cellsOf = async (page: Page): Promise<string[]> => (JSON.parse((await readFile(page, FILE)) ?? "{}") as { cells?: string[] }).cells ?? [];

/** Drags across the grid from cell (x0, row0) to (x1, row1) with a mouse button. */
async function paint(page: Page, grid: Locator, from: [number, number], to: [number, number], button: "left" | "right" = "left"): Promise<void> {
  const b = await box(grid);
  const cell = Number(await grid.getAttribute("data-cell"));
  const at = ([x, row]: [number, number]) => ({ x: b.x + (x + 0.5) * cell, y: b.y + (row + 0.5) * cell });
  const a = at(from), z = at(to);
  await page.mouse.move(a.x, a.y);
  await page.mouse.down({ button });
  await page.mouse.move((a.x + z.x) / 2, (a.y + z.y) / 2, { steps: 4 });
  await page.mouse.move(z.x, z.y, { steps: 4 });
  await page.mouse.up({ button });
}

test("a formation asset is created, painted, undone and assigned to a NavGroup", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await open(page);

  // Create › Navigation › Formation (the Assets panel's background menu): a 16 × 16 mask, nothing painted.
  await page.locator(".asset-folder", { hasText: /^navigation$/ }).click();
  const items = await box(page.locator(".panel.assets .asset-items"));
  await page.mouse.click(items.x + items.width - 10, items.y + items.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Navigation Formation" }).click();
  await expect(page.locator(".asset-tile.selected")).toContainText("New Formation.formation.json");
  const editor = page.getByLabel("Formation", { exact: true });
  await expect(editor.getByRole("combobox", { name: "Shape" })).toHaveValue("mask");
  await expect.poll(async () => (await cellsOf(page)).length).toBe(16);

  // Smaller grid: 5 × 3.
  await editor.getByRole("spinbutton", { name: "Width" }).fill("5");
  await editor.getByRole("spinbutton", { name: "Width" }).press("Enter");
  await editor.getByRole("spinbutton", { name: "Height" }).fill("3");
  await editor.getByRole("spinbutton", { name: "Height" }).press("Enter");
  await expect.poll(() => cellsOf(page)).toEqual([".....", ".....", "....."]);

  // Paint the front row, then a cell behind its middle; erase one end with the right button.
  const grid = editor.getByLabel("Formation grid");
  await paint(page, grid, [0, 0], [4, 0]);
  await expect.poll(() => cellsOf(page)).toEqual(["#####", ".....", "....."]);
  await paint(page, grid, [2, 1], [2, 1]);
  await paint(page, grid, [4, 0], [4, 0], "right");
  await expect.poll(() => cellsOf(page)).toEqual(["####.", "..#..", "....."]);
  await expect(editor.getByLabel("Slot count")).toHaveText("5 slots");

  // Undo the erase (the formation's own history), then Mirror.
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => cellsOf(page)).toEqual(["#####", "..#..", "....."]);
  await editor.getByRole("button", { name: "Invert" }).click();
  await expect.poll(() => cellsOf(page)).toEqual([".....", "##.##", "#####"]);
  await editor.getByRole("button", { name: "Undo" }).click();
  await expect.poll(() => cellsOf(page)).toEqual(["#####", "..#..", "....."]);
  await editor.getByLabel("Show fill order").check();

  // A NavGroup on Squad takes the asset; its Inspector previews it, and Edit selects the asset again.
  await page.locator('.tree .row[data-key="squad"]').click();
  await page.getByRole("button", { name: "Add Component" }).click();
  const search = page.getByRole("searchbox", { name: "Search components" });
  await search.fill("NavGroup");
  await search.press("Enter");
  const group = page.locator(".inspector-body .component", { has: page.locator("h3", { hasText: "NavGroup" }) });
  await expect(group).toBeVisible();
  const field = group.getByRole("combobox", { name: "formationAsset" });
  await field.fill("asset:navigation/New Formation.formation.json");
  await field.press("Enter");
  const preview = group.getByLabel("Group formation");
  await expect(preview).toContainText("New Formation.formation.json");
  await expect(preview).toContainText("5 × 3, 6 slots");
  await expect(preview.getByLabel("Formation preview")).toBeVisible();
  await preview.getByRole("button", { name: "Edit" }).click();
  await expect(page.locator(".asset-tile.selected")).toContainText("New Formation.formation.json");
  await expect(page.getByLabel("Formation", { exact: true }).getByLabel("Formation grid")).toBeVisible();
  expect(errors).toEqual([]);
});
