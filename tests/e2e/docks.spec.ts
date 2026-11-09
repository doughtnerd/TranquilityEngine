import { expect, test, type Locator, type Page } from "./fixtures";

// Collapsing docks to their edge, and tabs that don't fit a header going behind "» N" (the
// editor UX pass, docs/plans/2026-11-editor-ux-pass.md items 2 and 3).

const EDITOR = "/editor.html?sample=flappy";

type Hooks = { engine?: { world: { time: { frameCount: number } } } };

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.evaluate(() => localStorage.removeItem("myco.editor.layout")); // the default layout
  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

async function box(locator: Locator) {
  const b = await locator.boundingBox();
  if (!b) throw new Error("no bounding box");
  return b;
}

const tab = (page: Page, name: string) => page.getByRole("tab", { name: new RegExp(`^${name}`) });

test("the Assets dock collapses to its header row from its chevron, and a tab click opens it again", async ({ page }) => {
  await openEditor(page);
  const scene = await box(page.locator(".dock-group", { has: tab(page, "Scene") }));
  await page.getByRole("button", { name: "Collapse Assets dock" }).click();
  const strip = page.locator(".dock-strip.side-bottom");
  await expect(strip).toBeVisible();
  expect((await box(strip)).height).toBeLessThan(40);
  await expect(page.locator(".panel.assets")).toHaveCount(0);
  expect((await box(page.locator(".dock-group", { has: tab(page, "Scene") }))).height).toBeGreaterThan(scene.height + 100); // the scene took the room
  await expect(page.getByRole("button", { name: "Expand Assets dock" })).toHaveAttribute("aria-expanded", "false");

  // Remembered across a reload.
  await page.reload();
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await expect(strip).toBeVisible();

  await tab(page, "Code").click();
  await expect(strip).toHaveCount(0);
  await expect(tab(page, "Code")).toHaveAttribute("aria-selected", "true");
});

test("double-clicking a side dock's border collapses it to a strip with vertical titles, and again expands it", async ({ page }) => {
  await openEditor(page);
  const handle = page.getByRole("separator", { name: "Resize left panels" });
  await handle.dblclick();
  const strip = page.locator(".dock-strip.side-left");
  await expect(strip).toBeVisible();
  expect((await box(strip)).width).toBeLessThan(40);
  await expect(strip.getByRole("tab", { name: /^Hierarchy/ })).toHaveCSS("writing-mode", "vertical-rl");
  await handle.dblclick();
  await expect(strip).toHaveCount(0);
  await expect(page.locator(".panel.hierarchy")).toBeVisible();
});

test("tabs that don't fit go behind a » button; picking one shows it in the header", async ({ page }) => {
  await openEditor(page);
  // Narrow the right dock (Inspector, History, Worlds, Network, Project) until its tabs overflow.
  const handle = await box(page.getByRole("separator", { name: "Resize right panels" }));
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + 60, handle.y + handle.height / 2, { steps: 6 }); // narrow enough to overflow, wide enough for two tabs
  await page.mouse.up();
  const more = page.getByRole("button", { name: "More tabs" });
  await expect(more).toBeVisible();
  await expect(tab(page, "Project")).toHaveCount(0);
  await more.click();
  await page.getByRole("menuitem", { name: "Project" }).click();
  await expect(tab(page, "Project")).toHaveAttribute("aria-selected", "true"); // swapped into view
  await expect(page.getByRole("menu", { name: "Hidden tabs" })).toHaveCount(0);
  await expect(tab(page, "Inspector")).toBeVisible(); // the first tab still shows
});
