import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// Shader sub-graphs, custom functions, node previews, copy and paste, groups, notes and the
// minimap (ADR 0048), and scripts setting a renderer's material properties (ADR 0049), on the
// 3D Playground (its water graph uses the ripple sub-graph, which holds a Custom Function node).

test.describe.configure({ timeout: 60_000 }); // WebKit renders on the CPU

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

type Renderer = { node: { name: string }; setMaterialProperty(name: string, value: unknown): void; clearMaterialProperties(): void };
type Hooks = {
  engine?: { world: { time: { frameCount: number }; render: { renderer: { meshes: { meshRenderers: Map<Renderer, { meshes: { material: { unlit: boolean; uniqueId: number } | null }[] }> } } | null } } };
};

/** Shader graphs compile to WGSL alone (ADR 0081): on the WebGL2 fallback (software GL) they draw plain PBR. */
async function requireWebGPU(page: Page): Promise<void> {
  const webgpu = await page.evaluate(() => (window as unknown as { engine: { world: { render: { renderer: { engine: { isWebGPU: boolean } } } } } }).engine.world.render.renderer.engine.isWebGPU);
  test.skip(!webgpu, "shader graphs need WebGPU; the WebGL2 fallback draws plain PBR (ADR 0081)");
}

function trackErrors(page: Page, allow: RegExp[] = []): string[] {
  const errors: string[] = [];
  const add = (text: string) => !allow.some((a) => a.test(text)) && errors.push(text);
  page.on("pageerror", (err) => add(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") add(msg.text());
  });
  return errors;
}

async function openPlayground(page: Page, writable: boolean): Promise<void> {
  if (writable) {
    await installFakeFolders(page, { Playground: sampleFiles() });
    await page.goto("/editor.html");
    await nextFolder(page, "Playground");
    await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
    await expect(page.locator(".project-name")).toHaveText("3D Playground");
  } else {
    await page.goto("/editor.html?sample=playground3d");
  }
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

const box = async (l: Locator) => (await l.boundingBox())!;
const showFolder = (page: Page, name: string) => page.locator(".asset-folder", { hasText: new RegExp(`^${name}$`) }).click();
const openGraph = async (page: Page, file: string) => {
  await showFolder(page, "shaders");
  await page.locator(".asset-tile", { hasText: file }).dblclick();
};
const node = (page: Page, id: string) => page.locator(`.sg-node[data-node="${id}"]`);
const json = async (page: Page, path: string) => JSON.parse((await readFile(page, path)) ?? "{}");
const card = (page: Page, name: string) => page.locator(".inspector-body .component").filter({ has: page.getByRole("checkbox", { name: `${name} enabled`, exact: true }) });
const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
/** The material a node's mesh draws with: Babylon lit/unlit and id. */
const meshMaterial = (page: Page, name: string) =>
  page.evaluate((n) => {
    for (const [r, e] of (window as unknown as Hooks).engine!.world.render.renderer?.meshes.meshRenderers ?? []) if (r.node.name === n) { const m = e.meshes[0]?.material; return m ? `${m.unlit ? "unlit" : "lit"}:${m.uniqueId}` : null; }
    return null;
  }, name);

test("sub-graphs rebuild the materials using them; custom functions, copy and paste, groups, notes and previews save to the file", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  // The broken custom function below is meant to fail in WGSL; Babylon only warns about that.
  const errors = trackErrors(page);
  await openPlayground(page, true);
  await requireWebGPU(page);

  // The Ground draws with the water graph, which uses shaders/ripple.shadersubgraph.json.
  await row(page, "Ground").click();
  const material = card(page, "MeshRenderer").getByRole("combobox", { name: "material" });
  await material.fill("materials/water.material.json");
  await material.press("Enter");
  await expect.poll(async () => (await meshMaterial(page, "Ground"))?.split(":")[0]).toBe("lit");
  const before = await meshMaterial(page, "Ground");

  // Editing the sub-graph rebuilds the Ground's material.
  await openGraph(page, "ripple.shadersubgraph.json");
  const panel = page.locator(".shader-graph");
  await expect(panel.locator(".sg-kind")).toHaveText("Sub Graph");
  await expect(panel.getByRole("combobox", { name: "Target" })).toHaveCount(0);
  await panel.getByLabel("Rings value").fill("12");
  await panel.getByLabel("Rings value").press("Enter");
  await expect.poll(async () => (await json(page, "Playground/shaders/ripple.shadersubgraph.json")).properties[0].value).toBe(12);
  await expect.poll(() => meshMaterial(page, "Ground")).not.toBe(before);

  // The Custom Function node's code is edited in the side bar; a body that doesn't compile shows the compiler's error.
  await node(page, "ripple").locator(".sg-node-header").click();
  const fn = panel.getByLabel("Custom Function");
  await expect(fn.getByRole("textbox", { name: "Function name" })).toHaveValue("ripple");
  await fn.getByRole("textbox", { name: "WGSL body" }).fill("height = ;");
  await fn.getByRole("textbox", { name: "WGSL body" }).blur();
  await expect(panel.getByLabel("Shader graph problems")).toContainText("The generated shader didn't compile");
  await expect(node(page, "ripple").locator("canvas.sg-node-preview")).toHaveClass(/failed/);
  await panel.locator(".sg-pane").click({ position: { x: 40, y: 300 } });
  await page.keyboard.press("ControlOrMeta+z");
  await expect(panel.getByLabel("Shader graph problems")).toHaveCount(0);
  // Renaming an output keeps its connection.
  await node(page, "ripple").locator(".sg-node-header").click();
  await fn.getByRole("textbox", { name: "Outputs height name" }).fill("h");
  await fn.getByRole("textbox", { name: "Outputs height name" }).press("Enter");
  await expect.poll(async () => (await json(page, "Playground/shaders/ripple.shadersubgraph.json")).edges).toContainEqual({ from: "ripple.h", to: "output.Height" });

  // Copy the UV node, paste it into the water graph.
  await node(page, "uv").locator(".sg-node-header").click();
  await page.keyboard.press("ControlOrMeta+c");
  await openGraph(page, "water.shadergraph.json");
  await expect(node(page, "ripple1")).toBeVisible();
  await panel.locator(".sg-pane").click({ position: { x: 60, y: 60 } });
  await page.keyboard.press("ControlOrMeta+v");
  await expect(node(page, "uv1")).toBeVisible();
  const water = "Playground/shaders/water.shadergraph.json";
  await expect.poll(async () => (await json(page, water)).nodes.map((n: { id: string }) => n.id)).toContain("uv1");

  // Group it with Ctrl+G; add a note and type in it; collapse the Lerp node's preview.
  await node(page, "uv1").locator(".sg-node-header").click();
  await page.keyboard.press("ControlOrMeta+g");
  await expect.poll(async () => (await json(page, water)).groups).toEqual([
    { id: "group1", title: "Colour", nodes: ["shallow", "deep", "lerp1"] },
    { id: "group2", title: "Group", nodes: ["uv1"] },
  ]);
  await panel.getByRole("button", { name: "Note", exact: true }).click();
  await expect(panel.getByLabel("Sticky note", { exact: true })).toHaveCount(2);
  await panel.getByRole("textbox", { name: "Note text" }).last().fill("Pasted UVs");
  await panel.getByRole("textbox", { name: "Note text" }).last().blur();
  await expect.poll(async () => (await json(page, water)).notes.map((n: { text: string }) => n.text)).toContain("Pasted UVs");
  await panel.getByRole("button", { name: "Hide Lerp preview" }).click();
  await expect.poll(async () => (await json(page, water)).nodes.find((n: { id: string }) => n.id === "lerp1").preview).toBe(false);
  await expect(node(page, "lerp1").locator("canvas")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("node previews draw, the minimap pans the canvas, and scripts override a renderer's material properties", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await openGraph(page, "water.shadergraph.json");
  // Every node with a number output but properties shows a preview, drawn without errors.
  await expect(page.locator("canvas.sg-node-preview")).toHaveCount(2);
  await expect(page.locator("canvas.sg-node-preview.failed")).toHaveCount(0);
  await expect(page.getByLabel("Group Colour", { exact: true })).toBeVisible();
  await expect(page.getByLabel("Sticky note", { exact: true })).toHaveCount(1);

  // Dragging in the minimap moves the view.
  const viewport = page.locator(".sg-viewport");
  const before = await viewport.getAttribute("style");
  const map = await box(page.getByLabel("Minimap"));
  await page.mouse.move(map.x + map.width / 2, map.y + map.height / 2);
  await page.mouse.down();
  await page.mouse.move(map.x + map.width / 2 + 30, map.y + map.height / 2 + 10, { steps: 6 });
  await page.mouse.up();
  await expect.poll(() => viewport.getAttribute("style")).not.toBe(before);

  // A script's override gives the Pillar its own copy of the graph material; clearing it shares the asset's again.
  const shared = await meshMaterial(page, "Pillar");
  expect(shared).toMatch(/^lit:/);
  await page.evaluate(() => {
    for (const [r] of (window as unknown as Hooks).engine!.world.render.renderer?.meshes.meshRenderers ?? []) if (r.node.name === "Pillar") r.setMaterialProperty("Tint", [1, 0, 0]);
  });
  await expect.poll(() => meshMaterial(page, "Pillar")).not.toBe(shared);
  await page.evaluate(() => {
    for (const [r] of (window as unknown as Hooks).engine!.world.render.renderer?.meshes.meshRenderers ?? []) if (r.node.name === "Pillar") r.clearMaterialProperties();
  });
  await expect.poll(() => meshMaterial(page, "Pillar")).toBe(shared);
  expect(errors).toEqual([]);
});
