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

  // Selecting a material shows a larger preview in the Inspector.
  await tile(page, "metal.material.json").click();
  await expect.poll(() => page.locator(".asset-large-preview img.asset-rendered").evaluate((img: HTMLImageElement) => img.naturalWidth).catch(() => 0), { timeout: 30_000 }).toBeGreaterThan(0);

  // The campfire animates while hovered, and stops when the pointer leaves.
  await page.locator(".asset-folder", { hasText: /^effects$/ }).click();
  await expect.poll(() => renderedWidth(page, "campfire.particles.json"), { timeout: 30_000 }).toBeGreaterThan(0);
  await tile(page, "campfire.particles.json").locator(".asset-preview").hover();
  await expect(tile(page, "campfire.particles.json").locator("canvas.asset-animation")).toBeVisible({ timeout: 15_000 });
  await page.locator(".asset-folder", { hasText: /^effects$/ }).hover();
  await expect(tile(page, "campfire.particles.json").locator("canvas.asset-animation")).toBeHidden();
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
