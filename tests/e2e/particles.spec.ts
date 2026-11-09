import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Page } from "./fixtures";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// Particles (ADR 0057, 0060): effects are graph assets authored in the Particle Graph. A Particle
// System from the Create menu gets a new effect asset and plays in the scene view; the graph's
// edits save to the file, play live and undo; the 3D Playground's campfire opens as three systems
// and plays in Play mode; embedded effects in old scenes move into asset files.

test.describe.configure({ timeout: 60_000 });

type ParticleState = { systems: number; emitters: number; particles: number; batches: number; previewed: { time: number; count: number } | null };
type Hooks = {
  engine?: { world: { time: { frameCount: number }; render: { diagnostics(): { features: { particles?: ParticleState } } } } };
  playEngine?: { world: { time: { frameCount: number }; render: { diagnostics(): { features: { particles?: ParticleState } } } } } | null;
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

const editorParticles = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.diagnostics().features.particles ?? null);
const playParticles = (page: Page) => page.evaluate(() => (window as unknown as Hooks).playEngine?.world.render.diagnostics().features.particles ?? null);
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

/**
 * Search the node (or block) search that just opened and pick the first match. Its box takes the
 * keyboard in an effect after it renders, so typing straight after the click could land elsewhere;
 * and Enter picks from the filtered list, so wait for the list to show the match first.
 */
async function pickFromSearch(page: Page, query: string): Promise<void> {
  const search = page.getByRole("dialog", { name: /^Add (node|block)$/ });
  const box = search.getByRole("searchbox");
  await expect(box).toBeFocused();
  await box.fill(query);
  await expect(search.getByRole("option").first()).toContainText(query);
  await box.press("Enter");
}

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
  await pickFromSearch(page, "Gravity");
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
  for (const name of ["Flames", "Smoke", "Sparks"]) await expect(graph.getByLabel(`System ${name}`, { exact: true })).toBeVisible({ timeout: 20_000 });
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

test("a particle sub-graph is created from the Assets menu, opens as a graph, shows its ports on a Sub-graph node; Sort sets on an output", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openWritablePlayground(page);

  // New Particle Sub-graph from the Assets panel's menu: a file with one number input wired to one number output.
  await page.locator(".asset-folder", { hasText: /^effects$/ }).click();
  const items = (await page.locator(".panel.assets .asset-items").boundingBox())!;
  await page.mouse.click(items.x + items.width - 10, items.y + items.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Particle Sub-graph" }).click();
  const tile = page.locator(".asset-tile", { hasText: "New Particle Sub-graph.particlesubgraph.json" });
  await expect(tile).toBeVisible();
  await expect(tile.locator(".asset-kind")).toHaveText("Particle Sub-graph");
  const subPath = "effects/New Particle Sub-graph.particlesubgraph.json";
  await expect.poll(async () => (await effectFile(page, subPath)).format).toBe("myco.particlesubgraph@1");
  expect(await effectFile(page, subPath)).toMatchObject({ inputs: [{ name: "In", type: "number" }], outputs: [{ name: "Out", type: "number" }], edges: [{ from: "input.In", to: "output.Out" }] });

  // Double-clicking opens it as a document of its own: Input and Output nodes, operator nodes editable.
  await tile.dblclick();
  const graph = page.locator(".particle-graph");
  await expect(graph.getByLabel("Node Input", { exact: true })).toBeVisible();
  await expect(graph.getByLabel("Node Output", { exact: true })).toBeVisible();
  await graph.getByRole("button", { name: "Add", exact: true }).click();
  await pickFromSearch(page, "Sine");
  await expect(graph.getByLabel("Node Sine", { exact: true })).toBeVisible();
  await expect.poll(async () => (await effectFile(page, subPath)).nodes.map((n: { type: string }) => n.type)).toEqual(["sine"]);
  await graph.getByRole("button", { name: "Undo", exact: true }).click();
  await expect.poll(async () => (await effectFile(page, subPath)).nodes).toEqual([]);

  // A Sub-graph node in an effect: no asset yet, then the picked asset's ports.
  await page.locator(".panel.assets .asset-tile", { hasText: "campfire" }).dblclick();
  const system = graph.getByLabel("System Flames", { exact: true });
  await expect(system).toBeVisible({ timeout: 20_000 });
  await graph.getByRole("button", { name: "Preview", exact: true }).click(); // the card floats over the canvas
  await graph.getByRole("button", { name: "Add", exact: true }).click();
  await pickFromSearch(page, "Sub-graph");
  const subNode = graph.getByLabel("Node Sub-graph", { exact: true });
  await expect(subNode).toContainText("No asset");
  await subNode.getByRole("combobox", { name: "Asset" }).selectOption({ label: "New Particle Sub-graph.particlesubgraph.json" });
  await expect(subNode).not.toContainText("No asset");
  await expect(subNode.getByLabel("In input", { exact: true })).toBeVisible();
  await expect(subNode.getByLabel("Out output", { exact: true })).toBeVisible();
  await expect.poll(async () => (await effectFile(page, "effects/campfire.particles.json")).nodes.map((n: { type: string; settings?: { asset?: string } }) => `${n.type}:${n.settings?.asset ?? ""}`)).toContain(`subgraph:asset:${subPath}`);

  // A Sub-graph node whose asset is gone says so.
  await subNode.getByRole("combobox", { name: "Asset" }).selectOption({ label: "(pick a sub-graph)" });
  await expect(subNode).toContainText("No asset");

  // The Output's Sort: auto isn't written, on and off are.
  const sort = system.getByRole("combobox", { name: "Sort", exact: true });
  await expect(sort).toHaveValue("auto");
  await sort.selectOption("on");
  await expect.poll(async () => (await effectFile(page, "effects/campfire.particles.json")).systems[0].output.settings.sort).toBe("on");
  await sort.selectOption("off");
  await expect.poll(async () => (await effectFile(page, "effects/campfire.particles.json")).systems[0].output.settings.sort).toBe("off");
  await sort.selectOption("auto");
  await expect.poll(async () => "sort" in (await effectFile(page, "effects/campfire.particles.json")).systems[0].output.settings).toBe(false);
  expect(errors).toEqual([]);
});
