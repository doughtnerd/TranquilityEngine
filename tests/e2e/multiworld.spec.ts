import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, openTestProject, type Page, play, test } from "./fixtures";

// Play mode with several Worlds (ADR 0032, 0034): the Engine comes from the project's bootstrap,
// the game view tiles the Worlds that render, clicking a tile gives its World input, and a strip
// lists every World (the headless server too) with pause and resume.

test.describe.configure({ timeout: 60_000 }); // several Worlds play at once; each new renderer is seconds of CPU with software GL

type WorldHandle = { name: string; paused: boolean; destroy(): void };
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  playEngine?: { createWorld(config: object): WorldHandle; findWorld(name: string): WorldHandle | null } | null;
  openTestProject(extra: Record<string, string>): Promise<void>;
};

/** The Flappy sample's project.json with a two-player bootstrap: two client Worlds that render and a headless server. */
const PROJECT = JSON.stringify({
  ...JSON.parse(readFileSync(join(process.cwd(), "samples/flappy/project.json"), "utf8")),
  bootstrap: {
    worlds: [
      { name: "P1", tags: ["client"] },
      { name: "P2", tags: ["client"] },
      { name: "Server", tags: ["server"] },
    ],
  },
});

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

/** The engine module the editor shares with project scripts (scriptLoader.ts). */
type Engine = {
  GameObject: { findObjectOfType(type: unknown): Record<string, unknown> | null };
  getComponentClass(id: string): unknown;
};

/** The GameManager state in the default World (P1) of the running game, or null. */
const gameState = (page: Page) =>
  page.evaluate(() => {
    const t = (globalThis as unknown as { __myco?: Engine }).__myco;
    const type = t?.getComponentClass("game.GameManager");
    const manager = type ? t!.GameObject.findObjectOfType(type) : null;
    return manager ? (manager.state as string) : null;
  });

const tile = (page: Page, world: string) => page.locator(`#game-view .game-tile[data-world="${world}"]`);
const paused = (page: Page, world: string) => page.evaluate((w) => (window as unknown as Hooks).playEngine?.findWorld(w)?.paused ?? null, world);

test("Play tiles the rendering Worlds; a click gives a World input; Worlds pause and resume", async ({ page }) => {
  const errors = trackErrors(page);
  await openTestProject(page, { "project.json": PROJECT });
  await expect(page.locator(".tree .row .name", { hasText: /^Bird$/ })).toHaveCount(1);

  await play(page);

  // Two tiles, the main view first, each named and drawing; the server is headless.
  const tiles = page.locator("#game-view .game-tile");
  await expect(tiles).toHaveCount(2);
  await expect(tiles.locator(".game-tile-label")).toHaveText(["P1", "P2"]);
  await expect(page.locator("#game-view canvas")).toHaveCount(2);
  await expect(tile(page, "P1").locator("canvas")).toBeVisible();
  await expect(tile(page, "P2").locator("canvas")).toBeVisible();
  const strip = page.getByRole("toolbar", { name: "Worlds" });
  await expect(strip.locator(".world-name")).toHaveText(["P1", "P2", "Server"]);
  await expect(strip.locator('.world-item[data-world="Server"]')).toContainText("headless");

  // Input starts with the main view's World; clicking the second tile moves it there.
  await expect(tile(page, "P1")).toHaveClass(/has-input/);
  // (A click flaps, which starts Flappy: P1, the default World, stays ready until it gets the click.)
  await expect.poll(() => gameState(page)).toBe("ready");
  await tile(page, "P2").click();
  await expect(tile(page, "P2")).toHaveClass(/has-input/);
  await expect(tile(page, "P1")).not.toHaveClass(/has-input/);
  await page.waitForTimeout(300);
  expect(await gameState(page)).toBe("ready");
  await tile(page, "P1").click();
  await expect(tile(page, "P1")).toHaveClass(/has-input/);
  await expect.poll(() => gameState(page)).toBe("playing");

  // Pause and resume, the headless server included.
  await strip.getByRole("button", { name: "Pause Server" }).click();
  await expect.poll(() => paused(page, "Server")).toBe(true);
  await expect(strip.locator('.world-item[data-world="Server"]')).toContainText("paused");
  await strip.getByRole("button", { name: "Resume Server" }).click();
  await expect.poll(() => paused(page, "Server")).toBe(false);
  await strip.getByRole("button", { name: "Pause P2" }).click();
  await expect.poll(() => paused(page, "P2")).toBe(true);
  await strip.getByRole("button", { name: "Resume P2" }).click();
  await expect.poll(() => paused(page, "P2")).toBe(false);

  // A World made at runtime gets a tile, which goes when the World does.
  await page.evaluate(() => void (window as unknown as Hooks).playEngine!.createWorld({ name: "Late", tags: ["client"] }));
  await expect(tiles).toHaveCount(3);
  await expect(tile(page, "Late").locator(".game-tile-label")).toHaveText("Late");
  await page.evaluate(() => (window as unknown as Hooks).playEngine!.findWorld("Late")!.destroy());
  await expect(tiles).toHaveCount(2);

  // Stop disposes it all and returns to editing.
  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  await expect(page.locator("#game-view canvas")).toHaveCount(0);
  await expect(tiles).toHaveCount(0);
  await expect(page.locator("#viewport canvas")).toBeVisible();
  expect(errors).toEqual([]);
});

/** The same Worlds, with both clients linked to the server over loopback (ADR 0033). */
const LINKED = JSON.stringify({
  ...JSON.parse(PROJECT),
  bootstrap: {
    ...JSON.parse(PROJECT).bootstrap,
    links: [
      { from: "P1", to: "Server", transport: "loopback" },
      { from: "P2", to: "Server", transport: "loopback" },
    ],
  },
});

/** Open connections (`net.Connection` nodes in state open) in a World of the running game. */
const openConnections = (page: Page, world: string) =>
  page.evaluate((name) => {
    type Rows = Iterable<{ connection: { state: number } }>;
    const t = (globalThis as unknown as { __myco?: { Connection: unknown } }).__myco;
    const w = (window as unknown as { playEngine?: { _world(n: string): { _query(terms: unknown[]): Rows } | null } | null }).playEngine?._world(name);
    if (!t || !w) return -1;
    let n = 0;
    for (const row of w._query([t.Connection])) if (row.connection.state === 1) n++;
    return n;
  }, world);

test("Play connects linked Worlds, and Stop and Play again reconnect them", async ({ page }) => {
  const errors = trackErrors(page);
  await openTestProject(page, { "project.json": LINKED });
  await expect(page.locator(".tree .row .name", { hasText: /^Bird$/ })).toHaveCount(1);

  for (let round = 0; round < 2; round++) {
    await play(page);
    await expect.poll(() => openConnections(page, "Server")).toBe(2);
    expect(await openConnections(page, "P1")).toBe(1);
    expect(await openConnections(page, "P2")).toBe(1);
    await page.getByRole("button", { name: /Stop/ }).click();
    await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  }
  expect(errors).toEqual([]);
});
