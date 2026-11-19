import { expect, test, type Page } from "./fixtures";
import { inLiveWorld } from "./liveWorld";

// A lobby match takes the screen (ADR 0068): in King of Pirates, practice against bots starts a
// match, the Engine hands its main view and input from the paused menu World to the match client
// World (the Engine's view hand-over), and leaving the match hands them back. The match used to be drawn on
// an overlay that wasn't centred like the main canvas (the menu showed beside it), and a click on
// the game view gave input back to the paused menu.
//
// Read through the editor's game view: its main tile names the World with the main view and says
// whether it has input, and the Worlds strip marks paused Worlds. The match starts through the
// public `Lobby` API, as the menu's Practice button does.
const EDITOR = "/editor.html?sample=pirates"; // relative to baseURL (E2E_PORT)

type Hooks = { engine?: { world: { time: { frameCount: number } } } };
type Myco = {
  Lobby: { state: string; me: { host: boolean } | null; createRoom(options: { name: string; public: boolean }): void; start(): void; leaveMatch(): void };
};

const MATCH = "Match 1 Client";
/** A World's frame count, or -1 while it doesn't exist (or hasn't stepped yet). */
const frames = (page: Page, world: string) => inLiveWorld(page, world, (w) => w?.time.frameCount ?? -1);
const lobbyState = (page: Page) => page.evaluate(() => (globalThis as unknown as { __myco?: Myco }).__myco?.Lobby.state ?? null);

test("a lobby match takes the whole game view and input, and gives them back to the menu", { tag: "@slow" }, async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "a 3D sample in software rendering is too slow on WebKit");
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.setViewportSize({ width: 2000, height: 780 }); // wide, as reported: the overlay's offset showed most there
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10, null, { timeout: 120_000 });
  await page.getByRole("button", { name: "▶ Play" }).click();
  await expect.poll(() => frames(page, "Menu"), { timeout: 120_000 }).toBeGreaterThan(10);

  const view = page.locator("#game-view");
  const mainTile = view.locator(".game-tile").first();
  const strip = page.getByRole("toolbar", { name: "Worlds" });
  const item = (world: string) => strip.locator(`.world-item[data-world="${world}"]`);
  await expect(mainTile).toHaveAttribute("data-world", "Menu");
  const menuCanvas = view.locator("canvas").first();
  await expect(menuCanvas).toBeVisible();
  const menuBox = (await menuCanvas.boundingBox())!;

  // Practice against bots, as the menu's button does: a private room, started once we're its host.
  // The calls act on the current World, the menu (the play Engine's default World).
  await expect.poll(() => lobbyState(page), { timeout: 60_000 }).toBe("lobby");
  await page.evaluate(() => (globalThis as unknown as { __myco: Myco }).__myco.Lobby.createRoom({ name: "Practice", public: false }));
  await expect
    .poll(() =>
      page.evaluate(() => {
        const { Lobby } = (globalThis as unknown as { __myco: Myco }).__myco;
        return Lobby.state === "room" && !!Lobby.me?.host;
      }),
    )
    .toBe(true);
  await page.evaluate(() => (globalThis as unknown as { __myco: Myco }).__myco.Lobby.start());
  await expect.poll(() => frames(page, MATCH), { timeout: 120_000 }).toBeGreaterThan(5);

  // The match World has the main view and input, and runs; the menu is paused, and isn't tiled
  // (its surface is hidden, kept for when the view comes back).
  await expect(mainTile).toHaveAttribute("data-world", MATCH);
  await expect(mainTile).toHaveAttribute("aria-label", `World ${MATCH} (has input)`);
  await expect(item(MATCH)).not.toHaveClass(/paused/);
  await expect(item("Menu")).toHaveClass(/paused/);
  await expect(view.locator('.game-tile[data-world="Menu"]')).toHaveCount(0);
  const visible = view.locator("canvas:visible");
  await expect(visible).toHaveCount(1);
  // Laid out where the menu's canvas was: centred in the game view, not at its left edge.
  const matchBox = (await visible.boundingBox())!;
  expect(Math.abs(matchBox.x - menuBox.x)).toBeLessThan(2);
  expect(Math.abs(matchBox.width - menuBox.width)).toBeLessThan(2);
  await expect(view.locator(".game-tile")).toHaveCount(1); // nothing tiled

  // A click on the game view keeps input with the match World, which keeps running.
  await page.mouse.click(matchBox.x + matchBox.width / 2, matchBox.y + matchBox.height / 2);
  await expect(mainTile).toHaveAttribute("data-world", MATCH);
  await expect(mainTile).toHaveAttribute("aria-label", `World ${MATCH} (has input)`);
  await expect(item("Menu")).toHaveClass(/paused/);
  const before = await frames(page, MATCH);
  await expect.poll(() => frames(page, MATCH), { timeout: 30_000 }).toBeGreaterThan(before + 3);

  // Leaving the match hands the view and input back to the menu, which resumes.
  await page.evaluate(() => (globalThis as unknown as { __myco: Myco }).__myco.Lobby.leaveMatch());
  await expect(item(MATCH)).toHaveCount(0);
  await expect(mainTile).toHaveAttribute("data-world", "Menu");
  await expect(mainTile).toHaveAttribute("aria-label", "World Menu (has input)");
  await expect(item("Menu")).not.toHaveClass(/paused/);
  await expect(visible).toHaveCount(1);
  expect(errors).toEqual([]);
});
