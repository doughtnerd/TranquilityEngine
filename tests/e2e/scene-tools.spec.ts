import { expect, test, type Page } from "./fixtures";
import { captureArea, captureView, pixelsChanged, steadyView, type ViewCapture } from "./viewCapture";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

interface Handle {
  id: string;
  x: number;
  y: number;
}

/** The editor's debug hooks on `window` (see session.ts). Page callbacks are serialized, so each casts `window` itself. */
type Hooks = {
  engine?: { world: { time: { frameCount: number }; root: unknown } };
  orbit: { focus(point?: [number, number, number], distance?: number): void };
  overlayHandles?: () => Handle[];
};

/** The scene view's canvas; what it draws (the grid, the camera preview) is read from captures of it. */
const sceneCanvas = (page: Page) => page.locator(".panel.scene #viewport canvas");
/** How many of the scene view's pixels changed since `before`. The grid's lines are faint, so a small difference counts. */
const changedSince = async (page: Page, before: ViewCapture) => pixelsChanged(before, await captureView(sceneCanvas(page)), 8);

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

// Several steps each, and WebKit renders on the CPU: give these tests the slow-test allowance.
test.beforeEach(() => test.slow());

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Scene tools" });

/** A node of the edited scene, found by its scene-file id: its world position and its points collider's points, if any. */
async function nodeState(page: Page, id: string): Promise<{ x: number; y: number; points: number[][] | null }> {
  return page.evaluate((id) => {
    type N = { id: string; children: N[]; entity: number; world: { _componentsOf(e: number): unknown[] }; transform: { worldPosition: { x: number; y: number } } };
    const find = (n: N): N | null => (n.id === id ? n : n.children.reduce<N | null>((f, c) => f ?? find(c), null));
    const node = find((window as unknown as Hooks).engine!.world.root as N)!;
    const poly = node.world._componentsOf(node.entity).find((c) => Array.isArray((c as { points?: unknown }).points)) as { points: number[][] } | undefined;
    const p = node.transform.worldPosition;
    return { x: p.x, y: p.y, points: poly ? poly.points.map((q) => [...q]) : null };
  }, id);
}

async function handles(page: Page): Promise<Record<string, Handle>> {
  await page.waitForFunction(() => ((window as unknown as Hooks).overlayHandles?.() ?? []).length > 0);
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const list = await page.evaluate(() => (window as unknown as Hooks).overlayHandles!());
  return Object.fromEntries(list.map((h) => [h.id, { ...h, x: canvas.x + h.x, y: canvas.y + h.y }]));
}

test("space and pivot toggle from the toolbar and with X / Z, and are remembered", async ({ page }) => {
  await openEditor(page);
  const space = toolbar(page).locator(".gizmo-space");
  const pivot = toolbar(page).locator(".gizmo-pivot");
  await expect(space).toHaveText("World");
  await expect(pivot).toHaveText("Center");
  await space.click();
  await expect(space).toHaveText("Local");
  await expect(space).toHaveAttribute("aria-pressed", "true");
  await page.locator(".viewport canvas").focus();
  await page.keyboard.press("z");
  await expect(pivot).toHaveText("Pivot");
  await page.keyboard.press("x");
  await expect(space).toHaveText("World");
  await page.keyboard.press("x");
  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await expect(toolbar(page).locator(".gizmo-space")).toHaveText("Local");
  await expect(toolbar(page).locator(".gizmo-pivot")).toHaveText("Pivot");
});

test("snap settings set the grid and steps; Always snap toggles; settings are remembered", async ({ page }) => {
  await openEditor(page);
  // The grid is an editor helper, loaded lazily: wait until the view has stopped changing. The popover stays open (and
  // still) over the view meanwhile, so each change shows in the view's pixels.
  await toolbar(page).getByRole("button", { name: "Snap settings" }).click();
  const popover = page.getByRole("dialog", { name: "Snap settings" });
  await expect(popover).toBeVisible();
  const view = sceneCanvas(page);
  const atOne = await steadyView(view);
  await popover.getByRole("textbox", { name: "Grid size" }).fill("4");
  await popover.getByRole("textbox", { name: "Grid size" }).press("Enter");
  await popover.getByRole("textbox", { name: "Move step" }).fill("2");
  await popover.getByRole("textbox", { name: "Move step" }).press("Enter");
  await expect.poll(() => changedSince(page, atOne), { message: "a coarser grid is drawn" }).toBeGreaterThan(300);
  const atFour = await steadyView(view);
  await popover.getByRole("checkbox", { name: "Show grid" }).uncheck();
  await expect.poll(() => changedSince(page, atFour), { message: "the grid is hidden" }).toBeGreaterThan(300);
  // Shown again at 4, the view is as it was; hidden again for the reload below.
  const hidden = await steadyView(view);
  await popover.getByRole("checkbox", { name: "Show grid" }).check();
  await expect.poll(() => changedSince(page, atFour)).toBeLessThan(60);
  await popover.getByRole("checkbox", { name: "Show grid" }).uncheck();
  await expect.poll(() => changedSince(page, hidden)).toBeLessThan(60);
  await popover.press("Escape");
  await expect(popover).toHaveCount(0);

  const snap = toolbar(page).locator(".snap-toggle");
  await snap.click();
  await expect(snap).toHaveAttribute("aria-pressed", "true");
  await expect(page.locator(".viewport-hint")).toContainText("Snapping");

  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await expect(toolbar(page).locator(".snap-toggle")).toHaveAttribute("aria-pressed", "true");
  await toolbar(page).getByRole("button", { name: "Snap settings" }).click();
  await expect(page.getByRole("textbox", { name: "Grid size" })).toHaveValue("4");
  await expect(page.getByRole("checkbox", { name: "Show grid" })).not.toBeChecked();
  await expect(page.getByRole("textbox", { name: "Move step" })).toHaveValue("2");
});

test("Align right lines selected nodes up in one undo step; Align is off with one node", async ({ page }) => {
  await openEditor(page);
  await toolbar(page).getByRole("button", { name: "2D", exact: true }).click();
  const align = toolbar(page).getByRole("button", { name: "Align" });
  await page.locator('.tree .row[data-key="bird"]').click();
  await expect(align).toBeDisabled();
  await page.locator('.tree .row[data-key="ceiling"]').click({ modifiers: ["ControlOrMeta"] });
  await expect(align).toBeEnabled();
  await align.click();
  const menu = page.getByRole("dialog", { name: "Align" });
  await expect(menu.getByRole("button", { name: "horizontally" })).toBeDisabled(); // distribute needs three
  await menu.getByRole("button", { name: "Right", exact: true }).click();
  expect((await nodeState(page, "bird")).x).toBeCloseTo(0, 4);
  expect((await nodeState(page, "ceiling")).x).toBeCloseTo(0, 4);
  await page.keyboard.press("Escape");
  await page.locator(".viewport canvas").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await nodeState(page, "bird")).x).toBeCloseTo(-4, 4);
});

test("a polygon collider's vertices drag, an edge's middle handle adds one, Ctrl+click removes one", async ({ page }) => {
  await openEditor(page);
  await page.locator('.tree .row[data-key="bird"]').click();
  await page.locator(".add-component-button").click();
  await page.keyboard.type("PolygonCollider2D");
  await page.keyboard.press("Enter");
  const card = page.locator("section.component", { has: page.locator("h3", { hasText: "PolygonCollider2D" }) });
  await expect(card).toHaveCount(1);
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([-4, 1, 0], 3));
  await card.locator(".edit-collider").click();
  let h = await handles(page);
  expect(Object.keys(h).filter((k) => k.startsWith("vertex:"))).toHaveLength(4);

  // Drag the top-right vertex to the right: one undo step.
  await page.mouse.move(h["vertex:2"].x, h["vertex:2"].y);
  await page.mouse.down();
  await page.mouse.move(h["vertex:2"].x + 40, h["vertex:2"].y, { steps: 8 });
  await page.mouse.up();
  const dragged = (await nodeState(page, "bird")).points!;
  expect(dragged[2][0]).toBeGreaterThan(0.6);
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Bird"); // the press didn't select through

  // Press the bottom edge's middle handle: a fifth vertex.
  h = await handles(page);
  await page.mouse.click(h["insert:0"].x, h["insert:0"].y);
  await expect.poll(async () => (await nodeState(page, "bird")).points!.length).toBe(5);

  // Ctrl+click a vertex: removed.
  h = await handles(page);
  await page.keyboard.down("Control");
  await page.mouse.click(h["vertex:0"].x, h["vertex:0"].y);
  await page.keyboard.up("Control");
  await expect.poll(async () => (await nodeState(page, "bird")).points!.length).toBe(4);

  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await nodeState(page, "bird")).points!.length).toBe(5);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await nodeState(page, "bird")).points!.length).toBe(4);
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => (await nodeState(page, "bird")).points![2][0]).toBe(0.5);
});

test("selecting a camera shows its preview inset; the toolbar toggle hides it", async ({ page }) => {
  await openEditor(page);
  await expect(page.locator(".camera-preview")).toHaveCount(0);
  await page.locator('.tree .row[data-key="camera"]').click();
  await expect(page.locator(".camera-preview")).toBeVisible();
  await expect(page.locator(".camera-preview-label")).toHaveText("Camera");
  // The engine draws what the camera sees inside the inset's frame: most of the inset changes when the preview is
  // turned off and the scene view shows through (the frame's border and label alone are a small part of it).
  await steadyView(sceneCanvas(page));
  const box = (await page.locator(".camera-preview").boundingBox())!;
  const inset = await captureArea(page, box);

  const toggle = toolbar(page).locator(".camera-preview-toggle");
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".camera-preview")).toHaveCount(0);
  await expect
    .poll(async () => pixelsChanged(inset, await captureArea(page, box)) / (inset.width * inset.height), { message: "share of the inset that changed" })
    .toBeGreaterThan(0.3);
  await toggle.click();
  await page.locator('.tree .row[data-key="bird"]').click();
  await expect(page.locator(".camera-preview")).toHaveCount(0);
});
