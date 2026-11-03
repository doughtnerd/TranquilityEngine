import { expect, test, type Page } from "@playwright/test";

// Reflection probes (ADR 0054), camera viewports with effects on every camera and in the editor's
// camera inset (ADR 0056), on the read-only 3D Playground.

test.describe.configure({ timeout: 60_000 });

type Render = {
  probeState(): { captured: number; probes: number; reflecting: number };
  stackCount(): number;
  postState(): { composed: boolean };
  cameraPreviewComposed: boolean;
  cameras: Map<unknown, unknown>;
};
type Hooks = {
  engine?: { world: { time: { frameCount: number }; render: Render } };
  playEngine?: { world: { time: { frameCount: number }; render: Render; root: unknown } } | null;
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => msg.type() === "error" && errors.push(msg.text()));
  return errors;
}

async function openPlayground(page: Page): Promise<void> {
  await page.goto("/editor.html?sample=playground3d");
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

const probes = (page: Page) => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.probeState());
const row = (page: Page, name: string) => page.locator(".tree .row", { has: page.locator(".name", { hasText: new RegExp(`^${name}$`) }) });

test("a reflection probe from the Create menu captures the scene and the meshes inside it reflect it; Low turns probes off", async ({ page }) => {
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
  await expect.poll(async () => (await probes(page)).captured, { timeout: 15_000 }).toBe(1);
  await expect.poll(async () => (await probes(page)).reflecting).toBeGreaterThan(0);
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Low"); // reflectionProbes: off
  await expect.poll(async () => await probes(page)).toMatchObject({ captured: 0, reflecting: 0 });
  await page.getByRole("combobox", { name: "Quality" }).selectOption("Ultra");
  await expect.poll(async () => (await probes(page)).reflecting).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test("the selected camera's inset shows its effects", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page);
  await row(page, "Camera").click();
  const preview = page.getByRole("button", { name: "Preview", exact: true });
  if ((await preview.getAttribute("aria-pressed")) !== "true") await preview.click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).engine!.world.render.cameraPreviewComposed), { timeout: 15_000 }).toBe(true);
  expect(errors).toEqual([]);
});

test("in play, a second camera in a corner viewport gets its own composer, drawn over the main view", async ({ page }) => {
  const errors = trackErrors(page);
  await openPlayground(page);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).playEngine?.world.time.frameCount ?? 0) > 10);
  const render = () => page.evaluate(() => {
    const r = (window as unknown as Hooks).playEngine!.world.render;
    return { stacks: r.stackCount(), composed: r.postState().composed };
  });
  await expect.poll(async () => (await render()).composed, { timeout: 15_000 }).toBe(true);
  expect((await render()).stacks).toBe(1);

  // A minimap camera: depth 1, top-right corner, no background (an overlay), with bloom.
  await page.evaluate(() => {
    type Node = { addComponent(type: unknown, init?: unknown): Record<string, unknown>; getComponents(type: unknown): Record<string, unknown>[]; constructor: { create(name: string, o: unknown): Node } };
    const w = (window as unknown as Hooks).playEngine!.world;
    const cam = [...w.render.cameras.keys()][0] as { node: Node; constructor: unknown };
    const ComponentClass = Object.getPrototypeOf(cam.constructor);
    const post = cam.node.getComponents(ComponentClass).find((c) => "bloomThreshold" in c)!;
    const node = cam.node.constructor.create("Minimap", { parent: w.root });
    const mini = node.addComponent(cam.constructor) as { projection: string; depth: number; viewportPosition: { set(x: number, y: number): void }; viewportSize: { set(x: number, y: number): void } };
    mini.projection = "perspective";
    mini.depth = 1;
    mini.viewportPosition.set(0.7, 0.7);
    mini.viewportSize.set(0.3, 0.3);
    node.addComponent(post.constructor, { bloom: true });
  });
  await expect.poll(async () => (await render()).stacks, { timeout: 15_000 }).toBe(2);
  const frames = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.time.frameCount);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).playEngine!.world.time.frameCount)).toBeGreaterThan(frames + 10);
  expect(errors).toEqual([]);
});
