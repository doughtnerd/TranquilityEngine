import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, type Hooks, test, type Page, openEditor, waitForEditor } from "./fixtures";
import { captureView, pixelsChanged, steadyView } from "./viewCapture";
import { installFakeFolders, nextFolder } from "./fakeFolders";

// HDR environments and cascaded shadows (ADR 0053): an Environment component with an .hdr map
// lights the scene and draws it as the sky; tiers with cascades draw the sun's shadows through
// cascaded shadow maps following the camera. What the lighting rig does with a tier and an
// Environment (cascades, shadow maps, the map loaded, the skybox) is babylonLighting.test.ts's.

test.describe.configure({ timeout: 60_000 });

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

/**
 * An 8×2 Radiance HDR with flat (uncompressed) scanlines whose bytes are all ASCII, so it travels as text.
 * 8 pixels wide because Babylon's reader rejects narrower images.
 */
const TINY_HDR = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 8\n${"dPx\u007f".repeat(16)}`;


function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

/** The editor's World has stepped `n` more frames: the scene view keeps drawing. */
async function keepsDrawing(page: Page, n = 10): Promise<void> {
  const frames = await page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount), { timeout: 20_000 }).toBeGreaterThan(frames + n);
}
const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

test("cascaded shadows follow the quality tier", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "playground3d" });
  // High has 3 cascades, and the sample's Sun casts shadows; Low has 1 (ordinary shadows), Ultra 4. Frames keep coming
  // as the shadow maps are rebuilt for each.
  await keepsDrawing(page);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Low");
  await keepsDrawing(page);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Ultra");
  await keepsDrawing(page);
  expect(errors).toEqual([]);
});

test("an Environment component with an HDR map lights the scene and draws the sky", { tag: "@slow" }, async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: { ...sampleFiles(), "environments/sky.hdr": TINY_HDR } });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await waitForEditor(page);

  // .hdr files are Environment assets.
  await page.locator(".asset-folder", { hasText: /^environments$/ }).click();
  await expect(page.locator(".asset-tile", { hasText: "sky.hdr" }).locator(".asset-kind")).toHaveText("Environment");

  // Add an Environment to the Sun's node and give it the map.
  await row(page, "Sun").click();
  await page.getByRole("button", { name: "Add Component" }).click();
  await page.getByRole("searchbox", { name: "Search components" }).fill("environment");
  await page.getByRole("searchbox", { name: "Search components" }).press("Enter");
  const env = page.locator(".inspector-body .component").filter({ has: page.getByRole("checkbox", { name: "Environment enabled", exact: true }) });
  await expect(env).toBeVisible();
  const map = env.getByRole("combobox", { name: "map" });
  const view = page.locator(".viewport canvas");
  const studio = await steadyView(view);
  await map.selectOption("environments/sky.hdr");
  // The tiny map lights the scene and draws as the sky: the view changes from the studio room's. The HDR map is
  // prefiltered on the GPU: with software GL that's seconds of CPU, more while other specs render.
  await expect.poll(async () => pixelsChanged(studio, await captureView(view)), { timeout: 30_000, message: "pixels the HDR sky and lighting change" }).toBeGreaterThan((studio.width * studio.height) / 10);

  // Turning the skybox off keeps the lighting but drops the sky: the view changes again.
  const sky = await steadyView(view);
  await env.getByRole("checkbox", { name: "skybox" }).uncheck();
  await expect.poll(async () => pixelsChanged(sky, await captureView(view)), { timeout: 20_000, message: "pixels the skybox covered" }).toBeGreaterThan((sky.width * sky.height) / 20);
  expect(errors).toEqual([]);
});
