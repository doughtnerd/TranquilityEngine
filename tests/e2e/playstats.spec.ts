import { expect, type Page, play, test, openEditor, type Hooks } from "./fixtures";
import { captureView, pixelsChanged, steadyView, type ViewCapture } from "./viewCapture";

// Play mode's play bar tools: the Stats overlay (frame rate, timings, render counters, nodes) and
// the Gizmos toggle, which hides the editor's drawing on the play Worlds (overlays and the live
// selection outline). What the game view draws is read from captures of it (viewCapture.ts); which
// overlays each setting shows is unit-tested in src/editor/playStats.test.ts.

// Play type-checks the scripts first (ADR 0125); in a full WebKit run (CPU rendering) that alone can take 20 s.
test.describe.configure({ timeout: 60_000 });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

const gameView = (page: Page) => page.locator("#game-view canvas").first();
/**
 * The game view after two steps of the paused game (a paused game isn't drawn again; the editor's drawing follows a
 * change a frame later). Once the bird has fallen (game over) nothing in the game moves, so only the editor's drawing
 * changes between frames.
 */
async function stepped(page: Page): Promise<ViewCapture> {
  const step = page.getByRole("button", { name: "Step", exact: true });
  await step.click();
  await step.click();
  return captureView(gameView(page));
}
/** The selection outline round the bird changes at least this many pixels of the game view. */
const OUTLINE = 100;

test.beforeEach(async ({ page }) => {
  // Start from the defaults: Gizmos on, Stats off.
  await page.addInitScript(() => {
    localStorage.removeItem("myco.editor.playGizmos");
    localStorage.removeItem("myco.editor.playStats");
  });
});

test("Stats shows frame rate, timings and render counters over the play view", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "flappy" });
  await page.getByRole("button", { name: "Play", exact: true }).click();
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
  await page.getByRole("button", { name: "Play", exact: true }).click();
  await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();
  expect(errors).toEqual([]);
});

test("Gizmos off hides every gizmo and debug drawing in the play view; the menu lists the kinds", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { sample: "flappy" });
  await play(page);
  // A tap starts the game; untouched, the bird falls and the game is over, and the view holds still.
  await gameView(page).click();
  await steadyView(gameView(page), { tolerance: 0 });

  // Something to hide: the live selection outline around the bird (World picker, live Hierarchy).
  const hierarchy = page.locator(".panel.hierarchy");
  const worldName = await page.evaluate(() => (window as unknown as Hooks).playEngine!.world.name);
  await hierarchy.getByRole("combobox", { name: "Inspect World" }).selectOption(worldName);
  await hierarchy.getByRole("tree", { name: "Live nodes" }).locator('.row[data-name="Bird"]').click();
  await page.getByRole("button", { name: "Pause", exact: true }).click();
  const outlined = await stepped(page);

  const gizmos = page.locator(".play-tools").getByRole("button", { name: "Gizmos", exact: true });
  await expect(gizmos).toHaveAttribute("aria-pressed", "true");
  await gizmos.click();
  await expect(gizmos).toHaveAttribute("aria-pressed", "false");
  const hidden = await stepped(page);
  expect(pixelsChanged(outlined, hidden), "the outline goes").toBeGreaterThan(OUTLINE);

  // The menu lists the kinds that exist in play; a kind unticked stays hidden with Gizmos on again.
  await page.getByRole("button", { name: "Gizmo kinds" }).click();
  const menu = page.getByRole("dialog", { name: "Gizmo kinds" });
  await expect(menu.getByRole("checkbox")).toHaveCount(3);
  await expect(menu.getByRole("checkbox", { name: "Navigation" })).toBeChecked();
  await menu.getByRole("checkbox", { name: "Selection outline" }).uncheck();
  await page.keyboard.press("Escape");
  await gizmos.click();
  await expect(gizmos).toHaveAttribute("aria-pressed", "true");
  expect(pixelsChanged(hidden, await stepped(page)), "the outline stays hidden").toBeLessThan(20);

  // Ticking it again brings the outline back.
  await page.getByRole("button", { name: "Gizmo kinds" }).click();
  await menu.getByRole("checkbox", { name: "Selection outline" }).check();
  await page.keyboard.press("Escape");
  expect(pixelsChanged(hidden, await stepped(page)), "the outline is back").toBeGreaterThan(OUTLINE);
  expect(errors).toEqual([]);
});
