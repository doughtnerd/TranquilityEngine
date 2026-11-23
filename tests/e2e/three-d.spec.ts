import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { expect, type HookHandle, type Hooks, type Locator, openEditor, type Page, play, test, waitForEditor } from "./fixtures";
import { assetsMenu, hierarchyMenu } from "./menus";
import { binarySeed, installFakeFolders, nextFolder, readFile } from "./fakeFolders";
import { captureView, pixelsNear, steadyView, themeColor } from "./viewCapture";

// 3D in the editor (ADR 0043–0045): importing OBJ and FBX models into a scene, materials and model
// import settings in the Asset Inspector, 3D shapes, lights and colliders from the Hierarchy, and
// resizing 3D colliders with their gizmo handles; glTF models (ADR 0088). A writable copy of the 3D
// Playground sample is seeded as an in-memory folder (fakeFolders.ts; its .glb as binary).

test.describe.configure({ timeout: 60_000 }); // WebKit renders on the CPU

const SAMPLE = "samples/playground3d";

function sampleFiles(dir = SAMPLE): Record<string, string> {
  const out: Record<string, string> = {};
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) Object.assign(out, sampleFiles(full));
    else if (name !== "sample.json") out[relative(SAMPLE, full).split(sep).join("/")] = /\.glb$/i.test(name) ? binarySeed(readFileSync(full)) : readFileSync(full, "utf8");
  }
  return out;
}

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
    await waitForEditor(page);
  } else {
    await openEditor(page, { sample: "playground3d" });
  }
}

/**
 * Which of the scene's nodes (by path key: a node's id, prefixed by its prefab instances' ids, joined by "/") draw on the scene view's canvas:
 * the ones the editor finds a rectangle for (`nodeRect`). (That the renderer reports what each feature drew is
 * babylonEditorViewport.test.ts's, and every Light's icon babylonEditorDrawing.test.ts's.)
 */
const drawnOf = (page: Page, keys: string[]) => page.evaluate((ks) => ks.filter((k) => (window as unknown as Hooks).nodeRect(k) !== null), keys);

const box = async (l: Locator) => (await l.boundingBox())!;
const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });
/** A component's card in the Inspector, found by its "<name> enabled" checkbox. */
const card = (page: Page, name: string) => page.locator(".inspector-body .component").filter({ has: page.getByRole("checkbox", { name: `${name} enabled`, exact: true }) });

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

/**
 * The overlay's handles in page coordinates, once there are some, or once they're exactly `ids`: the
 * overlay syncs its handles each frame, so right after Edit Collider moves to another collider it can
 * still list the previous one's for a frame.
 */
async function handles(page: Page, ids?: string[]): Promise<Record<string, HookHandle>> {
  await page.waitForFunction(
    (want) => {
      const got = ((window as unknown as Hooks).overlayHandles?.() ?? []).map((h) => h.id).sort();
      return want ? got.join() === [...want].sort().join() : got.length > 0;
    },
    ids ?? null,
  );
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
  // Its models (FBX, OBJ, glTF) and shapes: Ball, Body, Crate 1–4, Ground, Head, Orb, Pillar, Street Lamp.
  const meshes = ["ball", "robot-body", "crate-1", "crate-2", "crate-3", "crate-4", "ground", "robot-head", "orb", "pillar", "street-lamp"];
  await expect.poll(() => drawnOf(page, meshes), { timeout: 20_000 }).toEqual(meshes);
  // A point light draws its range as a wireframe sphere while selected, in the selection colour (the theme's
  // accent). The Lamp has no mesh, so nothing else of it is outlined: the accent pixels that appear are its wires.
  const view = page.locator(".viewport canvas");
  const accent = await themeColor(page, "--accent");
  const before = pixelsNear(await steadyView(view), accent);
  await row(page, "Lamp").click();
  await expect.poll(async () => pixelsNear(await captureView(view), accent) - before, { message: "accent pixels the Lamp's range wireframe adds", timeout: 15_000 }).toBeGreaterThan(200);
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
  await expect.poll(() => drawnOf(page, ["robot-2-head"])).toEqual(["robot-2-head"]);

  await page.locator(".asset-tile", { hasText: "crate.obj" }).getByRole("button", { name: /^Add crate/ }).click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Crate");
  await expect(card(page, "MeshRenderer").getByRole("combobox", { name: "mesh" })).toHaveValue("models/crate.obj");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "Crate")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a glTF model shows as a Model and drops as the file's node tree (ADR 0088)", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await showFolder(page, "models");
  await expect(page.locator(".asset-tile", { hasText: "lamp.glb" }).locator(".asset-kind")).toHaveText("Model");
  await expect(row(page, "Street Lamp")).toHaveCount(1); // the main scene's lamp, one MeshRenderer for the whole model
  const vp = await box(page.locator(".viewport-panel"));
  await dragAsset(page, "lamp.glb", vp.x + vp.width * 0.5, vp.y + vp.height * 0.6);
  await expect(page.locator(".tree .row.selected")).toHaveAttribute("data-key", "lamp-2");
  await expect(page.locator('.tree .row[data-key="lamp-2-pole"] .name')).toHaveText("Pole");
  await expect(page.locator('.tree .row[data-key="lamp-2-head"] .name')).toHaveText("Head");
  await page.locator('.tree .row[data-key="lamp-2-bulb"]').click();
  await expect(card(page, "MeshRenderer").getByRole("combobox", { name: "mesh" })).toHaveValue("models/lamp.glb#Bulb");
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
  await expect.poll(() => readFile(page, "Playground/models/robot.fbx.meta.json")).toBe('{\n  "format": "myco.import@1",\n  "scale": 2,\n  "upAxis": "z",\n  "facing": "back"\n}\n'); // the sample keeps facing "back" (ADR 0164)

  // New Material from the Assets panel's menu, then edited in the Inspector.
  await showFolder(page, "materials");
  const items = await box(page.locator(".panel.assets .asset-items"));
  await page.mouse.click(items.x + items.width - 10, items.y + items.height - 10, { button: "right" });
  await assetsMenu(page, "Create", "Rendering", "Material");
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
  await hierarchyMenu(page, "3D Object", "Cube");
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Cube");
  await expect(card(page, "MeshRenderer")).toBeVisible();
  const collider = card(page, "BoxCollider");
  await expect(collider).toBeVisible();
  // Frame the cube (created at the view's focus point) from the front.
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus(undefined, 4));
  await collider.locator(".edit-handles").click();
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

test("sphere and capsule collider handles set the radius and height; a spot light comes from the Create menu", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await page.getByRole("button", { name: "Create node" }).click();
  await hierarchyMenu(page, "3D Object", "Sphere");
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus(undefined, 4));
  const sphere = card(page, "SphereCollider");
  await sphere.locator(".edit-handles").click();
  let h = await handles(page, ["center", "radius:x+", "radius:x-", "radius:y+", "radius:y-", "radius:z+", "radius:z-"]);
  const radius = sphere.getByRole("textbox", { name: "radius" });
  await expect(radius).toHaveValue("0.5");
  await drag(page, h["radius:y+"], 0, -50);
  expect(await num(radius)).toBeGreaterThan(0.6);

  await page.getByRole("button", { name: "Create node" }).click();
  await hierarchyMenu(page, "3D Object", "Capsule");
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus(undefined, 6));
  const capsule = card(page, "CapsuleCollider");
  await capsule.locator(".edit-handles").click();
  h = await handles(page, ["center", "height+", "height-", "radius:u+", "radius:u-", "radius:v+", "radius:v-"]);
  const height = capsule.getByRole("textbox", { name: "height" });
  await drag(page, h["height+"], 0, -40);
  expect(await num(height)).toBeGreaterThan(2.2);

  await page.getByRole("button", { name: "Create node" }).click();
  await hierarchyMenu(page, "Light", "Spot Light");
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Spot Light");
  await expect(card(page, "Light").getByRole("combobox", { name: "type" }).locator("option:checked")).toHaveText("spot");
  expect(errors).toEqual([]);
});

test("Play drops the playground's crates under 3D physics, and Stop puts them back", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page, false);
  await play(page);
  // The live World in the Hierarchy and Inspector (ADR 0032): Crate 3 starts 6 m up and lands.
  const picker = page.locator(".panel.hierarchy").getByRole("combobox", { name: "Inspect World" });
  const worldName = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await picker.selectOption(worldName);
  await page.locator(".panel.hierarchy").getByRole("tree", { name: "Live nodes" }).locator(".row .name", { hasText: /^Crate 3$/ }).click();
  const y = page.getByRole("textbox", { name: "position y" });
  await expect.poll(async () => num(y), { timeout: 15_000 }).toBeLessThan(3);
  await page.getByRole("button", { name: /Stop/ }).click();
  await row(page, "Crate 3").click();
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("6");
  expect(errors).toEqual([]);
});
