import { expect, test, type Page } from "@playwright/test";

// Play mode's play bar tools: the Stats overlay (frame rate, timings, render counters, nodes) and
// the Gizmos toggle, which hides the editor's drawing on the play Worlds (overlays and the live
// selection outline). Read through `window.playEditorDrawing()` (src/editor/playGizmos.ts).
const FLAPPY = "/editor.html?sample=flappy"; // relative to baseURL (E2E_PORT)

type Drawing = { world: string; overlays: string[]; drawn: { segments: number; handles: number; outlines: number } | null };
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  playEngine?: { world: { name: string } } | null;
  playEditorDrawing?: () => Drawing[];
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

const drawing = (page: Page) => page.evaluate(() => (window as unknown as Hooks).playEditorDrawing?.() ?? []);
const drawnTotal = async (page: Page) =>
  (await drawing(page)).reduce((n, d) => n + (d.drawn ? d.drawn.segments + d.drawn.handles + d.drawn.outlines : 0), 0);

test.beforeEach(async ({ page }) => {
  // Start from the defaults: Gizmos on, Stats off.
  await page.addInitScript(() => {
    localStorage.removeItem("myco.editor.playGizmos");
    localStorage.removeItem("myco.editor.playStats");
  });
});

test("Stats shows frame rate, timings and render counters over the play view", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(FLAPPY);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.getByRole("button", { name: "▶ Play" }).click();
  // Play starts once the scripts are checked ("Checking scripts…"), which takes longer while other tests load the CPU.
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: 20_000 });

  const statsToggle = page.locator(".play-tools").getByRole("button", { name: "Stats", exact: true });
  await expect(statsToggle).toHaveAttribute("aria-pressed", "false");
  await expect(page.locator(".play-stats")).toHaveCount(0);
  await statsToggle.click();
  await expect(statsToggle).toHaveAttribute("aria-pressed", "true");

  const stats = page.getByRole("region", { name: "Stats" });
  await expect(stats).toBeVisible();
  await expect.poll(async () => Number(await stats.locator('[data-stat="fps"]').textContent())).toBeGreaterThan(0);
  await expect(stats.locator('[data-stat="fps-range"]')).toContainText(/min \d+ · avg \d+/);
  await expect(stats.locator('[data-stat="frame-ms"]')).toContainText(/\d+\.\d ms/);
  await expect.poll(async () => Number((await stats.locator('[data-stat="draw-calls"]').first().textContent())?.replace(/\D/g, ""))).toBeGreaterThan(0);
  await expect(stats.locator('[data-stat="gpu"]').first()).toContainText(/geo \d+ · tex \d+ · prog [1-9]\d*/);
  await expect.poll(async () => Number((await stats.locator('[data-stat="nodes"]').first().textContent())?.replace(/\D/g, ""))).toBeGreaterThan(0);
  await expect(stats.locator('[data-stat="update-ms"]').first()).toContainText(/\d+\.\d\d ms/);
  // Chromium reports the JS heap; WebKit doesn't.
  await expect(stats.locator('[data-stat="heap"]')).toHaveText(/MB|n\/a/);

  // The overlay doesn't take the game's clicks; its close button hides it (and the toggle follows).
  await expect(stats).toHaveCSS("pointer-events", "none");
  await stats.getByRole("button", { name: "Close stats" }).click();
  await expect(page.locator(".play-stats")).toHaveCount(0);
  await expect(statsToggle).toHaveAttribute("aria-pressed", "false");

  // Remembered: on again, it shows in the next session too.
  await statsToggle.click();
  await page.getByRole("button", { name: /Stop/ }).click();
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Gizmos off hides every gizmo and debug drawing in the play view; the menu lists the kinds", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(FLAPPY);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible();

  // Something to hide: the live selection outline around the bird (World picker, live Hierarchy).
  const hierarchy = page.locator(".panel.hierarchy");
  const worldName = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await hierarchy.getByRole("combobox", { name: "Inspect World" }).selectOption(worldName);
  await hierarchy.getByRole("tree", { name: "Live nodes" }).locator('.row[data-name="Bird"]').click();
  await expect.poll(() => drawnTotal(page)).toBeGreaterThan(0);

  const gizmos = page.locator(".play-tools").getByRole("button", { name: "Gizmos", exact: true });
  await expect(gizmos).toHaveAttribute("aria-pressed", "true");
  await gizmos.click();
  await expect(gizmos).toHaveAttribute("aria-pressed", "false");
  await expect.poll(() => drawnTotal(page)).toBe(0);
  for (const d of await drawing(page)) expect(d.overlays).toEqual([]);

  // The menu lists the kinds that exist in play; a kind unticked stays hidden with Gizmos on again.
  await page.getByRole("button", { name: "Gizmo kinds" }).click();
  const menu = page.getByRole("dialog", { name: "Gizmo kinds" });
  await expect(menu.getByRole("checkbox")).toHaveCount(3);
  await expect(menu.getByRole("checkbox", { name: "Navigation" })).toBeChecked();
  await menu.getByRole("checkbox", { name: "Selection outline" }).uncheck();
  await page.keyboard.press("Escape");
  await gizmos.click();
  await expect(gizmos).toHaveAttribute("aria-pressed", "true");
  await page.waitForTimeout(300);
  expect((await drawing(page)).reduce((n, d) => n + (d.drawn?.outlines ?? 0), 0)).toBe(0);

  // Ticking it again brings the outline back.
  await page.getByRole("button", { name: "Gizmo kinds" }).click();
  await menu.getByRole("checkbox", { name: "Selection outline" }).check();
  await expect.poll(async () => (await drawing(page)).reduce((n, d) => n + (d.drawn?.outlines ?? 0), 0)).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});
