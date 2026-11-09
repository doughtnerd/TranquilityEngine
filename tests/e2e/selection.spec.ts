import { afterFrames, expect, type Page, test } from "./fixtures";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/** The editor's debug hooks on `window` (see session.ts). Page callbacks are serialized, so each casts `window` itself. */
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  orbit: { focus(point?: [number, number, number], distance?: number): void };
  nodeRect(key: string): Rect | null;
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([0, 0, 0], 14));
  await afterFrames(page); // the camera moves on the next frame
}

const selected = (page: Page) => page.locator(".tree .row.selected").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.key!));

/** A node's rectangle in page coordinates, grown by `margin`. */
async function rectOf(page: Page, key: string, margin = 6): Promise<Rect> {
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const r = (await page.evaluate((k) => (window as unknown as Hooks).nodeRect(k), key))!;
  return { left: canvas.x + r.left - margin, top: canvas.y + r.top - margin, right: canvas.x + r.right + margin, bottom: canvas.y + r.bottom + margin };
}

const union = (a: Rect, b: Rect): Rect => ({ left: Math.min(a.left, b.left), top: Math.min(a.top, b.top), right: Math.max(a.right, b.right), bottom: Math.max(a.bottom, b.bottom) });

/** Drag a selection box over `r`, holding `modifier` if given; `release: false` leaves the button down. */
async function dragBox(page: Page, r: Rect, modifier?: "Shift" | "Control", release = true): Promise<void> {
  if (modifier) await page.keyboard.down(modifier);
  await page.mouse.move(r.left, r.top);
  await page.mouse.down();
  await page.mouse.move((r.left + r.right) / 2, (r.top + r.bottom) / 2, { steps: 4 });
  await page.mouse.move(r.right, r.bottom, { steps: 4 });
  if (release) await page.mouse.up();
  if (modifier) await page.keyboard.up(modifier);
}

test("dragging a box selects everything inside it; Shift adds, Ctrl toggles", async ({ page }) => {
  await openEditor(page);
  const bird = union(await rectOf(page, "bird"), await rectOf(page, "bird-sprite"));

  await dragBox(page, bird, undefined, false);
  await expect(page.locator(".selection-box")).toBeVisible();
  await page.mouse.up();
  await expect(page.locator(".selection-box")).toHaveCount(0);
  expect(await selected(page)).toEqual(expect.arrayContaining(["bird", "bird-sprite"]));
  expect(await selected(page)).not.toContain("camera");
  await expect(page.locator(".multi-name")).toHaveText(/nodes selected/);

  await dragBox(page, await rectOf(page, "camera"), "Shift");
  expect(await selected(page)).toEqual(expect.arrayContaining(["bird", "bird-sprite", "camera"]));

  await dragBox(page, bird, "Control"); // toggles the bird and its sprite back off
  expect(await selected(page)).toEqual(["camera"]);
});

test("Escape during a box drag puts the selection back", async ({ page }) => {
  await openEditor(page);
  await page.locator('.tree .row[data-key="ceiling"]').click();
  await dragBox(page, union(await rectOf(page, "bird"), await rectOf(page, "bird-sprite")), undefined, false);
  expect(await selected(page)).toContain("bird"); // live while dragging
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await selected(page)).toEqual(["ceiling"]);
});

test("Alt+click lists the nodes under the pointer, occluded ones and children too, to refine the selection", async ({ page }) => {
  await openEditor(page);
  await page.locator('.tree .row[data-key="ceiling"]').click();
  const sprite = await rectOf(page, "bird-sprite", 0);
  const at = { x: (sprite.left + sprite.right) / 2, y: (sprite.top + sprite.bottom) / 2 };

  await page.keyboard.down("Alt");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Alt");
  const list = page.getByRole("listbox", { name: "Nodes near the click" });
  await expect(list).toBeVisible();
  const options = list.getByRole("option");
  await expect(options).toHaveText(["bg-a", "Bird", "Sprite"]); // the background behind the bird, and Bird's child

  await options.filter({ hasText: "Sprite" }).click();
  expect(await selected(page)).toEqual(["bird-sprite"]); // live
  await options.filter({ hasText: "bg-a" }).click({ modifiers: ["ControlOrMeta"] });
  expect((await selected(page)).sort()).toEqual(["bg-a", "bird-sprite"]);
  await expect(options.filter({ hasText: "bg-a" })).toHaveAttribute("aria-selected", "true");

  await page.keyboard.press("Escape"); // cancel: back to the Ceiling
  await expect(list).toHaveCount(0);
  expect(await selected(page)).toEqual(["ceiling"]);

  await page.keyboard.down("Alt");
  await page.mouse.click(at.x, at.y);
  await page.keyboard.up("Alt");
  await options.first().click();
  await options.last().click({ modifiers: ["Shift"] }); // a range: all three
  await page.keyboard.press("Enter");
  await expect(list).toHaveCount(0);
  expect((await selected(page)).sort()).toEqual(["bg-a", "bird", "bird-sprite"]);
});

test("the hierarchy selects with Ctrl+click and Shift+click ranges", async ({ page }) => {
  await openEditor(page);
  const row = (k: string) => page.locator(`.tree .row[data-key="${k}"]`);
  await row("camera").click();
  await row("ground-a").click({ modifiers: ["Shift"] });
  expect(await selected(page)).toEqual(["camera", "bg-a", "bg-b", "ground-a"]);
  await row("bg-b").click({ modifiers: ["ControlOrMeta"] });
  expect(await selected(page)).toEqual(["camera", "bg-a", "ground-a"]);
  await row("ceiling").click();
  expect(await selected(page)).toEqual(["ceiling"]);
});

test("the inspector edits a shared field on every selected node in one undo step", async ({ page }) => {
  await openEditor(page);
  await page.locator('.tree .row[data-key="ground-collider"]').click();
  await page.locator('.tree .row[data-key="ceiling"]').click({ modifiers: ["ControlOrMeta"] });
  await expect(page.locator(".multi-name")).toHaveText("2 nodes selected");
  const sizeX = page.getByRole("textbox", { name: "size x" });
  const sizeY = page.getByRole("textbox", { name: "size y" });
  await expect(sizeX).toHaveValue("40");
  await expect(sizeY).toHaveValue("—"); // 10 and 1: differs

  await sizeX.fill("30");
  await sizeX.press("Enter");
  for (const key of ["ground-collider", "ceiling"]) {
    await page.locator(`.tree .row[data-key="${key}"]`).click();
    await expect(sizeX).toHaveValue("30");
  }
  await expect(sizeY).toHaveValue("1"); // each node kept its own height

  await page.keyboard.press("ControlOrMeta+z");
  await expect(sizeX).toHaveValue("40");
  await page.locator('.tree .row[data-key="ground-collider"]').click();
  await expect(sizeX).toHaveValue("40");
});

test("clicking anywhere inside a collider selects its node, before the sprites drawn there", async ({ page }) => {
  await openEditor(page);
  await page.keyboard.press("q"); // no gizmo in the way of repeated clicks
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([0, -10, 0], 14));
  await afterFrames(page); // the camera moves on the next frame
  // GroundCollider draws nothing; its origin is the middle of its 40 × 10 box, under the ground sprites.
  const origin = await rectOf(page, "ground-collider", 0);
  await page.mouse.click(origin.left + 30, origin.top - 10);
  expect(await selected(page)).toEqual(["ground-collider"]);
  await page.mouse.click(origin.left + 30, origin.top - 10); // the same spot again: what's drawn there
  expect(await selected(page)).not.toEqual(["ground-collider"]);
  expect((await selected(page)).length).toBe(1);
});
