import { expect, test, type Page } from "@playwright/test";

// The Flappy sample (ADR 0031): listed on the start screen, opened from the files served beside the
// editor with its scripts loaded at runtime, and played through Play mode.
const START = "/editor.html"; // relative to baseURL (E2E_PORT)

/** The engine module the editor shares with project scripts (scriptLoader.ts). */
type Engine = {
  GameObject: { findObjectOfType(type: unknown): Record<string, unknown> | null };
  getComponentClass(id: string): unknown;
};

/** The sample's GameManager state in the running game (null before it exists). */
const gameState = (page: Page) =>
  page.evaluate(() => {
    const t = (globalThis as unknown as { __myco?: Engine }).__myco;
    const type = t?.getComponentClass("game.GameManager");
    const manager = type ? t!.GameObject.findObjectOfType(type) : null;
    return manager ? (manager.state as string) : null;
  });

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

test("the start screen lists the sample; Open loads it read-only with its scripts", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(START);
  const start = page.getByRole("dialog", { name: "Start" });
  const sample = start.locator(".sample", { hasText: "Flappy Bird" });
  await expect(sample).toContainText("A one-button 2D game");
  await sample.getByRole("button", { name: "Open" }).click();
  await expect(start).toHaveCount(0);
  await expect(page.locator(".project-name")).toHaveText("Flappy Bird (sample, read-only)");
  await expect(page.locator(".tree .row .name", { hasText: /^Bird$/ })).toHaveCount(1);
  // The scripts loaded: Bird has its behavior, not a missing-script card.
  await page.locator(".tree .row .name", { hasText: /^Bird$/ }).click();
  await expect(page.locator(".inspector")).toContainText("Bird");
  await expect(page.locator(".inspector .component.missing")).toHaveCount(0);

  await page.getByRole("button", { name: "Close", exact: true }).click();
  await expect(start).toBeVisible();
  expect(errors).toEqual([]);
});

test("Play runs the game: a flap starts it, falling ends it", async ({ page }) => {
  const errors = trackErrors(page);
  await page.goto(`${START}?sample=flappy`);
  await page.waitForFunction(() => ((window as unknown as { engine?: { world: { time: { frameCount: number } } } }).engine?.world.time.frameCount ?? 0) > 10);
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect.poll(() => gameState(page), { timeout: 20_000 }).toBe("ready");

  // The game draws a real picture (a blank or failed render has a color or two).
  const canvas = page.locator("#game-view canvas");
  const colors = await canvas.evaluate(
    (source: HTMLCanvasElement) =>
      new Promise<number>((resolve) =>
        requestAnimationFrame(() => {
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

  await canvas.click();
  await expect.poll(() => gameState(page)).toBe("playing");
  await expect.poll(() => gameState(page), { timeout: 20_000 }).toBe("dead");
  await page.getByRole("button", { name: "■ Stop" }).click();
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  expect(errors).toEqual([]);
});
