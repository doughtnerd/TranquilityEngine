import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { NODES } from "../../src/engine/render/shaderGraph/nodes";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// The Shader Graph panel (ADR 0046, 0047): creating a graph from the Assets panel, adding a
// property and nodes, wiring them to the output, undo and redo, the live preview, materials that
// draw with a graph in the scene, and every node type compiling in WebGL. The 3D Playground's
// files are all text, so a writable copy is seeded as an in-memory folder (fakeFolders.ts).

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

type Pixel = [number, number, number, number];
/** The editor's debug hooks on `window`. Page callbacks are serialized, so each casts `window` itself. */
type Hooks = {
  engine?: { world: { time: { frameCount: number }; render: { renderer: { meshRenderers: Map<{ node: { name: string } }, { meshes: { material: { unlit: boolean } | null }[] }> } | null } } };
  shaderGraphPreview?: { readCenter(): Pixel | null; setGraph(graph: unknown): unknown };
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
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
const node = (page: Page, id: string) => page.locator(`.sg-node[data-node="${id}"]`);
const port = (page: Page, id: string, portId: string, side: "input" | "output") => node(page, id).locator(`[data-handleid="${portId}"].${side === "input" ? "target" : "source"}`);
const graphFile = async (page: Page, path: string) => JSON.parse((await readFile(page, path)) ?? "{}");
const previewPixel = (page: Page) => page.evaluate(() => (window as unknown as Hooks).shaderGraphPreview?.readCenter() ?? null);

/** Drag a wire from one port to another. */
async function wire(page: Page, from: Locator, to: Locator): Promise<void> {
  const a = await box(from), b = await box(to);
  await page.mouse.move(a.x + a.width / 2, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 40, a.y + 10, { steps: 4 });
  await page.mouse.move(b.x + b.width / 2, b.y + b.height / 2, { steps: 10 });
  await page.mouse.up();
}

test("create a shader graph, wire a colour property to the output, and see the preview change; undo and redo", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openPlayground(page, true);

  // New Shader Graph from the Assets panel's menu; double-clicking it opens the panel.
  await showFolder(page, "shaders");
  const items = await box(page.locator(".panel.assets .asset-items"));
  await page.mouse.click(items.x + items.width - 10, items.y + items.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Shader Graph" }).click();
  const tile = page.locator(".asset-tile", { hasText: "New Shader Graph.shadergraph.json" });
  await expect(tile).toBeVisible();
  await expect(tile.locator(".asset-kind")).toHaveText("Shader Graph");
  await tile.dblclick();
  const panel = page.getByLabel("Shader Graph", { exact: true }).and(page.locator(".shader-graph"));
  await expect(panel).toBeVisible();
  await expect(node(page, "output")).toBeVisible();
  const file = "Playground/shaders/New Shader Graph.shadergraph.json";
  // The default graph draws white.
  await expect.poll(async () => (await previewPixel(page))?.[0] ?? 0).toBeGreaterThan(150);

  // A colour property, set to red, placed in the graph and wired to Base Color.
  await panel.getByRole("combobox", { name: "Add property" }).selectOption("color");
  await expect(panel.getByRole("textbox", { name: "Property name" })).toHaveValue("Color");
  await panel.getByLabel("Color value").fill("#ff0000");
  await expect.poll(async () => (await graphFile(page, file)).properties).toEqual([{ name: "Color", type: "color", value: "#ff0000" }]);
  await panel.getByRole("button", { name: "Place" }).click();
  await expect(node(page, "property1")).toContainText("Color");
  await wire(page, port(page, "property1", "out", "output"), port(page, "output", "baseColor", "input"));
  await expect.poll(async () => (await graphFile(page, file)).edges).toEqual([{ from: "property1.out", to: "output.baseColor" }]);
  await expect(page.locator(".sg-wire")).toHaveCount(1);
  // The preview turns red: much more red than green.
  await expect.poll(async () => {
    const p = await previewPixel(page);
    return p ? p[0] - p[1] : 0;
  }).toBeGreaterThan(80);

  // Node search: Space, type, Enter adds a node where the search opened.
  await page.locator(".sg-pane").click({ position: { x: 30, y: 30 } });
  await page.keyboard.press("Space");
  const search = page.getByRole("dialog", { name: "Add node" });
  await search.getByRole("searchbox", { name: "Search nodes" }).fill("fresnel");
  await expect(search.getByRole("option")).toHaveText(["Fresnel Effect"]);
  await page.keyboard.press("Enter");
  await expect(node(page, "fresnel1")).toBeVisible();
  await expect.poll(async () => (await graphFile(page, file)).nodes.map((n: { id: string }) => n.id)).toEqual(["output", "property1", "fresnel1"]);

  // Dropping a wire from Fresnel's output in empty space offers only nodes that take it, and connects the pick.
  const out = await box(port(page, "fresnel1", "out", "output"));
  await page.mouse.move(out.x + 5, out.y + 5);
  await page.mouse.down();
  await page.mouse.move(out.x + 120, out.y + 160, { steps: 8 });
  await page.mouse.up();
  await search.getByRole("searchbox", { name: "Search nodes" }).fill("one minus");
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await graphFile(page, file)).edges).toContainEqual({ from: "fresnel1.out", to: "oneMinus1.in" });

  // Undo takes the One Minus node away; redo brings it back.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(node(page, "oneMinus1")).toHaveCount(0);
  await expect.poll(async () => (await graphFile(page, file)).nodes.length).toBe(3);
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect(node(page, "oneMinus1")).toBeVisible();

  // Delete removes the selected node and its wires.
  await node(page, "oneMinus1").locator(".sg-node-header").click();
  await page.keyboard.press("Delete");
  await expect(node(page, "oneMinus1")).toHaveCount(0);
  await expect.poll(async () => (await graphFile(page, file)).edges).toEqual([{ from: "property1.out", to: "output.baseColor" }]);

  // Moving a node saves its position, in one undo step.
  const header = await box(node(page, "fresnel1").locator(".sg-node-header"));
  const before = (await graphFile(page, file)).nodes.find((n: { id: string }) => n.id === "fresnel1").position;
  await page.mouse.move(header.x + 20, header.y + header.height / 2);
  await page.mouse.down();
  await page.mouse.move(header.x + 80, header.y + 60, { steps: 6 });
  await page.mouse.up();
  await expect.poll(async () => (await graphFile(page, file)).nodes.find((n: { id: string }) => n.id === "fresnel1").position[0]).toBeGreaterThan(before[0] + 20);

  // The generated GLSL is one click away.
  await panel.getByRole("button", { name: "GLSL" }).click();
  await expect(page.getByLabel("Generated GLSL")).toContainText("uniform vec4 uP0_Color;");
  expect(errors).toEqual([]);
});

test("editing a graph updates the scene's meshes whose material uses it", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openPlayground(page, true);
  const pillarMaterial = () =>
    page.evaluate(() => {
      for (const [r, e] of (window as unknown as Hooks).engine!.world.render.renderer?.meshRenderers ?? []) if (r.node.name === "Pillar") { const m = e.meshes[0]?.material; return m ? (m.unlit ? "unlit" : "lit") : null; }
      return null;
    });
  // The Pillar's material draws with shaders/pulse.shadergraph.json, a lit graph.
  await expect.poll(pillarMaterial).toBe("lit");
  await showFolder(page, "shaders");
  await page.locator(".asset-tile", { hasText: "pulse.shadergraph.json" }).dblclick();
  const panel = page.locator(".shader-graph");
  await expect(node(page, "fresnel1")).toBeVisible();
  await panel.getByRole("combobox", { name: "Target" }).selectOption("unlit");
  await expect.poll(async () => (await graphFile(page, "Playground/shaders/pulse.shadergraph.json")).target).toBe("unlit");
  await expect.poll(pillarMaterial).toBe("unlit");

  // The material's own property values show in the Inspector beside the graph's.
  await showFolder(page, "materials");
  await page.locator(".asset-tile", { hasText: "pulse.material.json" }).click();
  const material = page.getByLabel("Material", { exact: true });
  await expect(material.getByRole("combobox", { name: "Shader" })).toHaveValue("asset:shaders/pulse.shadergraph.json");
  await expect(material.getByLabel("Tint value")).toHaveValue("#7a5cff");
  await material.getByLabel("Speed value").fill("5");
  await material.getByLabel("Speed value").press("Enter");
  await expect.poll(() => readFile(page, "Playground/materials/pulse.material.json")).toContain('"Speed": 5');
  expect(errors).toEqual([]);
});

test("the read-only sample shows its graph and every node type compiles in WebGL", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await showFolder(page, "shaders");
  await page.locator(".asset-tile", { hasText: "pulse.shadergraph.json" }).dblclick();
  await expect(page.locator(".sg-node")).toHaveCount(10);
  await expect(page.locator(".sg-wire")).toHaveCount(10);
  await expect(page.locator(".sg-readonly")).toHaveText("This project is read-only.");
  await expect.poll(async () => (await previewPixel(page)) !== null).toBe(true);

  // Each node type, wired into Base Color (and, where it can run per vertex, Vertex Offset), compiles and draws.
  for (const def of NODES) {
    if (def.type === "output") continue;
    const number = def.outputs.find((p) => p.type !== "texture");
    const vertex = !def.fragmentOnly;
    // A node with only a texture output (Texture 2D Asset) is sampled by a Sample Texture 2D node;
    // nodes with no outputs until they're set up (Sub Graph, Custom Function) just compile.
    const textureOnly = !number && def.outputs.length > 0;
    const out = number ? `n.${number.id}` : textureOnly ? "s.rgb" : null;
    const graph = {
      target: "lit",
      surface: "opaque",
      doubleSided: false,
      properties: [{ name: "P", type: "vector3", value: [1, 0.5, 0.2] }],
      nodes: [
        { id: "output", type: "output", position: [0, 0] },
        { id: "n", type: def.type, position: [0, 0], ...(def.type === "property" ? { settings: { property: "P" } } : {}) },
        ...(textureOnly ? [{ id: "s", type: "sampleTexture", position: [0, 0] }] : []),
      ],
      edges: [
        ...(textureOnly ? [{ from: `n.${def.outputs[0].id}`, to: "s.texture" }] : []),
        ...(out ? [{ from: out, to: "output.baseColor" }, ...(vertex ? [{ from: out, to: "output.vertexOffset" }] : [])] : []),
      ],
    };
    const pixel = await page.evaluate((g) => {
      const p = (window as unknown as Hooks).shaderGraphPreview!;
      p.setGraph(g);
      return p.readCenter();
    }, graph);
    expect(pixel, def.type).not.toBeNull();
  }
  expect(errors).toEqual([]);
});
