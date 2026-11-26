// Tilemaps in the editor (ADR 0103): the platformer sample's level draws, the Tile Palette shows its
// tileset, and painting in the scene view is one undoable step.
import { afterFrames, expect, test, openEditor, type Hooks } from "./fixtures";
import { menu, openMenu } from "./menus";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

test("paints tiles from the Tile Palette in the scene view, as one undo step", async ({ page }) => {
  await openEditor(page, { sample: "platformer" });
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
  await afterFrames(page); // the camera moves on the next frame
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

test("Create > 2D > Tilemap adds a tilemap node", async ({ page }) => {
  await openEditor(page, { sample: "platformer" });
  await menu(page, "Create", "2D", "Tilemap");
  await expect(page.locator(".tilemap-summary")).toContainText("1 layer");
});

// --- ADR 0276, 0421–0426 ----------------------------------------------------------------------------------------------

/** Focus the scene view on a world point and give the canvas point at its centre. */
async function focusAt(page: import("./fixtures").Page, x: number, y: number): Promise<{ cx: number; cy: number }> {
  await page.evaluate(([px, py]) => (window as unknown as Hooks).orbit.focus([px, py, 0], 12), [x, y]);
  await afterFrames(page);
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  return { cx: canvas.x + canvas.width / 2, cy: canvas.y + canvas.height / 2 };
}

test("clicking a tile in the scene view selects its tilemap", async ({ page }) => {
  await openEditor(page, { sample: "platformer" });
  const { cx, cy } = await focusAt(page, 3.5, 1.5); // a ground tile of the platformer's level
  await page.mouse.click(cx, cy);
  await expect(page.locator('.tree .row[data-key="level"]')).toHaveClass(/selected/);
  await expect(page.locator(".tilemap-summary")).toContainText("2 layers");
});

/** The platformer sample's files, for a writable copy (`openEditor(page, { files })` writes them over the Flappy sample). */
function platformerFiles(): Record<string, string | Uint8Array> {
  const root = fileURLToPath(new URL("../../samples/platformer", import.meta.url));
  const out: Record<string, string | Uint8Array> = {};
  const walk = (dir: string): void => {
    for (const e of fs.readdirSync(path.join(root, dir), { withFileTypes: true })) {
      const rel = dir ? `${dir}/${e.name}` : e.name;
      if (e.isDirectory()) walk(rel);
      else if (rel === "sample.json") continue;
      else if (rel.endsWith(".png")) out[rel] = new Uint8Array(fs.readFileSync(path.join(root, rel)));
      else out[rel] = fs.readFileSync(path.join(root, rel), "utf8");
    }
  };
  walk("");
  return out;
}

test("the selection tool deletes the selected cells as one undo step, and locked layers aren't painted", async ({ page }) => {
  await openEditor(page, { files: platformerFiles() });
  await page.locator('.tree .row[data-key="level"]').click();
  await page.getByRole("button", { name: "Open Tile Palette" }).click();
  const palette = page.locator(".tile-palette");
  await palette.getByRole("list", { name: "Layers" }).locator("li").nth(1).click(); // Ground
  await palette.getByRole("toolbar", { name: "Brush" }).getByRole("button", { name: "Select" }).click();

  const { cx, cy } = await focusAt(page, 4, 1.5);
  await page.mouse.move(cx - 40, cy - 10);
  await page.mouse.down();
  await page.mouse.move(cx + 40, cy + 10, { steps: 5 });
  await page.mouse.up();
  await palette.getByRole("toolbar", { name: "Selection" }).getByRole("button", { name: /^Delete/ }).click();

  const item = (name: RegExp) => page.locator(".menubar-menu").getByRole("menuitem", { name });
  await openMenu(page, "Edit");
  await expect(item(/^Undo Delete tiles/)).toBeVisible();
  await page.keyboard.press("Escape");
  await menu(page, "Edit", /^Undo Delete tiles/);

  // Lock Ground, then a pencil stroke on it paints nothing (no new undo step).
  await palette.getByRole("button", { name: "Ground locked" }).or(palette.getByRole("checkbox", { name: "Ground locked" })).click();
  await palette.getByRole("listbox", { name: "Tiles" }).getByRole("option").nth(21).click();
  await palette.getByRole("toolbar", { name: "Brush" }).getByRole("button", { name: "Pencil" }).click();
  const sky = await focusAt(page, 30.5, 10.5);
  await page.mouse.move(sky.cx - 40, sky.cy);
  await page.mouse.down();
  await page.mouse.move(sky.cx + 40, sky.cy, { steps: 5 });
  await page.mouse.up();
  await openMenu(page, "Edit");
  await expect(item(/^Undo Paint tiles/)).toHaveCount(0);
  await page.keyboard.press("Escape");
});

test("a Tiled map imports as a tileset and a prefab through Import as Myco assets…", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  const map = JSON.stringify({
    type: "map", version: "1.10", orientation: "isometric", renderorder: "right-down", width: 2, height: 2, tilewidth: 32, tileheight: 16, infinite: false,
    layers: [{ id: 1, name: "Floor", type: "tilelayer", width: 2, height: 2, x: 0, y: 0, visible: true, opacity: 1, data: [1, 2, 0, 1] }],
    tilesets: [{ firstgid: 1, name: "iso", tilewidth: 32, tileheight: 16, tilecount: 2, columns: 2, margin: 0, spacing: 0, image: "iso.png", imagewidth: 64, imageheight: 16,
      tiles: [{ id: 1, animation: [{ tileid: 0, duration: 200 }, { tileid: 1, duration: 200 }] }] }],
  });
  await openEditor(page, { files: { "levels/room.tmj": new TextEncoder().encode(map) } });
  const panel = page.locator(".panel.assets");
  await panel.locator(".asset-folder", { hasText: /^levels$/ }).click();
  const tile = (name: string) => panel.locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name}$`) }) });
  await tile("room(\\.tmj)?").click({ button: "right" });
  await page.getByRole("menuitem", { name: /^Import as Myco assets/ }).click();
  const dlg = page.getByRole("dialog");
  await dlg.getByRole("button", { name: /^Import$|^Overwrite and import$/ }).click();
  const read = (p: string) => page.evaluate((path) => (window as unknown as Hooks).testFolder.read(path) ?? null, p);
  await expect.poll(() => read("levels/iso.tileset.json")).not.toBeNull();
  const tileset = JSON.parse((await read("levels/iso.tileset.json"))!);
  expect(tileset.tiles).toHaveLength(2);
  expect(tileset.tiles[1].animation.frames).toHaveLength(2);
  const prefab = (await read("levels/room.prefab.json"))!;
  expect(prefab).toContain('"gridShape": "isometric"');
  expect(errors).toEqual([]);
});
