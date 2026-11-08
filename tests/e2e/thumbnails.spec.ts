import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, listFolder, nextFolder } from "./fakeFolders";

// Asset previews (ADR 0061): rendered thumbnails on the Assets panel's tiles, hover animation,
// audio waveforms and playback, the Inspector's clip player, and the `.myco/thumbnails/` cache a
// writable project reads back instead of rendering again.

test.describe.configure({ timeout: 90_000 });

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  thumbnails?: { renders(): number; reset(): void; where(): string | null };
  assetAudio?: { state(): { path: string; paused: boolean; time: number } | null };
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

async function openSample(page: Page, id: string): Promise<void> {
  await page.goto(`/editor.html?sample=${id}`);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 5);
}

const tile = (page: Page, name: string) => page.locator(".asset-tile", { hasText: name });
/** A tile's rendered image, once it has loaded. */
const renderedWidth = (page: Page, name: string) => tile(page, name).locator("img.asset-rendered").evaluate((img: HTMLImageElement) => (img.complete && img.src.startsWith("blob:") ? img.naturalWidth : 0)).catch(() => 0);

test("models and materials show rendered thumbnails; an animated effect plays on hover", async ({ page }) => {
  const errors = trackErrors(page);
  await openSample(page, "playground3d");
  await page.locator(".asset-folder", { hasText: /^models$/ }).click();
  await expect.poll(() => renderedWidth(page, "crate.obj"), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(() => renderedWidth(page, "robot.fbx"), { timeout: 30_000 }).toBeGreaterThan(0);
  await page.locator(".asset-folder", { hasText: /^materials$/ }).click();
  await expect.poll(() => renderedWidth(page, "metal.material.json"), { timeout: 30_000 }).toBeGreaterThan(0);

  // The campfire animates while hovered, and stops when the pointer leaves.
  await page.locator(".asset-folder", { hasText: /^effects$/ }).click();
  await expect.poll(() => renderedWidth(page, "campfire.particles.json"), { timeout: 30_000 }).toBeGreaterThan(0);
  await tile(page, "campfire.particles.json").locator(".asset-preview").hover();
  await expect(tile(page, "campfire.particles.json").locator("canvas.asset-animation")).toBeVisible({ timeout: 15_000 });
  await page.locator(".asset-folder", { hasText: /^effects$/ }).hover();
  await expect(tile(page, "campfire.particles.json").locator("canvas.asset-animation")).toBeHidden();

  // Selecting a material shows a larger, live preview in the Inspector. While it's open it has the
  // renderer, so a hovered tile keeps its still rather than showing an empty canvas.
  await page.locator(".asset-folder", { hasText: /^materials$/ }).click();
  await tile(page, "metal.material.json").click();
  await expect(page.locator(".asset-large-preview.live canvas.asset-live-preview")).toBeVisible({ timeout: 30_000 });
  // pulse.material.json draws with a shader graph that uses Time, so it would animate on hover.
  await expect.poll(() => renderedWidth(page, "pulse.material.json"), { timeout: 30_000 }).toBeGreaterThan(0);
  await tile(page, "pulse.material.json").locator(".asset-preview").hover();
  await page.waitForTimeout(500);
  await expect(tile(page, "pulse.material.json").locator("canvas.asset-animation")).toBeHidden();
  await expect(tile(page, "pulse.material.json").locator("img.asset-rendered")).toBeVisible();
  expect(errors).toEqual([]);
});

test("audio tiles show a waveform and play; the Inspector's player stops", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "Playwright's WebKit build has no MP3 decoder");
  const errors = trackErrors(page);
  await openSample(page, "flappy");
  await page.locator(".asset-folder", { hasText: /^music$/ }).click();
  await expect(tile(page, "town.mp3").locator("svg.asset-waveform rect").first()).toBeAttached({ timeout: 30_000 });
  await tile(page, "town.mp3").hover();
  await tile(page, "town.mp3").getByRole("button", { name: /^Play town/ }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).assetAudio!.state()?.path ?? null)).toBe("music/town.mp3");

  // The Inspector shows the clip's player; Stop forgets the clip.
  await tile(page, "town.mp3").click();
  const player = page.getByLabel("Audio preview");
  await expect(player).toBeVisible();
  await expect(player).toContainText(/Hz/, { timeout: 15_000 });
  await player.getByRole("button", { name: "Stop" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).assetAudio!.state())).toBeNull();
  // Autoplay may be blocked in headless browsers; a failed play() isn't an error.
  expect(errors.filter((e) => !/play\(\)|NotAllowedError/.test(e))).toEqual([]);
});

/** A cheap fingerprint of what a canvas shows (sampled pixels), to tell two frames apart. */
const canvasPrint = (page: Page, selector: string) =>
  page.locator(selector).evaluate((c: HTMLCanvasElement) => {
    const ctx = c.getContext("2d");
    if (!ctx || !c.width || !c.height) return "";
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let sum = 0;
    let lit = 0;
    for (let i = 0; i < d.length; i += 4 * 97) {
      sum = (sum * 31 + d[i] + d[i + 1] * 3 + d[i + 2] * 7 + d[i + 3] * 11) % 1_000_000_007;
      if (d[i + 3] > 0) lit++;
    }
    return lit > 0 ? `${lit}:${sum}` : "";
  });

test("the Inspector's preview turns with a drag, zooms, and resets; prefabs get one too", async ({ page }) => {
  const errors = trackErrors(page);
  await openSample(page, "playground3d");
  await page.locator(".asset-folder", { hasText: /^models$/ }).click();
  await tile(page, "robot.fbx").click();
  const canvas = ".asset-large-preview.live canvas.asset-live-preview";
  await expect(page.locator(canvas)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvasPrint(page, canvas), { timeout: 15_000 }).not.toBe("");
  const start = await canvasPrint(page, canvas);

  // Drag to turn: the picture changes.
  const box = (await page.locator(".asset-large-preview").boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 120, box.y + box.height / 2 + 20, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => canvasPrint(page, canvas)).not.toBe(start);
  const turned = await canvasPrint(page, canvas);

  // Wheel to zoom; double-click goes back to the starting view.
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.wheel(0, -300);
  await expect.poll(() => canvasPrint(page, canvas)).not.toBe(turned);
  await page.locator(".asset-large-preview").dblclick();
  await expect.poll(() => canvasPrint(page, canvas)).toBe(start);

  // A prefab (the Flappy sample's pipe pair, sprites) gets a preview in the Inspector.
  await openSample(page, "flappy");
  await page.locator(".asset-folder", { hasText: /^prefabs$/ }).click();
  await tile(page, "pipe-pair.prefab.json").click();
  await expect(page.locator(canvas)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvasPrint(page, canvas), { timeout: 15_000 }).not.toBe("");
  expect(errors).toEqual([]);
});

test("a particle effect's Inspector shows its live preview", async ({ page }) => {
  const errors = trackErrors(page);
  await openSample(page, "playground3d");
  await page.locator(".asset-folder", { hasText: /^effects$/ }).click();
  await tile(page, "campfire.particles.json").click();
  await expect(page.getByLabel("Particle effect preview")).toBeVisible();
  // The shared renderer's live preview: drawn, and moving (the effect plays).
  const canvas = ".particle-inspector-preview .asset-large-preview.live canvas.asset-live-preview";
  await expect(page.locator(canvas)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvasPrint(page, canvas), { timeout: 15_000 }).not.toBe("");
  const first = await canvasPrint(page, canvas);
  await expect.poll(() => canvasPrint(page, canvas), { timeout: 10_000 }).not.toBe(first);
  expect(errors).toEqual([]);
});

test("switching the Inspector between an effect and a material many times leaves previews working", async ({ page }) => {
  const errors = trackErrors(page);
  await openSample(page, "playground3d");
  const live = ".asset-large-preview.live canvas.asset-live-preview";
  for (let i = 0; i < 15; i++) {
    await page.locator(".asset-folder", { hasText: /^effects$/ }).click();
    await tile(page, "campfire.particles.json").click();
    await expect(page.locator(live)).toBeVisible({ timeout: 30_000 });
    await page.locator(".asset-folder", { hasText: /^materials$/ }).click();
    await tile(page, "metal.material.json").click();
    await expect(page.locator(live)).toBeVisible({ timeout: 30_000 });
  }
  // Still drawing, and thumbnails still render (no WebGL context was lost along the way).
  await expect.poll(() => canvasPrint(page, live), { timeout: 15_000 }).not.toBe("");
  await page.locator(".asset-folder", { hasText: /^models$/ }).click();
  await expect.poll(() => renderedWidth(page, "crate.obj"), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(errors.filter((e) => !/Too many active WebGL contexts/.test(e))).toEqual([]);
  expect(errors.some((e) => /Too many active WebGL contexts/.test(e))).toBe(false);
});

/**
 * A tiny 8×2 Radiance HDR whose pixel bytes are all below 128, so it survives the fake folder's
 * text storage: a dim warm sky over a darker ground. 8 pixels wide because Babylon's reader rejects
 * narrower images (each pixel below is doubled).
 */
const PIXELS = [100, 90, 70, 127, 110, 95, 75, 127, 100, 90, 70, 127, 90, 85, 70, 127, 40, 50, 60, 127, 35, 45, 55, 127, 40, 50, 60, 127, 45, 55, 65, 127];
const TINY_HDR = ["#?RADIANCE", "FORMAT=32-bit_rle_rgbe", "", "-Y 2 +X 8", ""].join("\n") + String.fromCharCode(...PIXELS.flatMap((_, i) => (i % 4 === 0 ? [...PIXELS.slice(i, i + 4), ...PIXELS.slice(i, i + 4)] : [])));

test("an environment map gets a preview in the Inspector", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Skies: { "project.json": JSON.stringify({ name: "Skies" }), "sky.hdr": TINY_HDR } });
  await page.goto("/editor.html");
  await nextFolder(page, "Skies");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 5);
  await tile(page, "sky.hdr").click();
  const canvas = ".asset-large-preview.live canvas.asset-live-preview";
  await expect(page.locator(canvas)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvasPrint(page, canvas), { timeout: 15_000 }).not.toBe("");
  expect(errors).toEqual([]);
});

const SAMPLE = "samples/playground3d";
/** The sample's text files (the fake folder holds text): materials, models' .obj and .mtl, scenes, shaders. */
function textFiles(dir = SAMPLE): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, textFiles(full));
    else if (/\.(json|obj|mtl)$/.test(name) && name !== "sample.json") out[relative(SAMPLE, full).split(sep).join("/")] = readFileSync(full, "utf8");
  }
  return out;
}

test("editing a material updates the Inspector's live preview", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: textFiles() });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 5);
  await page.locator(".asset-folder", { hasText: /^materials$/ }).click();
  await tile(page, "ground.material.json").click();
  const canvas = ".asset-large-preview.live canvas.asset-live-preview";
  await expect(page.locator(canvas)).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => canvasPrint(page, canvas), { timeout: 15_000 }).not.toBe("");
  const before = await canvasPrint(page, canvas);
  const roughness = page.getByLabel("Material", { exact: true }).getByRole("spinbutton", { name: "Roughness", exact: true });
  const now = Number(await roughness.inputValue());
  await roughness.fill(now < 0.5 ? "1" : "0");
  await roughness.press("Enter");
  await page.getByLabel("Material", { exact: true }).getByRole("spinbutton", { name: "Metalness", exact: true }).fill("1");
  await page.getByLabel("Material", { exact: true }).getByRole("spinbutton", { name: "Metalness", exact: true }).press("Enter");
  await expect.poll(() => canvasPrint(page, canvas), { timeout: 30_000 }).not.toBe(before);
  expect(errors).toEqual([]);
});

test("a writable project caches thumbnails in .myco/thumbnails/ and reads them back instead of rendering", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: textFiles() });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 5);

  await page.locator(".asset-folder", { hasText: /^materials$/ }).click();
  for (const m of ["glow", "ground", "metal"]) await expect.poll(() => renderedWidth(page, `${m}.material.json`), { timeout: 30_000 }).toBeGreaterThan(0);
  await expect.poll(async () => (await listFolder(page, "Playground")).filter((f) => /^\.myco\/thumbnails\/[0-9a-f]+\.(webp|png)$/.test(f)).length, { timeout: 15_000 }).toBeGreaterThanOrEqual(3);

  // Reopened (a fresh service), the same thumbnails come from the cache: nothing renders.
  const before = await page.evaluate(() => (window as unknown as Hooks).thumbnails!.renders());
  await page.evaluate(() => (window as unknown as Hooks).thumbnails!.reset());
  await page.locator(".asset-folder").first().click(); // the project's root: folders, no previews
  await page.locator(".asset-folder", { hasText: /^materials$/ }).click();
  for (const m of ["glow", "ground", "metal"]) await expect.poll(() => renderedWidth(page, `${m}.material.json`), { timeout: 30_000 }).toBeGreaterThan(0);
  expect(await page.evaluate(() => (window as unknown as Hooks).thumbnails!.renders())).toBe(before);
  expect(errors).toEqual([]);
});
