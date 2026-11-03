import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, test, type Locator, type Page } from "@playwright/test";
import { installFakeFolders, nextFolder, readFile } from "./fakeFolders";

// 3D in the editor (ADR 0043–0045): importing OBJ and FBX models into a scene, materials and model
// import settings in the Asset Inspector, 3D shapes, lights and colliders from the Hierarchy, and
// resizing 3D colliders with their gizmo handles. The 3D Playground sample's files are all text,
// so a writable copy is seeded as an in-memory folder (fakeFolders.ts).

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

interface Handle {
  id: string;
  x: number;
  y: number;
}

/** The editor's debug hooks on `window` (session.ts). Page callbacks are serialized, so each casts `window` itself. */
type Hooks = {
  engine?: {
    world: {
      time: { frameCount: number };
      render: {
        meshRenderers: Map<{ node: { name: string } }, { objects: { visible: boolean }[] }>;
        lightIconsOnCanvas(world: unknown): { node: { name: string }; x: number; y: number }[];
        lightWireCount(): number;
      };
    };
  };
  orbit: { focus(point?: [number, number, number], distance?: number): void };
  overlayHandles?: () => Handle[];
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

/** Open a writable copy of the 3D Playground (Chromium's File System Access, faked), or the read-only sample. */
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

/** Names of the nodes whose meshes are drawn in the scene view, once each. */
const drawnMeshes = (page: Page) =>
  page.evaluate(() => {
    const names = new Set<string>();
    for (const [r, e] of (window as unknown as Hooks).engine!.world.render.meshRenderers) if (e.objects.some((o) => o.visible)) names.add(r.node.name);
    return [...names].sort();
  });

const box = async (l: Locator) => (await l.boundingBox())!;
const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
/** A component's card in the Inspector, found by its "<name> enabled" checkbox. */
const card = (page: Page, name: string) => page.locator(".inspector-body .component").filter({ has: page.getByRole("checkbox", { name: `${name} enabled`, exact: true }) });
const menuItem = (page: Page, name: string) =>
  page.locator(".hierarchy-menu [role=menuitem]").filter({ has: page.locator("span:first-child", { hasText: new RegExp(`^${name}$`) }) });

async function showFolder(page: Page, name: string): Promise<void> {
  await page.locator(".asset-folder", { hasText: new RegExp(`^${name}$`) }).click();
}

/** Press on an asset tile and drag it to (x, y). */
async function dragAsset(page: Page, file: string, x: number, y: number): Promise<void> {
  const t = await box(page.locator(".asset-tile", { hasText: file }));
  await page.mouse.move(t.x + t.width / 2, t.y + 20);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 20, t.y - 20, { steps: 3 });
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

async function handles(page: Page): Promise<Record<string, Handle>> {
  await page.waitForFunction(() => ((window as unknown as Hooks).overlayHandles?.() ?? []).length > 0);
  const canvas = await box(page.locator(".viewport canvas"));
  const list = await page.evaluate(() => (window as unknown as Hooks).overlayHandles!());
  return Object.fromEntries(list.map((h) => [h.id, { ...h, x: canvas.x + h.x, y: canvas.y + h.y }]));
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}

const num = async (l: Locator) => parseFloat(await l.inputValue());

test("the 3D Playground draws its models, shapes and lights", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await expect.poll(() => drawnMeshes(page)).toEqual(["Ball", "Body", "Crate 1", "Crate 2", "Crate 3", "Crate 4", "Ground", "Head", "Orb", "Pillar"]);
  // Every light shows an icon; the sun's arrow and other wireframes are drawn.
  const icons = await page.evaluate(() => {
    const w = (window as unknown as Hooks).engine!.world;
    return w.render.lightIconsOnCanvas(w).map((i) => i.node.name).sort();
  });
  expect(icons).toEqual(["Ambient Light", "Lamp", "Sun"]);
  expect(await page.evaluate(() => (window as unknown as Hooks).engine!.world.render.lightWireCount())).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("dropping an FBX model in the viewport adds a node with a child per mesh; an OBJ adds one node", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await showFolder(page, "models");
  await expect(page.locator(".asset-tile", { hasText: "robot.fbx" }).locator(".asset-kind")).toHaveText("Model");
  const vp = await box(page.locator(".viewport-panel"));
  await dragAsset(page, "robot.fbx", vp.x + vp.width * 0.5, vp.y + vp.height * 0.6);
  const selected = page.locator(".tree .row.selected");
  await expect(selected).toHaveAttribute("data-key", "robot-2");
  await expect(page.locator('.tree .row[data-key="robot-2-body"] .name')).toHaveText("Body");
  await expect(page.locator('.tree .row[data-key="robot-2-head"] .name')).toHaveText("Head");
  // Dropped on the ground (y = 0) in the 3D view.
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("0");

  await page.locator('.tree .row[data-key="robot-2-head"]').click();
  await expect(card(page, "MeshRenderer").getByRole("combobox", { name: "mesh" })).toHaveValue("models/robot.fbx#Head");
  await expect.poll(async () => (await drawnMeshes(page)).filter((n) => n === "Head").length).toBe(1);

  await page.locator(".asset-tile", { hasText: "crate.obj" }).getByRole("button", { name: /^Add crate/ }).click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Crate");
  await expect(card(page, "MeshRenderer").getByRole("combobox", { name: "mesh" })).toHaveValue("models/crate.obj");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "Crate")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("model import settings and materials save to their files", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors = trackErrors(page);
  await openPlayground(page, true);
  await showFolder(page, "models");
  await page.locator(".asset-tile", { hasText: "robot.fbx" }).click();
  const inspector = page.getByLabel("Import settings");
  await expect(inspector.locator(".asset-inspector-kind")).toHaveText("Model");
  await inspector.getByRole("spinbutton", { name: "Scale" }).fill("2");
  await inspector.getByRole("spinbutton", { name: "Scale" }).press("Enter");
  await inspector.getByRole("combobox", { name: "Up Axis" }).selectOption("z");
  await inspector.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => readFile(page, "Playground/models/robot.fbx.meta.json")).toBe('{\n  "format": "myco.import@1",\n  "scale": 2,\n  "upAxis": "z"\n}\n');

  // New Material from the Assets panel's menu, then edited in the Inspector.
  await showFolder(page, "materials");
  const items = await box(page.locator(".panel.assets .asset-items"));
  await page.mouse.click(items.x + items.width - 10, items.y + items.height - 10, { button: "right" });
  await page.getByRole("menuitem", { name: "New Material" }).click();
  await expect(page.locator(".asset-tile.selected")).toContainText("New Material.material.json");
  const material = page.getByLabel("Material", { exact: true });
  await material.getByRole("spinbutton", { name: "Metalness" }).fill("0.8");
  await material.getByRole("spinbutton", { name: "Metalness" }).press("Enter");
  await material.getByRole("combobox", { name: "Shader" }).selectOption("unlit");
  await expect.poll(() => readFile(page, "Playground/materials/New Material.material.json")).toBe('{\n  "format": "myco.material@1",\n  "shader": "unlit",\n  "metalness": 0.8\n}\n');
  expect(errors).toEqual([]);
});

test("a cube from the Create menu has a box collider whose face handles resize it, in one undo step", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await page.getByRole("button", { name: "Create node" }).click();
  await menuItem(page, "Create Cube").click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Cube");
  await expect(card(page, "MeshRenderer")).toBeVisible();
  const collider = card(page, "BoxCollider");
  await expect(collider).toBeVisible();
  // Frame the cube (created at the view's focus point) from the front.
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus(undefined, 4));
  await collider.locator(".edit-collider").click();
  const h = await handles(page);
  expect(Object.keys(h).sort()).toEqual(["center", "x+", "x-", "y+", "y-", "z+", "z-"]);

  const sizeX = collider.getByRole("textbox", { name: "size x" });
  const centerX = collider.getByRole("textbox", { name: "center x" });
  await expect(sizeX).toHaveValue("1");
  // Drag the +x face outwards: wider, the centre half-way out, the -x face where it was.
  const out = { dx: h["x+"].x - h.center.x, dy: h["x+"].y - h.center.y };
  const len = Math.hypot(out.dx, out.dy);
  await drag(page, h["x+"], (out.dx / len) * 60, (out.dy / len) * 60);
  const width = await num(sizeX);
  expect(width).toBeGreaterThan(1.2);
  expect(await num(centerX)).toBeCloseTo((width - 1) / 2, 2);
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Cube"); // the press didn't select through
  await page.keyboard.press("ControlOrMeta+z");
  await expect(sizeX).toHaveValue("1");
  await expect(centerX).toHaveValue("0");
  expect(errors).toEqual([]);
});

test("sphere and capsule collider handles set the radius and height; lights from the Create menu get icons", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await page.getByRole("button", { name: "Create node" }).click();
  await menuItem(page, "Create Sphere").click();
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus(undefined, 4));
  const sphere = card(page, "SphereCollider");
  await sphere.locator(".edit-collider").click();
  let h = await handles(page);
  const radius = sphere.getByRole("textbox", { name: "radius" });
  await expect(radius).toHaveValue("0.5");
  await drag(page, h["radius:y+"], 0, -50);
  expect(await num(radius)).toBeGreaterThan(0.6);

  await page.getByRole("button", { name: "Create node" }).click();
  await menuItem(page, "Create Capsule").click();
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus(undefined, 6));
  const capsule = card(page, "CapsuleCollider");
  await capsule.locator(".edit-collider").click();
  h = await handles(page);
  expect(Object.keys(h).sort()).toEqual(["center", "height+", "height-", "radius:u+", "radius:u-", "radius:v+", "radius:v-"]);
  const height = capsule.getByRole("textbox", { name: "height" });
  await drag(page, h["height+"], 0, -40);
  expect(await num(height)).toBeGreaterThan(2.2);

  await page.getByRole("button", { name: "Create node" }).click();
  await menuItem(page, "Create Spot Light").click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Spot Light");
  await expect(card(page, "Light").getByRole("combobox", { name: "type" }).locator("option:checked")).toHaveText("spot");
  await expect
    .poll(() =>
      page.evaluate(() => {
        const w = (window as unknown as Hooks).engine!.world;
        return w.render.lightIconsOnCanvas(w).some((i) => i.node.name === "Spot Light");
      }),
    )
    .toBe(true);
  expect(errors).toEqual([]);
});

test("Play drops the playground's crates under 3D physics, and Stop puts them back", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();
  // The live World in the Hierarchy and Inspector (ADR 0032): Crate 3 starts 6 m up and lands.
  const picker = page.locator(".panel.hierarchy").getByRole("combobox", { name: "Inspect World" });
  const worldName = await page.evaluate(() => (window as unknown as { playEngine: { world: { name: string } } }).playEngine.world.name);
  await picker.selectOption(worldName);
  await page.locator(".panel.hierarchy").getByRole("tree", { name: "Live nodes" }).locator(".row .name", { hasText: /^Crate 3$/ }).click();
  const y = page.getByRole("textbox", { name: "position y" });
  await expect.poll(async () => num(y), { timeout: 15_000 }).toBeLessThan(3);
  await page.getByRole("button", { name: /Stop/ }).click();
  await row(page, "Crate 3").click();
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("6");
  expect(errors).toEqual([]);
});
