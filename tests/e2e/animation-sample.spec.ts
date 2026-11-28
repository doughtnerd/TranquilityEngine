import { expect, openEditor, type Page, play, test } from "./fixtures";
import { captureView, pixelsChanged } from "./viewCapture";

// The Animation sample (samples/animation, ADR 0031, 0370–0373) opens and plays in the editor: its main scene animates
// (the game view keeps changing) with no page errors, and key 2 opens its sprites page, which animates too. What each
// station does is checked headless in src/engine/tests/animationSample.test.ts.

test.describe.configure({ timeout: 120_000 });

const gameView = (page: Page) => page.locator("#game-view canvas").first();

test("the Animation sample plays both its scenes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openEditor(page, { sample: "animation" });
  await play(page);
  const view = gameView(page);
  const moving = async (message: string) => {
    let before = await captureView(view);
    await expect
      .poll(
        async () => {
          const now = await captureView(view);
          const changed = pixelsChanged(before, now);
          before = now;
          return changed;
        },
        { timeout: 30_000, intervals: [300], message },
      )
      .toBeGreaterThan(500);
  };
  await moving("the main scene animates");
  await view.click();
  await page.keyboard.press("2");
  await moving("the sprites page animates");
  expect(errors).toEqual([]);
});
