// Tilemaps in the editor (ADR 0103): the platformer sample's level draws, the Tile Palette shows its
// tileset, and painting in the scene view is one undoable step.
import { expect, test, type Page } from "./fixtures";
import { menu, openMenu } from "./menus";

const EDITOR = "/editor.html?sample=platformer";

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  orbit: { focus(point?: [number, number, number], distance?: number): void };
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

test("paints tiles from the Tile Palette in the scene view, as one undo step", async ({ page }) => {
  await openEditor(page);
  await page.locator('.tree .row[data-key="level"]').click();
  await expect(page.locator(".tilemap-summary")).toContainText("2 layers");
  await page.getByRole("button", { name: "Open Tile Palette" }).click();
  const palette = page.locator(".tile-palette");
  await expect(palette).toBeVisible();
  await expect(palette.getByRole("listbox", { name: "Tiles" }).getByRole("option")).toHaveCount(22);
  await palette.getByRole("list", { name: "Layers" }).locator("li").nth(1).click(); // Ground
  await palette.getByRole("listbox", { name: "Tiles" }).getByRole("option").nth(21).click(); // a crate
  await expect(palette.getByRole("toolbar", { name: "Brush" }).getByRole("button", { name: "Pencil" })).toHaveAttribute("aria-pressed", "true");

  // Frame an empty spot of sky and paint across it.
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([30.5, 10.5, 0], 12));
  await page.waitForTimeout(300);
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const cx = canvas.x + canvas.width / 2, cy = canvas.y + canvas.height / 2;
  await page.mouse.move(cx - 60, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy, { steps: 5 });
  await page.mouse.move(cx + 60, cy, { steps: 5 });
  await page.mouse.up();

  const item = (name: RegExp) => page.locator(".menubar-menu").getByRole("menuitem", { name });
  await openMenu(page, "Edit");
  await expect(item(/^Undo Paint tiles/)).toBeVisible();
  await page.keyboard.press("Escape");
  await menu(page, "Edit", /^Undo Paint tiles/);
  await openMenu(page, "Edit");
  await expect(item(/^Redo Paint tiles/)).toBeVisible();
  await page.keyboard.press("Escape");
});

test("Create > Tilemap adds a tilemap node", async ({ page }) => {
  await openEditor(page);
  await menu(page, "Create", "Tilemap");
  await expect(page.locator(".tilemap-summary")).toContainText("1 layer");
});
