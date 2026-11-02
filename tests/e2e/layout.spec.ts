import { expect, test, type Locator, type Page } from "@playwright/test";

const EDITOR = "http://localhost:4174/editor.html";

declare global {
  interface Window {
    engine?: { world: { time: { frameCount: number } } };
  }
}

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });
/** The dock group (panel container) showing `name`. */
const group = (page: Page, name: string) => page.locator(".dock-group", { has: tab(page, name) });
const box = async (l: Locator) => (await l.boundingBox())!;

/** Press on a panel's header, move to (x, y) in steps, and optionally release. */
async function dragTab(page: Page, name: string, x: number, y: number, release = true): Promise<void> {
  const t = await box(tab(page, name));
  await page.mouse.move(t.x + 20, t.y + t.height / 2);
  await page.mouse.down();
  await page.mouse.move(t.x + 40, t.y + 30, { steps: 3 });
  await page.mouse.move(x, y, { steps: 8 });
  if (release) await page.mouse.up();
}

test("dragging a panel to the window's outer edge docks it there at full height, with a preview first", async ({ page }) => {
  await openEditor(page);
  const area = await box(page.locator(".dock-layout"));
  await dragTab(page, "Inspector", area.x + 4, area.y + area.height / 2, false);
  const preview = await box(page.locator(".drop-preview"));
  expect(preview.x).toBeCloseTo(area.x, 0);
  expect(preview.height).toBeCloseTo(area.height, 0);
  await page.mouse.up();
  await expect(page.locator(".drop-preview")).toHaveCount(0);

  const inspector = await box(group(page, "Inspector"));
  expect(inspector.x).toBeCloseTo(area.x, 0);
  expect(inspector.height).toBeCloseTo(area.height, 0); // claims the full height, past Assets
  const hierarchy = await box(group(page, "Hierarchy"));
  expect(hierarchy.x).toBeGreaterThanOrEqual(inspector.x + inspector.width - 1);
  await expect(page.locator("#viewport canvas")).toBeVisible(); // the engine's canvas survived
});

test("dropping a panel where it already is changes nothing", async ({ page }) => {
  await openEditor(page);
  const before = await box(group(page, "Hierarchy")); // alone in its group and dock
  await dragTab(page, "Hierarchy", before.x + before.width / 2, before.y + before.height / 2, false);
  await expect(page.locator(".dock-layout.invalid")).toHaveCount(1);
  await expect(page.locator(".drop-preview")).toHaveCount(0);
  await page.mouse.up();
  expect(await box(group(page, "Hierarchy"))).toEqual(before);
});

test("the scene view is a panel: it moves like the others and keeps its canvas", async ({ page }) => {
  await openEditor(page);
  const assets = await box(tab(page, "Assets"));
  await dragTab(page, "Scene", assets.x + assets.width / 2, assets.y + assets.height / 2);
  await expect(tab(page, "Scene")).toHaveAttribute("aria-selected", "true");
  const scene = await box(group(page, "Scene"));
  expect(scene).toEqual(await box(group(page, "Assets"))); // the same group, at the bottom
  await expect(page.locator(".panel.scene #viewport canvas")).toBeVisible();
  // The Inspector's dock, innermost now, fills the middle.
  const inspector = await box(group(page, "Inspector"));
  const hierarchy = await box(group(page, "Hierarchy"));
  expect(inspector.x).toBeCloseTo(hierarchy.x + hierarchy.width, 0);

  // Showing another tab hides it; showing it again brings the same canvas back.
  await tab(page, "Assets").click();
  await expect(page.locator("#viewport")).toHaveCount(0);
  await tab(page, "Scene").click();
  await expect(page.locator(".panel.scene #viewport canvas")).toBeVisible();
});

test("dropping a panel inside the scene's dock splits it", async ({ page }) => {
  await openEditor(page);
  const scene = await box(group(page, "Scene"));
  await dragTab(page, "Code", scene.x + scene.width / 2, scene.y + scene.height * 0.8);
  const below = await box(group(page, "Code"));
  const sceneNow = await box(group(page, "Scene"));
  expect(below.y).toBeGreaterThan(sceneNow.y);
  expect(below.x).toBeCloseTo(sceneNow.x, 0);
  await expect(page.locator(".panel.scene #viewport canvas")).toBeVisible();
});

test("dropping on another panel's header makes tabs; clicking a tab shows it", async ({ page }) => {
  await openEditor(page);
  const header = await box(tab(page, "Hierarchy"));
  await dragTab(page, "Inspector", header.x + header.width - 20, header.y + header.height / 2);
  await expect(tab(page, "Inspector")).toHaveAttribute("aria-selected", "true");
  await expect(group(page, "Hierarchy")).toHaveCount(1);
  expect(await group(page, "Inspector").count()).toBe(1);
  await expect(page.locator(".panel.inspector")).toBeVisible();

  await tab(page, "Hierarchy").click();
  await expect(tab(page, "Hierarchy")).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".panel.hierarchy .tree")).toBeVisible();
});

test("dropping inside a dock splits it evenly", async ({ page }) => {
  await openEditor(page);
  const left = await box(group(page, "Hierarchy"));
  await dragTab(page, "Inspector", left.x + left.width / 2, left.y + left.height * 0.8);
  const hierarchy = await box(group(page, "Hierarchy"));
  const inspector = await box(group(page, "Inspector"));
  expect(inspector.y).toBeGreaterThan(hierarchy.y); // below it
  expect(Math.abs(inspector.height - hierarchy.height)).toBeLessThan(2); // equal shares
  expect(inspector.width).toBeCloseTo(hierarchy.width, 0);
});

test("Escape cancels a drag", async ({ page }) => {
  await openEditor(page);
  const before = await box(group(page, "Inspector"));
  const area = await box(page.locator(".dock-layout"));
  await dragTab(page, "Inspector", area.x + 4, area.y + 100, false);
  await page.keyboard.press("Escape");
  await page.mouse.up();
  expect(await box(group(page, "Inspector"))).toEqual(before);
});

test("resizing with a handle is remembered across reloads, and Reset Layout restores the default", async ({ page }) => {
  await openEditor(page);
  const before = await box(group(page, "Hierarchy"));
  const handle = await box(page.getByRole("separator", { name: "Resize left panels" }));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + 80, handle.y + 200, { steps: 5 });
  await page.mouse.up();
  const wider = await box(group(page, "Hierarchy"));
  expect(wider.width).toBeCloseTo(before.width + 80, 0);

  await page.reload();
  await page.waitForFunction(() => (window.engine?.world.time.frameCount ?? 0) > 10);
  expect((await box(group(page, "Hierarchy"))).width).toBeCloseTo(wider.width, 0);

  await page.getByRole("button", { name: "Reset Layout" }).click();
  expect((await box(group(page, "Hierarchy"))).width).toBeCloseTo(before.width, 0);
});
