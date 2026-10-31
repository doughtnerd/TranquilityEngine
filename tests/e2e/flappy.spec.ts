import { expect, test, type Page } from "@playwright/test";

/** Mirrors `FlappyState` in src/demo/flappy/main.ts (kept separate so tests don't compile the game). */
interface FlappyState {
  frame: number;
  state: "ready" | "playing" | "dead" | null;
  score: number;
  best: number;
  birdY: number | null;
}

declare global {
  interface Window {
    flappy?: { state(): FlappyState };
  }
}

const state = (page: Page) => page.evaluate(() => window.flappy!.state());

/** Wait until `predicate` holds for the game state (evaluated in the page). */
async function waitForState(page: Page, predicate: string, timeout = 10_000): Promise<FlappyState> {
  await page.waitForFunction(`(() => { const s = window.flappy?.state(); return !!s && (${predicate}); })()`, null, { timeout });
  return state(page);
}

/** Collect uncaught exceptions and console errors for the whole test. */
function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

test("boots and runs frames without errors", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  const s = await waitForState(page, "s.frame > 120");
  expect(s.state).toBe("ready");
  expect(s.birdY).not.toBeNull();
  expect(errors).toEqual([]);
});

test("renders the scene", async ({ page }) => {
  await page.goto("/");
  await waitForState(page, "s.frame > 30");
  // Read the canvas back in a frame callback queued after the engine's, while the
  // WebGL drawing buffer still holds this frame. A blank or failed render has 1–2 colors.
  const colors = await page.evaluate(
    () =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => {
          const source = document.querySelector<HTMLCanvasElement>("#game canvas")!;
          const sample = document.createElement("canvas");
          sample.width = sample.height = 64;
          const ctx = sample.getContext("2d")!;
          ctx.drawImage(source, 0, 0, 64, 64);
          const data = ctx.getImageData(0, 0, 64, 64).data;
          const seen = new Set<number>();
          for (let i = 0; i < data.length; i += 4) seen.add(((data[i] >> 4) << 8) | ((data[i + 1] >> 4) << 4) | (data[i + 2] >> 4));
          resolve(seen.size);
        }),
      ),
  );
  expect(colors).toBeGreaterThan(8);
});

test("flap starts the game, falling ends it, flap restarts", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto("/");
  await waitForState(page, "s.frame > 30");
  const canvas = page.locator("#game canvas");

  await canvas.click();
  const start = await waitForState(page, "s.state === 'playing'");
  // The flap launches the bird upward before gravity wins.
  await waitForState(page, `s.birdY > ${start.birdY! + 0.2}`, 2_000);

  // No more input: the bird falls to the ground and dies.
  const dead = await waitForState(page, "s.state === 'dead'");
  expect(dead.score).toBe(0);

  // Restart is allowed after a short delay; keep flapping until the scene reloads.
  await expect(async () => {
    await canvas.click();
    expect((await state(page)).state).toBe("ready");
  }).toPass({ timeout: 5_000 });
  expect(errors).toEqual([]);
});
