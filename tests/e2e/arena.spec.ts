import { spawn, type ChildProcess } from "node:child_process";
import { expect, type Page, PLAY_START, test } from "./fixtures";
import { showTab } from "./tabs";

// The Arena sample (T16, ADR 0032/0033): listed on the start screen, played with Play. Its
// bootstrap starts one client World on a menu; Host creates the Server World (a Spawnable World),
// which the bootstrap's link connects the client to over loopback (ADR 0062), P adds a second client World (a second tile), players move with input
// (predicted on their owners), and a hit scores for the shooter on the server, shown on clients.
test.describe.configure({ timeout: 60_000 }); // several Worlds play at once; each new renderer is seconds of CPU with software GL

const START = "/editor.html"; // relative to baseURL (E2E_PORT)

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  playEngine?: { worlds(): { name: string }[] } | null;
};

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  return errors;
}

const worldNames = (page: Page) => page.evaluate(() => (window as unknown as Hooks).playEngine?.worlds().map((w) => w.name) ?? null);

interface PlayerState {
  owner: number;
  x: number;
  y: number;
  mine: boolean;
}

/** The players (prefab ghosts named Player, or the server's players) in a World of the running game. */
const playersIn = (page: Page, world: string) =>
  page.evaluate((name) => {
    type Rep = { node: { name: string; isValid: boolean; transform: { position: { x: number; y: number } } }; ownerId: number; isOwnedLocally: boolean };
    const t = (globalThis as unknown as { __myco?: { Replicated: unknown } }).__myco;
    const w = (window as unknown as { playEngine?: { _world(n: string): { _componentsOfType(type: unknown): Rep[] } | null } | null }).playEngine?._world(name);
    if (!t || !w) return [];
    return w
      ._componentsOfType(t.Replicated)
      .filter((r) => r.node.isValid && r.node.name === "Player")
      .map((r) => ({ owner: r.ownerId, x: r.node.transform.position.x, y: r.node.transform.position.y, mine: r.isOwnedLocally }))
      .sort((a, b) => a.owner - b.owner);
  }, world) as Promise<PlayerState[]>;

/** The scoreboard line a client World shows. */
const scoreboard = (page: Page, world: string) =>
  page.evaluate((name) => {
    type TextC = { node: { name: string }; text: string };
    const t = (globalThis as unknown as { __myco?: { Text: unknown } }).__myco;
    const w = (window as unknown as { playEngine?: { _world(n: string): { _componentsOfType(type: unknown): TextC[] } | null } | null }).playEngine?._world(name);
    return w?._componentsOfType(t!.Text).find((c) => c.node.name === "Scoreboard")?.text ?? null;
  }, world);

/** The x of the player a client World owns. */
const myX = async (page: Page, world: string) => (await playersIn(page, world)).find((p) => p.mine)?.x ?? NaN;

/** How long Play may take to start: it type-checks the scripts first (ADR 0125), loading Monaco's TypeScript worker the first time. */

const tile = (page: Page, world: string) => page.locator(`#game-view .game-tile[data-world="${world}"]`);

test("the start screen lists Arena", async ({ page }) => {
  await page.goto(START);
  const sample = page.getByRole("dialog", { name: "Start" }).locator(".sample", { hasText: "Arena" });
  await expect(sample).toContainText("two-player");
  await sample.getByRole("button", { name: "Open" }).click();
  await expect(page.locator(".project-name")).toHaveText("Arena (sample, read-only)");
  await expect(page.locator(".inspector .component.missing")).toHaveCount(0);
});

test("Play: Host makes the server World, P adds a second player, input moves players, a hit scores", async ({ page }) => {
  test.setTimeout(60_000);
  const errors = trackErrors(page);
  await page.goto(`${START}?sample=arena`);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
  await expect(page.locator(".project-name")).toHaveText("Arena (sample, read-only)");

  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect(page.getByRole("button", { name: /Stop/ })).toBeVisible({ timeout: PLAY_START });
  await expect.poll(() => worldNames(page), { timeout: PLAY_START }).toEqual(["Client"]); // the play Engine's Worlds start after the button shows

  // Host: the Server World is created from its template; the bootstrap's link connects this client, which gets a player.
  await tile(page, "Client").click();
  await page.keyboard.press("h");
  await expect.poll(() => worldNames(page)).toEqual(["Client", "Server"]);
  await expect.poll(async () => (await playersIn(page, "Client")).map((p) => p.mine), { timeout: 15_000 }).toEqual([true]);
  await expect.poll(() => scoreboard(page, "Client")).toBe("▶ P1  0");
  const strip = page.getByRole("toolbar", { name: "Worlds" });
  await expect(strip.locator('.world-item[data-world="Server"]')).toContainText("headless");

  // Add a local player: a second client World, tiled, connected to the same server.
  await page.keyboard.press("p");
  await expect.poll(() => worldNames(page)).toEqual(["Client", "Server", "Client 2"]);
  await expect(page.locator("#game-view .game-tile")).toHaveCount(2);
  await expect.poll(async () => (await playersIn(page, "Server")).length, { timeout: 15_000 }).toBe(2);
  await expect.poll(async () => (await playersIn(page, "Client 2")).map((p) => p.mine), { timeout: 15_000 }).toEqual([false, true]);
  await expect.poll(async () => (await playersIn(page, "Client")).length, { timeout: 15_000 }).toBe(2); // replicated from the server, like the two above

  // Input moves the World's own player: Client has the keyboard, then Client 2 after a click.
  const x1 = await myX(page, "Client");
  await page.keyboard.down("d");
  // A World steps at most maxFrameTime a frame, so when frames come slowly (a loaded machine) the game runs slower than the clock.
  await expect.poll(() => myX(page, "Client"), { timeout: 15_000 }).toBeGreaterThan(x1 + 1);
  await page.keyboard.up("d");
  await tile(page, "Client 2").click();
  await expect(tile(page, "Client 2")).toHaveClass(/has-input/);
  const x2 = await myX(page, "Client 2");
  await page.keyboard.down("a");
  await expect.poll(() => myX(page, "Client 2"), { timeout: 15_000 }).toBeLessThan(x2 - 1);
  await page.keyboard.up("a");
  // The server moved them too, and Client sees Client 2's player (interpolated) where the server has it.
  await expect.poll(async () => (await playersIn(page, "Server"))[1].x).toBeLessThan(x2 - 1);

  // A hit: line the players up on the server (P1 aiming at P2), give Client the keyboard, fire.
  await page.evaluate(() => {
    type Node = { name: string; isValid: boolean; transform: { position: { set(x: number, y: number, z: number): void } } };
    const t = (globalThis as unknown as { __myco: { Replicated: unknown } }).__myco;
    const w = (window as unknown as { playEngine: { _world(n: string): { _componentsOfType(type: unknown): { node: Node; ownerId: number }[] } } }).playEngine._world("Server");
    for (const rep of w._componentsOfType(t.Replicated)) {
      if (rep.node.name !== "Player") continue;
      rep.node.transform.position.set(rep.ownerId === 1 ? -3 : 3, 0, 0);
    }
  });
  await tile(page, "Client").click();
  await expect(tile(page, "Client")).toHaveClass(/has-input/);
  await page.keyboard.down("d"); // a tap aims P1 to the right
  await page.waitForTimeout(50);
  await page.keyboard.up("d");
  await page.keyboard.down("Space");
  await expect.poll(() => scoreboard(page, "Client"), { timeout: 10_000 }).toMatch(/^▶ P1  [1-9]/);
  await page.keyboard.up("Space");
  await expect.poll(() => scoreboard(page, "Client 2")).toMatch(/^P1  [1-9]\d*\s+▶ P2  0$/);

  // The Worlds panel draws the live connections the links made (ADR 0062).
  await showTab(page, /^Worlds/);
  const worldsPanel = page.locator(".panel.worlds");
  await expect(worldsPanel.locator('[data-live-link="Client>Server"]')).toHaveCount(1);
  await expect(worldsPanel.locator('[data-live-link="Client 2>Server"]')).toHaveCount(1);

  await page.getByRole("button", { name: /Stop/ }).click();
  await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
  expect(errors).toEqual([]);
});

/** Run the arena's dedicated server (`npm run server -- samples/arena`) on a free port; resolves with it and its URL. */
function dedicatedServer(log: string[]): Promise<{ process: ChildProcess; url: string }> {
  const child = spawn(process.execPath, ["src/server/cli.mjs", "samples/arena", "--port", "0", "--host", "127.0.0.1"], { cwd: process.cwd() });
  return new Promise((resolve, reject) => {
    // It compiles the engine from source as it loads (tsLoader.mjs): about 20 s on its own, longer beside other tests.
    const timer = setTimeout(() => {
      child.kill();
      reject(new Error(`The dedicated server didn't start:\n${log.join("")}`));
    }, 60_000);
    child.stderr!.on("data", (d: Buffer) => log.push(String(d)));
    child.stdout!.on("data", (d: Buffer) => {
      log.push(String(d));
      const url = /listening on (ws:\/\/\S+?)\.?(\s|$)/.exec(log.join(""))?.[1];
      if (url) {
        clearTimeout(timer);
        resolve({ process: child, url });
      }
    });
    child.on("exit", (code) => reject(new Error(`The dedicated server exited (${code}):\n${log.join("")}`)));
  });
}

test("Play: Join connects to a dedicated server, which spawns a player the keyboard moves", async ({ page }) => {
  test.setTimeout(120_000); // the dedicated server's start-up counts
  const errors = trackErrors(page);
  const log: string[] = [];
  const server = await dedicatedServer(log);
  try {
    await page.goto(`${START}?sample=arena`);
    await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
    await page.getByRole("button", { name: "▶ Play" }).click();
    await expect.poll(() => worldNames(page), { timeout: PLAY_START }).toEqual(["Client"]);
    // Point Join at this server (the scene says ws://localhost:7777, the server's default port).
    await page.evaluate((url) => {
      const t = (globalThis as unknown as { __myco: { getComponentClass(id: string): unknown } }).__myco;
      const w = (window as unknown as { playEngine: { _world(n: string): { _componentsOfType(type: unknown): { serverUrl: string }[] } } }).playEngine._world("Client");
      w._componentsOfType(t.getComponentClass("arena.Menu"))[0].serverUrl = url;
    }, server.url);

    await tile(page, "Client").click();
    await page.keyboard.press("j");
    await expect.poll(async () => (await playersIn(page, "Client")).map((p) => p.mine), { timeout: 15_000 }).toEqual([true]);
    expect(await worldNames(page)).toEqual(["Client"]); // no server World in the page
    await expect.poll(() => scoreboard(page, "Client")).toBe("▶ P1  0");
    await expect.poll(() => log.join("")).toMatch(/World "Server": connection 1 opened/);

    const x = await myX(page, "Client");
    await page.keyboard.down("d");
    await expect.poll(() => myX(page, "Client"), { timeout: 15_000 }).toBeGreaterThan(x + 1);
    await page.keyboard.up("d");

    await page.getByRole("button", { name: /Stop/ }).click();
    await expect(page.getByRole("button", { name: "▶ Play" })).toBeVisible();
    await expect.poll(() => log.join("")).toMatch(/World "Server": connection 1 closed/);
  } finally {
    server.process.kill();
  }
  expect(errors).toEqual([]);
});
