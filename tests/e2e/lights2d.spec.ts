import { readFileSync } from "node:fs";
import { expect, type Hooks, openEditor, type Page, play, test } from "./fixtures";
import { inLiveWorld, type LiveNode } from "./liveWorld";
import { pickCategory } from "./projectCategory";
import { showTab } from "./tabs";
import { captureView, steadyView, type ViewCapture } from "./viewCapture";

// 2D lights (ADR 0399, 0413) in a real browser: a white quad (a SpriteRenderer without a texture) under an orthographic
// camera draws as it always did with no 2D lights; a dim global light darkens it; a red point light lights its side red;
// a ShadowCaster2D between a light and part of the quad darkens what lies behind it; Light2D.sampleAt agrees through
// the public myco API. In the editor: the Create menu's Point Light 2D, its Edit Shape outer-radius handle (saved), the
// fields its type doesn't use hidden, the scene view's 2D Lights toggle, and a blend style added in Project > 2D Lighting.
// ADR 0415 in Play: a light's volume, an alpha blend light's overlap, and light masks.
test.describe.configure({ timeout: 90_000 });

const gameView = (page: Page) => page.locator("#game-view canvas").first();
const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const card = (page: Page, type: string) => page.locator(".inspector-body .component", { hasText: type }).first();

type Node = { id: string; name: string; components: { type: string; data: Record<string, unknown> }[] };
const node = (id: string, name: string, position: number[], components: Node["components"] = []): Node => ({ id, name, components: [{ type: "engine.Transform", data: { position } }, ...components] });

/** An orthographic camera on a white 16 × 10 quad that fills its view. */
const nodes = (extra: Node[] = []): Node[] => [
  node("camera", "Camera", [0, 0, -10], [{ type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 5, backgroundColor: "#000000" } }]),
  node("quad", "Quad", [0, 0, 0], [{ type: "engine.SpriteRenderer", data: { size: [16, 10] } }]),
  ...extra,
];
const scene = (extra: Node[] = []) => JSON.stringify({ format: "myco.scene@5", nodes: nodes(extra) });

/** Mean of a channel (0 red, 1 green, 2 blue, 3: all three) over a box of the capture, as fractions of its width and height. */
function mean(c: ViewCapture, channel: 0 | 1 | 2 | 3, box: [number, number, number, number]): number {
  const [x0, y0, x1, y1] = [Math.floor(box[0] * c.width), Math.floor(box[1] * c.height), Math.ceil(box[2] * c.width), Math.ceil(box[3] * c.height)];
  let sum = 0, n = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const i = (y * c.width + x) * c.channels;
      sum += channel === 3 ? (c.data[i]! + c.data[i + 1]! + c.data[i + 2]!) / 3 : c.data[i + channel]!;
      n++;
    }
  }
  return n ? sum / n : 0;
}
const ALL: [number, number, number, number] = [0.1, 0.1, 0.9, 0.9];
const LEFT: [number, number, number, number] = [0.05, 0.4, 0.2, 0.6];
const RIGHT: [number, number, number, number] = [0.8, 0.4, 0.95, 0.6];

test("2D lights light a sprite in Play: unlit without lights, a dim global light, a red point light, a shadow; sampleAt agrees", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openEditor(page, { files: { "scenes/main.scene.json": scene() } });
  await play(page);
  const view = gameView(page);
  await expect.poll(async () => mean(await captureView(view), 3, ALL), { timeout: 30_000, message: "with no 2D lights the quad is white, as before" }).toBeGreaterThan(200);

  // A dim global light: the whole quad darkens.
  await inLiveWorld(page, null, (_w, { myco }) => {
    myco.GameObject.create("Global").addBehavior(myco.Light2D, { type: "global", intensity: 0.1 });
  });
  await expect.poll(async () => mean(await captureView(view), 3, ALL), { timeout: 30_000, message: "a dim global light darkens the quad" }).toBeLessThan(110);

  // A red point light on the left: the left is red, the right stays dim.
  await inLiveWorld(page, null, (_w, { myco }) => {
    const n = myco.GameObject.create("Torch");
    n.transform.position.set(-6, 0, 0);
    n.addBehavior(myco.Light2D, { type: "point", color: new myco.Color(1, 0, 0, 1), intensity: 2, innerRadius: 0.5, outerRadius: 4 });
  });
  await expect
    .poll(async () => {
      const c = await captureView(view);
      return mean(c, 0, LEFT) - mean(c, 0, RIGHT);
    }, { timeout: 30_000, message: "the red light lights the left side" })
    .toBeGreaterThan(60);
  const sampled = await inLiveWorld(page, null, (_w, { myco }) => [myco.Light2D.sampleAt(new myco.Vector2(-6, 0)).r, myco.Light2D.sampleAt(new myco.Vector2(6, 0)).r] as number[]);
  expect(sampled[0]).toBeGreaterThan(1.5);
  expect(sampled[1]).toBeLessThan(0.2);

  // A white light in the middle with shadows, and a wall to its right: right of the wall is darker than the mirrored left.
  await inLiveWorld(page, null, (w, { myco }) => {
    const find = (n: LiveNode): LiveNode | null => (n.name === "Torch" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null));
    (find(w!.root)!.getComponents(myco.Light2D)[0] as { enabled: boolean }).enabled = false;
    const lamp = myco.GameObject.create("Lamp");
    lamp.addBehavior(myco.Light2D, { type: "point", intensity: 1.5, innerRadius: 6, outerRadius: 9, shadows: true });
    const wall = myco.GameObject.create("Wall");
    wall.transform.position.set(3, 0, 0);
    wall.addBehavior(myco.ShadowCaster2D, { shape: "custom", path: [new myco.Vector2(-0.3, -2), new myco.Vector2(0.3, -2), new myco.Vector2(0.3, 2), new myco.Vector2(-0.3, 2)] });
  });
  await expect
    .poll(async () => {
      const c = await captureView(view);
      return mean(c, 3, LEFT) - mean(c, 3, RIGHT);
    }, { timeout: 30_000, message: "the wall's shadow darkens the right side" })
    .toBeGreaterThan(50);
  const shadowed = await inLiveWorld(page, null, (_w, { myco }) => myco.Light2D.sampleAt(new myco.Vector2(6, 0)).r as number);
  expect(shadowed).toBeLessThan(0.2); // only the global light reaches behind the wall
  expect(errors).toEqual([]);
});

test("ADR 0415 in Play: a light's volume glows over the sprite, an alpha blend light covers the light below, light masks pick casters", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  // The sample's project with a "Walls" shadow layer (ADR 0415: shadow masks name the project's shadow layers).
  const project = { ...JSON.parse(readFileSync("samples/flappy/project.json", "utf8")), lighting2D: { shadowLayers: ["Default", "Walls"] } };
  await openEditor(page, { files: { "project.json": JSON.stringify(project), "scenes/main.scene.json": scene([node("global", "Global", [0, 0, 0], [{ type: "engine.Light2D", data: { type: "global", intensity: 0.1 } }])]) } });
  await play(page);
  const view = gameView(page);
  await expect.poll(async () => mean(await captureView(view), 3, ALL), { timeout: 30_000, message: "the dim global light darkens the quad" }).toBeLessThan(110);
  const CENTRE: [number, number, number, number] = [0.45, 0.4, 0.55, 0.6];

  // A dim point light in the middle, then its volume: the glow adds over the lit sprite.
  await inLiveWorld(page, null, (_w, { myco }) => {
    myco.GameObject.create("Lamp").addBehavior(myco.Light2D, { type: "point", intensity: 0.3, innerRadius: 1, outerRadius: 3 });
  });
  await expect.poll(async () => mean(await captureView(view), 3, CENTRE), { timeout: 30_000, message: "the lamp lights the middle" }).toBeGreaterThan(40);
  const before = mean(await steadyView(view), 3, CENTRE);
  await inLiveWorld(page, null, (w, { myco }) => {
    const lamp = (function find(n: LiveNode): LiveNode | null { return n.name === "Lamp" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null); })(w!.root)!;
    (lamp.getComponents(myco.Light2D)[0] as { volumeIntensity: number }).volumeIntensity = 1;
  });
  await expect.poll(async () => mean(await captureView(view), 3, CENTRE), { timeout: 30_000, message: "the volume glows over the sprite" }).toBeGreaterThan(before + 30);

  // A bright white global light, then a red alpha blend light over the middle: its core replaces the white there.
  await inLiveWorld(page, null, (w, { myco }) => {
    const lamp = (function find(n: LiveNode): LiveNode | null { return n.name === "Lamp" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null); })(w!.root)!;
    (lamp.getComponents(myco.Light2D)[0] as { enabled: boolean }).enabled = false;
    const global = (function find(n: LiveNode): LiveNode | null { return n.name === "Global" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null); })(w!.root)!;
    (global.getComponents(myco.Light2D)[0] as { intensity: number }).intensity = 1;
    myco.GameObject.create("Red").addBehavior(myco.Light2D, { type: "point", color: new myco.Color(1, 0, 0, 1), overlap: "alphaBlend", innerRadius: 2, outerRadius: 3 });
  });
  await expect
    .poll(async () => {
      const c = await captureView(view);
      return mean(c, 0, CENTRE) > 200 && mean(c, 1, CENTRE) < 60 && mean(c, 1, LEFT) > 200;
    }, { timeout: 30_000, message: "the middle is red (the white below is covered), the left still white" })
    .toBe(true);

  // Light masks: a wall on the "Walls" shadow layer shadows a light whose mask has it, not one whose mask doesn't.
  // (Sampled a frame after each change, once the new nodes' world matrices are in.)
  await inLiveWorld(page, null, (w, { myco }) => {
    // Only the probe light lights: the others would add to what's sampled.
    const all = (n: LiveNode): LiveNode[] => [n, ...n.children.flatMap(all)];
    for (const n of all(w!.root)) for (const l of n.getComponents(myco.Light2D)) (l as { enabled: boolean }).enabled = false;
    const wall = myco.GameObject.create("Wall");
    wall.transform.position.set(3, 0, 0);
    wall.addBehavior(myco.ShadowCaster2D, { shape: "custom", shadowMask: ["Walls"], path: [new myco.Vector2(-0.3, -2), new myco.Vector2(0.3, -2), new myco.Vector2(0.3, 2), new myco.Vector2(-0.3, 2)] });
    myco.GameObject.create("Probe").addBehavior(myco.Light2D, { type: "point", innerRadius: 8, outerRadius: 9, shadows: true, shadowMask: ["Walls"], targetSortingLayers: ["Probe"] });
  });
  // Sample the probe light behind the wall; with `mask`, give it that shadow mask afterwards.
  const probe = (mask: string[] | null) =>
    inLiveWorld(
      page,
      null,
      (w, { myco }, m: string[] | null) => {
        const find = (n: LiveNode): LiveNode | null => (n.name === "Probe" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null));
        const r = myco.Light2D.sampleAt(new myco.Vector2(6, 0), "Probe").r as number;
        if (m) (find(w!.root)!.getComponents(myco.Light2D)[0] as { shadowMask: string[] }).shadowMask = m;
        return r;
      },
      mask,
    );
  await expect.poll(() => probe(null), { timeout: 10_000, message: "a light masked to Walls is shadowed by the wall on Walls" }).toBeLessThan(0.1);
  await probe(["Default"]);
  await expect.poll(() => probe(null), { timeout: 10_000, message: "a light masked to Default isn't: the wall isn't on its layers" }).toBeGreaterThan(0.9);
  expect(errors).toEqual([]);
});

test("in the editor: Create > Point Light 2D, Edit Shape's outer radius (saved), fields by type, and the 2D Lights toggle", async ({ page }) => {
  await openEditor(page, { files: { "scenes/main.scene.json": scene([node("global", "Global", [0, 0, 0], [{ type: "engine.Light2D", data: { type: "global", intensity: 0.1 } }])]) } });
  const sceneView = page.locator(".viewport canvas");
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([0, 0, 0], 14));
  const dim = await steadyView(sceneView);
  const dimMean = mean(dim, 3, ALL);

  // The scene view's 2D Lights toggle: off draws 2D unlit (brighter), on lights it again.
  const toggle = page.getByRole("button", { name: "2D Lights" });
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await toggle.click();
  await expect.poll(async () => mean(await captureView(sceneView), 3, ALL), { timeout: 20_000, message: "2D Lights off draws the quad unlit" }).toBeGreaterThan(dimMean + 40);
  await toggle.click();
  await expect.poll(async () => mean(await captureView(sceneView), 3, ALL), { timeout: 20_000, message: "2D Lights on lights it again" }).toBeLessThan(dimMean + 20);

  // Create > 2D Lights > Point Light 2D: selected, with only a point light's fields shown.
  await page.getByRole("button", { name: "Create node" }).click();
  await page.locator(".hierarchy-menu [role=menuitem]").filter({ hasText: /^2D Lights/ }).first().hover();
  await page.locator(".hierarchy-menu [role=menuitem]").filter({ hasText: /^Point Light 2D/ }).first().click();
  await expect(row(page, "point-light-2-d")).toHaveClass(/selected/);
  const light = card(page, "Light2D");
  await expect(light.locator('label[title="outerRadius"], label:text-is("Outer Radius")').first()).toBeVisible();
  await expect(light.locator(".fields [data-lights2d-hidden]").first()).toBeAttached(); // Shape, Falloff Size, Sprite are hidden

  // Edit Shape: drag the outer radius handle outwards, save, and the scene file has a bigger radius.
  const edit = light.getByRole("button", { name: "Edit Shape" });
  await edit.click();
  await expect(edit).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => ((window as unknown as Hooks).overlayHandles?.() ?? []).some((h) => h.id === "outerRadius"));
  const canvas = (await sceneView.boundingBox())!;
  const handle = (await page.evaluate(() => (window as unknown as Hooks).overlayHandles!())).find((h) => h.id === "outerRadius")!;
  await page.mouse.move(canvas.x + handle.x, canvas.y + handle.y);
  await page.mouse.down();
  await page.mouse.move(canvas.x + handle.x, canvas.y + handle.y - 80, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.press("ControlOrMeta+s");
  const savedRadius = () =>
    page.evaluate(() => {
      const text = (window as unknown as Hooks).testFolder.read("scenes/main.scene.json");
      const n = text ? JSON.parse(text).nodes.find((x: { id: string }) => x.id === "point-light-2-d") : null;
      return (n?.components.find((c: { type: string }) => c.type === "engine.Light2D")?.data.outerRadius ?? 3) as number;
    });
  await expect.poll(savedRadius, { timeout: 15_000, message: "the dragged outer radius is saved" }).toBeGreaterThan(3.2);
});

test("Project > 2D Lighting adds a blend style to project.json", async ({ page }) => {
  await openEditor(page, { files: { "scenes/main.scene.json": scene() } });
  await showTab(page, /^Project/);
  await pickCategory(page, "2D Lighting");
  const styles = page.locator(".panel.project").getByRole("group", { name: "Light blend styles" });
  await expect(styles.locator("[data-blend-style]")).toHaveCount(1);
  await styles.getByRole("button", { name: "Add Blend Style" }).click();
  await expect(styles.locator("[data-blend-style]")).toHaveCount(2);
  const blendStyles = () =>
    page.evaluate(() => {
      const text = (window as unknown as Hooks).testFolder.read("project.json");
      return (text ? JSON.parse(text).lighting2D?.blendStyles ?? [] : []).map((s: { name: string }) => s.name) as string[];
    });
  await expect.poll(blendStyles, { timeout: 15_000 }).toEqual(["Multiply", "Style"]);
});
