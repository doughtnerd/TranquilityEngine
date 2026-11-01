import { expect, test, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html";

interface Handle {
  id: string;
  x: number;
  y: number;
}

/** The editor's debug hooks on `window` (see session.ts). Page callbacks are serialized, so each casts `window` itself. */
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  orbit: { focus(point?: [number, number, number], distance?: number): void };
  overlayHandles?: () => Handle[];
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

/** Select a node, frame `point`, and turn on Edit Collider; returns the handles in page coordinates. */
async function editCollider(page: Page, key: string, point: [number, number, number], distance: number): Promise<Record<string, Handle>> {
  await page.locator(`.tree .row[data-key="${key}"]`).click();
  await page.evaluate(([p, d]) => (window as unknown as Hooks).orbit.focus(p, d), [point, distance] as const);
  await page.locator(".edit-collider").click();
  await expect(page.locator(".edit-collider")).toHaveAttribute("aria-pressed", "true");
  return handles(page);
}

async function handles(page: Page): Promise<Record<string, Handle>> {
  await page.waitForFunction(() => ((window as unknown as Hooks).overlayHandles?.() ?? []).length > 0);
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const list = await page.evaluate(() => (window as unknown as Hooks).overlayHandles!());
  return Object.fromEntries(list.map((h) => [h.id, { ...h, x: canvas.x + h.x, y: canvas.y + h.y }]));
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}

test("dragging a circle collider's rim handle sets its radius, in one undo step", async ({ page }) => {
  await openEditor(page);
  const h = await editCollider(page, "bird", [-4, 1, 0], 3);
  expect(Object.keys(h).sort()).toEqual(["center", "radius-bottom", "radius-left", "radius-right", "radius-top"]);
  const radius = page.getByRole("textbox", { name: "radius" });
  await expect(radius).toHaveValue("0.7");

  await drag(page, h["radius-right"], 40, 0);
  expect(parseFloat(await radius.inputValue())).toBeGreaterThan(0.9);
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Bird"); // the press didn't select through

  await page.keyboard.press("ControlOrMeta+z");
  await expect(radius).toHaveValue("0.7");
});

test("dragging a box collider's edge resizes it from the opposite edge; the centre handle moves it", async ({ page }) => {
  await openEditor(page);
  const h = await editCollider(page, "ground-collider", [0, -10, 0], 12);
  const sizeY = page.getByRole("textbox", { name: "size y" });
  const centerX = page.getByRole("textbox", { name: "center x" });
  const centerY = page.getByRole("textbox", { name: "center y" });

  await drag(page, h.top, 0, -30); // up: taller, centre half-way up
  const height = parseFloat(await sizeY.inputValue());
  expect(height).toBeGreaterThan(10);
  expect(parseFloat(await centerY.inputValue())).toBeCloseTo((height - 10) / 2, 2);

  const moved = await handles(page);
  await drag(page, moved.center, 30, 0);
  expect(parseFloat(await centerX.inputValue())).toBeGreaterThan(0);
});

test("Edit Collider turns off when another tool is picked, hiding the handles", async ({ page }) => {
  await openEditor(page);
  await editCollider(page, "bird", [-4, 1, 0], 3);
  await page.getByRole("button", { name: "Move" }).click(); // already the tool: picking it still ends editing
  await expect(page.locator(".edit-collider")).toHaveAttribute("aria-pressed", "false");
  await page.waitForFunction(() => (window as unknown as Hooks).overlayHandles!().length === 0);
});
