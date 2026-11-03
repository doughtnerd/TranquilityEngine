import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder } from "./fakeFolders";

// HDR environments and cascaded shadows (ADR 0053): an Environment component with an .hdr map
// lights the scene and draws it as the sky; tiers with cascades draw the sun's shadows through
// cascaded shadow maps following the camera.

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

/** A 4×2 Radiance HDR with flat (uncompressed) scanlines whose bytes are all ASCII, so it travels as text. */
const TINY_HDR = `#?RADIANCE\nFORMAT=32-bit_rle_rgbe\n\n-Y 2 +X 4\n${"dPx\u007f".repeat(8)}`;

type Lighting = { cascades: boolean; environment: string; environmentLoaded: boolean; skybox: boolean };
type Hooks = { engine?: { world: { time: { frameCount: number }; render: { lightingState(): Lighting } } } };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const lighting = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.lightingState());
const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

test("cascaded shadows follow the quality tier", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=playground3d");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  // High has 3 cascades, and the sample's Sun casts shadows.
  await expect.poll(async () => (await lighting(page)).cascades, { timeout: 15_000 }).toBe(true);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Low"); // 1 cascade: ordinary shadows
  await expect.poll(async () => (await lighting(page)).cascades).toBe(false);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Ultra");
  await expect.poll(async () => (await lighting(page)).cascades).toBe(true);
  // Frames keep coming.
  const frames = await page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount)).toBeGreaterThan(frames + 10);
  expect(errors).toEqual([]);
});

test("an Environment component with an HDR map lights the scene and draws the sky", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: { ...sampleFiles(), "environments/sky.hdr": TINY_HDR } });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  expect(await lighting(page)).toMatchObject({ environment: "", skybox: false });

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
  await map.fill("environments/sky.hdr");
  await map.press("Enter");
  await expect.poll(async () => await lighting(page), { timeout: 15_000 }).toMatchObject({ environment: "environments/sky.hdr", environmentLoaded: true, skybox: true });

  // Turning the skybox off keeps the lighting but drops the sky.
  await env.getByRole("checkbox", { name: "skybox" }).uncheck();
  await expect.poll(async () => (await lighting(page)).skybox).toBe(false);
  expect((await lighting(page)).environmentLoaded).toBe(true);
  expect(errors).toEqual([]);
});
