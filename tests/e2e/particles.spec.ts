import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// Particles (ADR 0057): a Particle System from the Create menu plays in the scene view with the
// preview overlay, its embedded effect edits live (undoably); the 3D Playground's campfire asset
// plays in Play mode; a new effect asset saves its edits to the file.

test.describe.configure({ timeout: 60_000 });

type ParticleState = { systems: number; emitters: number; particles: number; batches: number; previewed: { time: number; count: number } | null };
type Hooks = {
  engine?: { world: { time: { frameCount: number }; render: { particleState(): ParticleState | null } } };
  playEngine?: { world: { time: { frameCount: number }; render: { particleState(): ParticleState | null } } } | null;
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const editorParticles = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.particleState());
const playParticles = (page: Page) => page.evaluate(() => (window as unknown as Hooks).playEngine?.world.render.particleState() ?? null);

async function openPlayground(page: Page): Promise<void> {
  await page.goto("/editor.html?sample=playground3d");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

test("a Particle System from the Create menu plays while selected, and its embedded effect edits live", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page);
  await page.getByRole("button", { name: "Create node" }).click();
  await page.locator(".hierarchy-menu [role=menuitem]").filter({ has: page.locator("span:first-child", { hasText: /^Create Particle System$/ }) }).click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Particle System");

  const overlay = page.getByRole("toolbar", { name: "Particle preview" });
  await expect(overlay).toBeVisible();
  await expect.poll(async () => (await editorParticles(page))?.previewed?.count ?? 0, { timeout: 15_000 }).toBeGreaterThan(5);

  // The default fountain emits 20 a second; 300 a second fills up well past what it had.
  const rate = page.locator(".particle-effect-editor").getByRole("textbox", { name: "rateOverTime", exact: true });
  await rate.fill("300");
  await rate.press("Tab");
  await expect.poll(async () => (await editorParticles(page))?.previewed?.count ?? 0, { timeout: 15_000 }).toBeGreaterThan(100);
  await expect(page.getByRole("button", { name: "Undo", exact: true })).toHaveAttribute("title", /Set embeddedEffect/);

  // Pause freezes it.
  await overlay.getByRole("button", { name: "Pause" }).click();
  const paused = (await editorParticles(page))?.previewed?.time ?? 0;
  await page.waitForTimeout(400);
  expect((await editorParticles(page))?.previewed?.time).toBeCloseTo(paused, 5);
  await overlay.getByRole("button", { name: "Play" }).click();

  // Deselected, it stops; Simulate All plays it anyway.
  await page.locator(".tree .row", { has: page.locator(".name", { hasText: /^Camera$/ }) }).click();
  await expect(overlay).toBeHidden();
  await expect.poll(async () => (await editorParticles(page))?.particles ?? -1).toBe(0);
  expect(errors).toEqual([]);
});

test("the 3D Playground's campfire plays its three emitters in Play mode", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).playEngine?.world.time.frameCount ?? 0) > 10);
  await expect.poll(async () => (await playParticles(page))?.emitters ?? 0, { timeout: 15_000 }).toBe(3);
  await expect.poll(async () => (await playParticles(page))?.particles ?? 0).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

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

test("New Particle Effect makes an asset whose edits save to the file", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await installFakeFolders(page, { Playground: sampleFiles() });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);

  await page.locator(".asset-folder", { hasText: /^effects$/ }).click();
  const items = (await page.locator(".panel.assets .asset-items").boundingBox())!;
  await page.mouse.click(items.x + items.width - 10, items.y + items.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Particle Effect" }).click();
  await expect(page.locator(".particle-inspector")).toBeVisible();
  const duration = page.locator(".particle-inspector").getByRole("textbox", { name: "duration", exact: true });
  await duration.fill("3");
  await duration.press("Tab");
  await expect.poll(async () => JSON.parse((await readFile(page, "Playground/effects/New Particle Effect.particles.json")) ?? "{}").emitters?.[0]?.duration).toBe(3);
  expect(errors).toEqual([]);
});
