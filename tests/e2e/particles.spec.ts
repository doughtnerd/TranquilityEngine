import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// Particles (ADR 0057, 0060): effects are graph assets authored in the Particle Graph. A Particle
// System from the Create menu gets a new effect asset and plays in the scene view; the graph's
// edits save to the file, play live and undo; the 3D Playground's campfire opens as three systems
// and plays in Play mode; embedded effects in old scenes move into asset files.

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
const waitForEngine = (page: Page) => page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);

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

/** The playground as a writable folder project (File System Access, Chromium only). */
async function openWritablePlayground(page: Page, files = sampleFiles()): Promise<void> {
  await installFakeFolders(page, { Playground: files });
  await page.goto("/editor.html");
  await nextFolder(page, "Playground");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await waitForEngine(page);
}

const effectFile = async (page: Page, path: string) => JSON.parse((await readFile(page, `Playground/${path}`)) ?? "{}");

test("a Particle System from the Create menu gets an effect asset; the Particle Graph edits it live and undoes", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openWritablePlayground(page);
  await page.getByRole("button", { name: "Create node" }).click();
  await page.locator(".hierarchy-menu [role=menuitem]").filter({ has: page.locator("span:first-child", { hasText: /^Create Particle System$/ }) }).click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Particle System");

  // The new effect is an asset in effects/, in the graph format, and the node plays it while selected.
  const path = "effects/Particle System.particles.json";
  await expect.poll(async () => (await effectFile(page, path)).format).toBe("myco.particles@2");
  const overlay = page.getByRole("toolbar", { name: "Particle preview" });
  await expect(overlay).toBeVisible();
  await expect.poll(async () => (await editorParticles(page))?.previewed?.count ?? 0, { timeout: 15_000 }).toBeGreaterThan(5);

  // The Inspector shows the component, not the effect's contents; the graph opens from it.
  await expect(page.locator(".particle-effect-editor")).toHaveCount(0);
  await page.getByRole("button", { name: "Open in Particle Graph" }).click();
  const graph = page.locator(".particle-graph");
  const system = graph.getByLabel("System Simple Loop", { exact: true });
  await expect(system).toBeVisible();
  for (const context of ["Spawn", "Initialize Particle", "Update Particle"]) await expect(system.getByLabel(context, { exact: true })).toBeVisible();

  // Editing the Spawn rate saves to the file and plays at once: 300 a second fills up well past 20.
  const rate = system.getByLabel("Block Constant rate").getByRole("textbox", { name: "Rate", exact: true });
  await rate.fill("300");
  await rate.press("Tab");
  await expect.poll(async () => (await effectFile(page, path)).systems[0].spawn.blocks[0].inputs.rate).toBe(300);
  await expect.poll(async () => (await editorParticles(page))?.previewed?.count ?? 0, { timeout: 15_000 }).toBeGreaterThan(100);

  // A block added from the context's search lands in the file (the preview card hidden: it floats over the canvas).
  await graph.getByRole("button", { name: "Preview", exact: true }).click();
  await system.getByRole("button", { name: "Add block to Update Particle" }).click();
  await page.keyboard.type("Gravity");
  await page.keyboard.press("Enter");
  await expect(system.getByLabel("Block Gravity", { exact: true })).toBeVisible();
  await expect.poll(async () => (await effectFile(page, path)).systems[0].update.blocks.map((b: { type: string }) => b.type)).toContain("update.gravity");

  // Undo in the panel takes the block away again, in the file too.
  await graph.getByRole("button", { name: "Undo", exact: true }).click();
  await expect(system.getByLabel("Block Gravity", { exact: true })).toHaveCount(0);
  await expect.poll(async () => (await effectFile(page, path)).systems[0].update.blocks.map((b: { type: string }) => b.type)).not.toContain("update.gravity");

  // Back in the Scene tab, Pause freezes the scene preview; deselected, it stops.
  await page.locator(".dock-tab", { hasText: /^Scene$/ }).click();
  await overlay.getByRole("button", { name: "Pause" }).click();
  const paused = (await editorParticles(page))?.previewed?.time ?? 0;
  await page.waitForTimeout(400);
  expect((await editorParticles(page))?.previewed?.time).toBeCloseTo(paused, 5);
  await overlay.getByRole("button", { name: "Play" }).click();
  await page.locator(".tree .row", { has: page.locator(".name", { hasText: /^Camera$/ }) }).click();
  await expect(overlay).toBeHidden();
  await expect.poll(async () => (await editorParticles(page))?.particles ?? -1).toBe(0);
  expect(errors).toEqual([]);
});

test("the campfire opens in the Particle Graph as three systems with a live preview, read-only in the sample", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=playground3d");
  await waitForEngine(page);
  await page.locator(".asset-folder", { hasText: /^effects$/ }).click();
  await page.locator(".panel.assets .asset-item", { hasText: "campfire" }).dblclick();
  const graph = page.locator(".particle-graph");
  for (const name of ["Flames", "Smoke", "Sparks"]) await expect(graph.getByLabel(`System ${name}`, { exact: true })).toBeVisible();
  await expect(graph).toContainText("read-only");
  await expect(graph.getByRole("button", { name: "Preview restart" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("the 3D Playground's campfire plays its three systems in Play mode", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/editor.html?sample=playground3d");
  await waitForEngine(page);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).playEngine?.world.time.frameCount ?? 0) > 10);
  await expect.poll(async () => (await playParticles(page))?.emitters ?? 0, { timeout: 15_000 }).toBe(3);
  await expect.poll(async () => (await playParticles(page))?.particles ?? 0).toBeGreaterThan(10);
  expect(errors).toEqual([]);
});

test("an embedded effect in an old scene moves into an asset file when the scene opens", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  const files = sampleFiles();
  const scene = JSON.parse(files["scenes/main.scene.json"]);
  scene.nodes.push({
    id: "embers",
    name: "Embers",
    components: [
      { type: "engine.Transform", data: { position: [0, 1, 0] } },
      { type: "engine.ParticleSystem", data: { embeddedEffect: { format: "myco.particles@1", emitters: [{ name: "Embers", emission: { rateOverTime: 30 } }] } } },
    ],
  });
  files["scenes/main.scene.json"] = JSON.stringify(scene, null, 2);
  await openWritablePlayground(page, files);

  await expect.poll(async () => (await effectFile(page, "effects/Embers.particles.json")).format).toBe("myco.particles@2");
  await expect(page.locator(".status-bar")).toContainText("embedded particle effect");
  await page.locator(".tree .row", { has: page.locator(".name", { hasText: /^Embers$/ }) }).click();
  await expect(page.getByRole("button", { name: "Open in Particle Graph" })).toBeEnabled();
  expect(errors).toEqual([]);
});
