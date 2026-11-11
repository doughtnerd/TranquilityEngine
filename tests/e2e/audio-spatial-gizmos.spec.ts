import { expect, test, type Page } from "./fixtures";
import { inspector, openSpatial, row, type SpatialHooks } from "./audioSpatial";

// The reverb zone gizmo with Edit Zone, and the occluder Inspector section (ADR 0162 E1, E2, E9) in a real browser, on
// the spatial scene of audioSpatial.ts. The zone's handles are read back through the editor's `overlayHandles` hook.
test.describe.configure({ timeout: 90_000 });

type Handle = { id: string; x: number; y: number };
const card = (page: Page, type: string) => inspector(page).locator(".component", { hasText: type }).first();
const zone = (page: Page) => card(page, "AudioReverbZone");
const field = (page: Page, name: string) => zone(page).getByRole("textbox", { name, exact: true });
const editZone = (page: Page) => zone(page).getByRole("button", { name: "Edit Zone" });

/** The zone's handles in page coordinates, once there are any. */
async function handles(page: Page): Promise<Record<string, Handle>> {
  await page.waitForFunction(() => ((window as unknown as SpatialHooks).overlayHandles?.() ?? []).length > 0);
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const list = await page.evaluate(() => (window as unknown as SpatialHooks).overlayHandles!());
  return Object.fromEntries(list.map((h) => [h.id, { ...h, x: canvas.x + h.x, y: canvas.y + h.y }]));
}

async function drag(page: Page, from: { x: number; y: number }, dx: number, dy: number): Promise<void> {
  await page.mouse.move(from.x, from.y);
  await page.mouse.down();
  await page.mouse.move(from.x + dx, from.y + dy, { steps: 8 });
  await page.mouse.up();
}

/** Select the zone, frame it and turn on Edit Zone. */
async function startEditing(page: Page): Promise<Record<string, Handle>> {
  await row(page, "zone").click();
  await page.evaluate(() => (window as unknown as SpatialHooks).orbit.focus([0, 1, 0], 22));
  await editZone(page).click();
  await expect(editZone(page)).toHaveAttribute("aria-pressed", "true");
  return handles(page);
}

test("Edit Zone shows a box's face handles and the blend handle; dragging a face resizes it, in one undo step", async ({ page }) => {
  await openSpatial(page);
  await row(page, "zone").click();
  await expect(editZone(page)).toHaveAttribute("aria-pressed", "false");
  expect(await page.evaluate(() => (window as unknown as SpatialHooks).overlayHandles!())).toEqual([]); // the volume draws, the handles wait for Edit Zone
  const h = await startEditing(page);
  expect(Object.keys(h).sort()).toEqual(["blend", "x+", "x-", "y+", "y-", "z+", "z-"]);
  await expect(field(page, "size x")).toHaveValue("10");
  await expect(field(page, "center x")).toHaveValue("0");

  // A face handle moves that face: the size grows, the centre follows by half the growth.
  await drag(page, h["x+"], 40, 0);
  await expect.poll(async () => parseFloat(await field(page, "size x").inputValue())).toBeGreaterThan(10);
  const size = parseFloat(await field(page, "size x").inputValue());
  expect(parseFloat(await field(page, "center x").inputValue())).toBeCloseTo((size - 10) / 2, 1);
  await expect(page.locator(".tree .row.selected .name")).toHaveText("Zone"); // the press didn't select through
  await expect(field(page, "size y")).toHaveValue("4"); // the other axes stay

  // The drag was one step: one undo restores both fields.
  await page.keyboard.press("ControlOrMeta+z");
  await expect(field(page, "size x")).toHaveValue("10");
  await expect(field(page, "center x")).toHaveValue("0");
  await page.keyboard.press("ControlOrMeta+Shift+z");
  await expect.poll(async () => parseFloat(await field(page, "size x").inputValue())).toBeCloseTo(size, 3);
});

test("the blend handle sets the blend distance; undo restores it", async ({ page }) => {
  await openSpatial(page);
  const h = await startEditing(page);
  await expect(field(page, "blendDistance")).toHaveValue("2");
  await drag(page, h.blend, 40, 0);
  await expect.poll(async () => parseFloat(await field(page, "blendDistance").inputValue())).not.toBe(2);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(field(page, "blendDistance")).toHaveValue("2");
});

test("a sphere zone has rim handles that set the radius; undo restores it", async ({ page }) => {
  await openSpatial(page);
  await row(page, "zone").click();
  await zone(page).getByRole("combobox").first().selectOption("sphere");
  await expect(field(page, "radius")).toHaveValue("5");
  await page.evaluate(() => (window as unknown as SpatialHooks).orbit.focus([0, 1, 0], 22));
  await editZone(page).click();
  const h = await handles(page);
  expect(Object.keys(h).sort()).toEqual(["blend", "radius:x+", "radius:x-", "radius:y+", "radius:y-", "radius:z+", "radius:z-"]);
  await drag(page, h["radius:x+"], 40, 0);
  await expect.poll(async () => parseFloat(await field(page, "radius").inputValue())).toBeGreaterThan(5);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(field(page, "radius")).toHaveValue("5");
});

test("Edit Zone ends when another tool is picked, or another node is selected, hiding the handles", async ({ page }) => {
  await openSpatial(page);
  await startEditing(page);
  await page.getByRole("button", { name: "Move", exact: true }).click();
  await expect(editZone(page)).toHaveAttribute("aria-pressed", "false");
  await page.waitForFunction(() => (window as unknown as SpatialHooks).overlayHandles!().length === 0);
  await editZone(page).click();
  await handles(page);
  await row(page, "wall").click();
  await page.waitForFunction(() => (window as unknown as SpatialHooks).overlayHandles!().length === 0);
  await row(page, "zone").click();
  await expect(editZone(page)).toHaveAttribute("aria-pressed", "false");
});

// --- the occluder ---------------------------------------------------------------------------------------------------

const occluder = (page: Page) => inspector(page).getByLabel("Occluder", { exact: true });
const warnings = (page: Page) => occluder(page).locator("[data-warning]");

test("an occluder over a collider says what it applies to and warns about nothing", async ({ page }) => {
  await openSpatial(page);
  await row(page, "wall").click();
  await expect(occluder(page)).toBeVisible();
  await expect(occluder(page)).toContainText("Applies to 1 collider: Wall.");
  await expect(warnings(page)).toHaveCount(0);
});

test("an occluder with no collider warns, and so does one whose child's occluder overrides it", async ({ page }) => {
  await openSpatial(page);
  await row(page, "bare").click();
  await expect(warnings(page)).toHaveCount(1);
  await expect(warnings(page).first()).toHaveAttribute("data-warning", "noCollider");
  await expect(occluder(page)).toContainText("Applies to no colliders.");

  // `Outer` has no collider of its own and the only one below it belongs to `Inner`'s own occluder.
  await row(page, "outer").click();
  await expect(warnings(page).first()).toBeVisible();
  const codes = await warnings(page).evaluateAll((els) => els.map((e) => e.getAttribute("data-warning")));
  expect(codes).toContain("overlap");
  await expect(occluder(page)).toContainText("Inner");

  await row(page, "inner").click();
  await expect(warnings(page)).toHaveCount(0);
});

test("the Openness slider writes the field, undoably", async ({ page }) => {
  await openSpatial(page);
  await row(page, "wall").click();
  const slider = occluder(page).getByRole("slider", { name: "Openness" });
  await expect(slider).toHaveValue("0");
  await slider.fill("0.6");
  await expect.poll(async () => Number(await slider.inputValue())).toBeCloseTo(0.6, 2);
  await expect(occluder(page)).toContainText("Now:");
  await expect(card(page, "AudioOccluder").getByRole("textbox", { name: "openness", exact: true })).toHaveValue("0.6");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(slider).toHaveValue("0");
});
