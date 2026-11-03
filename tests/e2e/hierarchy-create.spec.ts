import { expect, test, type Locator, type Page } from "@playwright/test";

const EDITOR = "/editor.html?sample=flappy"; // opens the Flappy sample (ADR 0031); relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  orbit: { focus(point?: [number, number, number], distance?: number): void };
  nodeRect(key: string): { left: number; top: number; right: number; bottom: number } | null;
};

async function openEditor(page: Page): Promise<void> {
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
}

const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const selected = (page: Page) => page.locator(".tree .row.selected").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.key!));
const rowKeys = (page: Page) => page.locator(".tree .row").evaluateAll((rows) => rows.map((r) => (r as HTMLElement).dataset.key!));
/** A Hierarchy menu item by its label (without the shortcut shown beside it). */
const menuItem = (page: Page, name: string) =>
  page.locator(".hierarchy-menu [role=menuitem]").filter({ has: page.locator("span:first-child", { hasText: new RegExp(`^${name}$`) }) });
const box = async (l: Locator) => (await l.boundingBox())!;

test("the + menu and the row menu create nodes, selected, one undo step each", async ({ page }) => {
  await openEditor(page);
  await page.getByRole("button", { name: "Create node" }).click();
  await menuItem(page, "Create Sprite").click();
  await expect(row(page, "sprite")).toHaveClass(/selected/);
  await expect(row(page, "sprite").locator(".name")).toHaveText("Sprite");
  await expect(page.locator(".scene-name")).toContainText("•");

  await page.getByRole("button", { name: "Create node" }).click();
  await menuItem(page, "Create Camera").click();
  await expect(row(page, "camera-2").locator(".name")).toHaveText("Camera (1)"); // the scene has a Camera already

  await row(page, "bird").click({ button: "right" });
  await menuItem(page, "Create Empty Child").click();
  await expect(row(page, "node")).toHaveClass(/selected/);
  expect(await row(page, "node").evaluate((el) => parseFloat((el as HTMLElement).style.paddingLeft))).toBeGreaterThan(
    await row(page, "bird").evaluate((el) => parseFloat((el as HTMLElement).style.paddingLeft)),
  );

  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "node")).toHaveCount(0);
  await expect(row(page, "camera-2")).toHaveCount(1);
});

test("copy, paste, duplicate and cut nodes with the keyboard and the menu", async ({ page }) => {
  await openEditor(page);
  await row(page, "bird").click();
  await page.keyboard.press("ControlOrMeta+c");
  await page.keyboard.press("ControlOrMeta+v");
  await expect(row(page, "bird-2").locator(".name")).toHaveText("Bird (1)");
  expect(await selected(page)).toEqual(["bird-2"]);
  const keys = await rowKeys(page);
  expect(keys.indexOf("bird-2")).toBeGreaterThan(keys.indexOf("bird-sprite")); // right after Bird and its child
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "bird-2")).toHaveCount(0);

  // Duplicate a multi-selection: one step, the copies selected.
  await row(page, "ceiling").click();
  await row(page, "ground-collider").click({ modifiers: ["ControlOrMeta"] });
  await page.keyboard.press("ControlOrMeta+d");
  expect((await selected(page)).sort()).toEqual(["ceiling-2", "ground-collider-2"]);
  await page.keyboard.press("ControlOrMeta+z");
  await expect(row(page, "ceiling-2")).toHaveCount(0);
  await expect(row(page, "ground-collider-2")).toHaveCount(0);

  // Cut, then Paste as Child from the row menu.
  await row(page, "ceiling").click();
  await page.keyboard.press("ControlOrMeta+x");
  await expect(row(page, "ceiling")).toHaveCount(0);
  await row(page, "bird").click({ button: "right" });
  await menuItem(page, "Paste as Child").click();
  await expect(row(page, "ceiling")).toHaveClass(/selected/);
  expect(await row(page, "ceiling").evaluate((el) => parseFloat((el as HTMLElement).style.paddingLeft))).toBeGreaterThan(4);
});

test("prefab instances copy with their overrides", async ({ page }) => {
  await openEditor(page);
  await row(page, "bg-b").click({ button: "right" });
  await menuItem(page, "Duplicate").click();
  await expect(row(page, "bg-b-2")).toHaveClass(/selected/);
  await expect(row(page, "bg-b-2").locator(".badge")).toContainText("background");
  await expect(page.getByRole("textbox", { name: "position x" })).toHaveValue("32");
});

test("the search box filters rows by name and t:Type, keeping ancestors; Escape clears", async ({ page }) => {
  await openEditor(page);
  const search = page.getByRole("searchbox", { name: "Search nodes" });
  await search.fill("sprite");
  await expect(row(page, "bird-sprite")).toBeVisible();
  await expect(row(page, "bird")).toHaveClass(/filter-context/); // shown as the match's parent
  await expect(row(page, "ceiling")).toHaveCount(0);
  await search.fill("t:camera");
  expect(await rowKeys(page)).toEqual(["camera"]);
  await search.fill("zzz");
  await expect(page.locator(".hierarchy-no-match")).toBeVisible();
  await search.press("Escape");
  await expect(search).toHaveValue("");
  await expect(row(page, "ceiling")).toHaveCount(1);
});

test("dragging several selected rows moves them all in one undo step", async ({ page }) => {
  await openEditor(page);
  await row(page, "ceiling").click();
  await row(page, "ground-collider").click({ modifiers: ["ControlOrMeta"] });
  const a = await box(row(page, "ceiling"));
  const b = await box(row(page, "bird"));
  await page.mouse.move(a.x + 40, a.y + a.height / 2);
  await page.mouse.down();
  await page.mouse.move(a.x + 50, a.y + a.height / 2 + 10, { steps: 3 });
  await page.mouse.move(b.x + 40, b.y + b.height / 2, { steps: 8 });
  await expect(page.locator(".asset-drag-ghost")).toHaveText("Move 2 nodes into Bird");
  await page.mouse.up();
  const indent = (key: string) => row(page, key).evaluate((el) => parseFloat((el as HTMLElement).style.paddingLeft));
  expect(await indent("ceiling")).toBeGreaterThan(await indent("bird"));
  expect(await indent("ground-collider")).toBeGreaterThan(await indent("bird"));
  expect((await selected(page)).sort()).toEqual(["ceiling", "ground-collider"]);
  await page.keyboard.press("ControlOrMeta+z");
  expect(await indent("ceiling")).toBe(await indent("bird"));
  expect(await indent("ground-collider")).toBe(await indent("bird"));
});

test("hidden nodes don't draw in the Scene view and locked ones can't be picked; both are remembered", async ({ page }) => {
  await openEditor(page);
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([0, 0, 0], 14));
  await page.waitForTimeout(100);
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).nodeRect("bird-sprite"))).not.toBeNull();

  // Lock Bird: clicking its sprite in the viewport no longer selects it (or its child).
  await row(page, "bird").hover();
  await page.getByRole("button", { name: "Lock Bird" }).click();
  await expect(row(page, "bird-sprite")).toHaveClass(/scene-locked/); // children inherit
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const r = (await page.evaluate(() => (window as unknown as Hooks).nodeRect("bird-sprite")))!;
  await row(page, "camera").click();
  await page.mouse.click(canvas.x + (r.left + r.right) / 2, canvas.y + (r.top + r.bottom) / 2);
  expect(await selected(page)).not.toContain("bird");
  // Still selectable in the hierarchy.
  await row(page, "bird").click();
  expect(await selected(page)).toEqual(["bird"]);

  // Hide Bird: its sprite isn't drawn; the document (and so the game) is untouched.
  await page.getByRole("button", { name: "Hide Bird" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).nodeRect("bird-sprite"))).toBeNull();
  await expect(page.locator(".scene-name")).not.toContainText("•");

  // Remembered per user across reloads.
  await openEditor(page);
  await expect(page.getByRole("button", { name: "Show Bird" })).toHaveAttribute("aria-pressed", "true");
  await expect(page.getByRole("button", { name: "Unlock Bird" })).toHaveAttribute("aria-pressed", "true");
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).nodeRect("bird-sprite"))).toBeNull();
  await page.getByRole("button", { name: "Show Bird" }).click();
  await expect.poll(() => page.evaluate(() => (window as unknown as Hooks).nodeRect("bird-sprite"))).not.toBeNull();
});
