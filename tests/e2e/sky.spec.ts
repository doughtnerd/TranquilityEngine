import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, type Hooks, test, type Page, waitForEditor } from "./fixtures";
import { assetsMenu } from "./menus";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// Procedural skies (ADR 0112–0114): an Environment with a *.sky.json map draws the sky live, bakes
// it to a cubemap for lighting, and drives the sun; the Sky component sets the time of day. When the
// sky bakes again (on a change, throttled) and which time it shows is sky.test.ts's.

test.describe.configure({ timeout: 90_000 });

const SAMPLE = "samples/playground3d";
function sampleFiles(dir = SAMPLE): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, sampleFiles(full));
    else if (name !== "sample.json") out[relative(SAMPLE, full).split(sep).join("/")] = readFileSync(full, "utf8");
  }
  return out;
}


function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

/** The editor's World has stepped `n` more frames: the scene view keeps drawing (a failing bake would stop the render loop). */
async function keepsDrawing(page: Page, n = 10): Promise<void> {
  const frames = await page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount), { timeout: 20_000 }).toBeGreaterThan(frames + n);
}
const assets = (page: Page) => page.locator(".assets");

async function openPlayground(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await installFakeFolders(page, { Playground: { ...sampleFiles(), ...extra } });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await waitForEditor(page);
}

async function openScene(page: Page, folder: string, file: string): Promise<void> {
  await assets(page).locator(".asset-folder", { hasText: new RegExp(`^${folder}$`) }).dblclick();
  await assets(page).locator(".asset-tile").filter({ hasText: file }).dblclick();
}

test("a sky asset draws in its scene, opens in the Sky panel, and moving its sun saves the file", { tag: "@slow" }, async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openPlayground(page);
  await openScene(page, "scenes", "skies.scene.json");
  await expect(page.locator(".scene-name")).toContainText("skies");
  await keepsDrawing(page); // the sky draws and bakes the scene's lighting

  // Sky assets are listed as such and open in the Sky panel.
  await assets(page).locator(".asset-folder", { hasText: /^skies$/ }).first().click();
  const tile = assets(page).locator(".asset-tile").filter({ hasText: "clear-day.sky.json" });
  await expect(tile.locator(".asset-kind")).toHaveText("Sky");
  await tile.dblclick();
  const panel = page.locator(".sky-panel");
  await expect(panel).toBeVisible({ timeout: 20_000 }); // a lazily loaded panel

  // Moving the sun writes the file and rebakes the scene's lighting.
  const time = panel.getByRole("spinbutton", { name: "Time of day value" });
  await time.fill("17.5");
  await time.press("Enter");
  await expect.poll(async () => JSON.parse((await readFile(page, "Playground/skies/clear-day.sky.json")) ?? "{}").sun?.timeOfDay).toBe(17.5);
  await keepsDrawing(page); // the scene takes the new time and rebakes
  await page.screenshot({ path: test.info().outputPath("sky-panel.png") });
  expect(errors).toEqual([]);
});

test("New Sky creates a sky asset from the Clear Day preset", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openPlayground(page);
  await assets(page).locator(".asset-folder", { hasText: /^skies$/ }).first().click();
  const list = (await assets(page).locator(".asset-items").boundingBox())!;
  await page.mouse.click(list.x + list.width - 10, list.y + list.height - 10, { button: "right" });
  await assetsMenu(page, "Create", "Rendering", "Sky");
  await expect.poll(async () => (await readFile(page, "Playground/skies/New Sky.sky.json")) ?? "").toContain('"format": "myco.sky@1"');
  await expect(assets(page).locator(".asset-tile").filter({ hasText: "New Sky.sky.json" })).toBeVisible();
  expect(errors).toEqual([]);
});
