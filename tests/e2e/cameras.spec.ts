import { expect, type Hooks, test, type Page, openEditor } from "./fixtures";
import { captureArea, pixelsChanged, type ViewCapture } from "./viewCapture";

// Reflection probes (ADR 0054), camera viewports with effects on every camera and in the editor's
// camera inset (ADR 0056), on the read-only 3D Playground. What the renderer does with them is its
// unit tests': probe captures, reflections and the tier turning probes off (babylonProbes.test.ts),
// which views a frame draws, the inset and a composer per camera with effects (framePlan.test.ts),
// and which effects a tier keeps (postEffects.test.ts).

test.describe.configure({ timeout: 60_000 });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

async function openPlayground(page: Page): Promise<void> {
  await openEditor(page, { sample: "playground3d" });
}

/** The editor's World has stepped `n` more frames: the scene view keeps drawing (a failing pass would stop the render loop). */
async function keepsDrawing(page: Page, n = 10): Promise<void> {
  const frames = await page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).engine!.world.time.frameCount), { timeout: 20_000 }).toBeGreaterThan(frames + n);
}
const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

test("a reflection probe from the Create menu goes in the scene, and the view draws it on every tier, Low's without probes", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page);
  await page.getByRole("button", { name: "Create node" }).click();
  await page.locator(".hierarchy-menu [role=menuitem]").filter({ has: page.locator("span:first-child", { hasText: /^Create Reflection Probe$/ }) }).click();
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Reflection Probe");
  // Created at the view's focus point; move it to the middle of the scene, around the robot and crates.
  for (const [axis, value] of [["x", "0"], ["y", "1"], ["z", "0"]]) {
    const field = page.getByRole("textbox", { name: `position ${axis}` });
    await field.fill(value);
    await field.press("Enter");
  }
  await expect(page.getByRole("textbox", { name: "position y" })).toHaveValue("1");
  await keepsDrawing(page); // the probe captures and the meshes inside it reflect it
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Low"); // reflectionProbes: off
  await keepsDrawing(page);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Ultra");
  await keepsDrawing(page);
  expect(errors).toEqual([]);
});

test("the selected camera's inset shows its effects", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page);
  await row(page, "Camera").click();
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  if ((await preview.getAttribute("aria-pressed")) !== "true") await preview.click();
  await expect(page.getByRole("img", { name: "Camera preview: Camera" })).toBeVisible({ timeout: 15_000 });
  await keepsDrawing(page); // the inset draws the camera's view through its own effects
  expect(errors).toEqual([]);
});

test("in play, a second camera in a corner viewport gets its own composer, drawn over the main view", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).playEngine?.world.time.frameCount ?? 0) > 10);
  const before = await steadyCorner(page);

  // A minimap camera on the main camera's node (so it looks the same way): depth 1, top-right corner, no background
  // (an overlay), with bloom. Found and made through the public node API: every component of a node is an Object.
  await page.evaluate(() => {
    type Comp = Record<string, unknown> & { constructor: unknown };
    type Node = { children: Node[]; getComponents(type: unknown): Comp[]; addComponent(type: unknown, init?: unknown): Record<string, unknown>; constructor: { create(name: string, o: unknown): Node } };
    const root = (window as unknown as Hooks).playEngine!.world.root as unknown as Node;
    const isCamera = (c: Comp) => "orthographicSize" in c && "viewportPosition" in c;
    const find = (n: Node): Node | null => (n.getComponents(Object).some(isCamera) ? n : n.children.reduce<Node | null>((hit, c) => hit ?? find(c), null));
    const main = find(root)!;
    const cam = main.getComponents(Object).find(isCamera)!;
    const post = main.getComponents(Object).find((c) => "bloomThreshold" in c)!;
    const node = main.constructor.create("Minimap", { parent: main });
    const mini = node.addComponent(cam.constructor) as { projection: string; depth: number; viewportPosition: { set(x: number, y: number): void }; viewportSize: { set(x: number, y: number): void } };
    mini.projection = "perspective";
    mini.depth = 1;
    mini.viewportPosition.set(0.7, 0.7);
    mini.viewportSize.set(0.3, 0.3);
    node.addComponent(post.constructor, { bloom: true });
  });
  // The corner now shows the minimap's view, drawn over the main one.
  await expect.poll(async () => pixelsChanged(before, await corner(page)), { timeout: 15_000, message: "pixels of the corner the minimap draws over" }).toBeGreaterThan((before.width * before.height) / 10);
  const frames = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).playEngine!.world.time.frameCount)).toBeGreaterThan(frames + 10);
  expect(errors).toEqual([]);
});

/** The top-right corner of the game view, inside where the minimap draws (its viewport starts at 0.7, 0.7 from the bottom left). */
async function corner(page: Page): Promise<ViewCapture> {
  const b = (await page.locator("#game-view canvas").first().boundingBox())!;
  return captureArea(page, { x: b.x + b.width * 0.72, y: b.y + b.height * 0.02, width: b.width * 0.26, height: b.height * 0.26 });
}

/** The corner once two captures in a row barely differ (the game's first frames have drawn), or after 15 s as it is then. */
async function steadyCorner(page: Page): Promise<ViewCapture> {
  const until = Date.now() + 15_000;
  let last = await corner(page);
  for (;;) {
    await page.waitForTimeout(250);
    const next = await corner(page);
    if (pixelsChanged(last, next) <= (next.width * next.height) / 50 || Date.now() > until) return next;
    last = next;
  }
}
