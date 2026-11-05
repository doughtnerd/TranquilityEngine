import { expect, test, type Page } from "@playwright/test";

// A lobby match takes the screen (ADR 0068): in King of Pirates, "Practice against bots" starts a
// match, the Engine hands its main view and input from the paused menu World to the match client
// World (`Engine._handView`), and leaving the match hands them back. The match used to be drawn on
// an overlay that wasn't centred like the main canvas (the menu showed beside it), and a click on
// the game view gave input back to the paused menu.
const EDITOR = "/editor.html?sample=pirates"; // relative to baseURL (E2E_PORT)

type World = { time: { frameCount: number }; _componentsOfType(type: unknown): { node?: { name?: string }; _simulateClick(): void }[] };
type ViewState = { name: string; mainView: boolean; takesInput: boolean; paused: boolean; viewHanded: boolean };
type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  playEngine?: { _world(name: string): World | null; _viewStates(): ViewState[] } | null;
};
type Myco = { UIButton: unknown; Lobby: { leaveMatch(): void; state: string } };

const MATCH = "Match 1 Client";
const frames = (page: Page, world: string) => page.evaluate((w) => (window as unknown as Hooks).playEngine?._world(w)?.time.frameCount ?? -1, world);
const state = (page: Page, world: string) =>
  page.evaluate((w) => (window as unknown as Hooks).playEngine?._viewStates().find((s) => s.name === w) ?? null, world);

test("a lobby match takes the whole game view and input, and gives them back to the menu", async ({ page, browserName }) => {
  test.skip(browserName === "webkit", "a 3D sample in software rendering is too slow on WebKit");
  test.setTimeout(240_000);
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.setViewportSize({ width: 2000, height: 780 }); // wide, as reported: the overlay's offset showed most there
  await page.goto(EDITOR);
  await page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10, null, { timeout: 120_000 });
  await page.getByRole("button", { name: "▶ Play" }).click();
  await page.waitForFunction(() => ((window as unknown as Hooks).playEngine?._world("Menu")?.time.frameCount ?? 0) > 10, null, { timeout: 120_000 });

  const view = page.locator("#game-view");
  const menuCanvas = view.locator("canvas").first();
  await expect(menuCanvas).toBeVisible();
  const menuBox = (await menuCanvas.boundingBox())!;

  // "Practice against bots" (the menu's own button click; layout-independent).
  await page.evaluate(() => {
    const myco = (globalThis as unknown as { __myco: Myco }).__myco;
    const menu = (window as unknown as Hooks).playEngine!._world("Menu")!;
    menu._componentsOfType(myco.UIButton).find((b) => b.node?.name === "Practice")!._simulateClick();
  });
  await expect.poll(() => frames(page, MATCH), { timeout: 120_000 }).toBeGreaterThan(5);

  // The match World has the main view and input; the menu is paused with its surface hidden.
  await expect.poll(() => state(page, MATCH)).toMatchObject({ mainView: true, takesInput: true, paused: false });
  expect(await state(page, "Menu")).toMatchObject({ mainView: false, takesInput: false, paused: true, viewHanded: true });
  const visible = view.locator("canvas:visible");
  await expect(visible).toHaveCount(1);
  // Laid out where the menu's canvas was: centred in the game view, not at its left edge.
  const matchBox = (await visible.boundingBox())!;
  expect(Math.abs(matchBox.x - menuBox.x)).toBeLessThan(2);
  expect(Math.abs(matchBox.width - menuBox.width)).toBeLessThan(2);
  await expect(view.locator(".game-tile")).toHaveCount(1); // nothing tiled

  // A click on the game view keeps input with the match World, which keeps running.
  await page.mouse.click(matchBox.x + matchBox.width / 2, matchBox.y + matchBox.height / 2);
  expect(await state(page, MATCH)).toMatchObject({ takesInput: true });
  expect(await state(page, "Menu")).toMatchObject({ takesInput: false });
  const before = await frames(page, MATCH);
  await expect.poll(() => frames(page, MATCH), { timeout: 30_000 }).toBeGreaterThan(before + 3);

  // Leaving the match hands the view back to the menu, which resumes.
  await page.evaluate(() => (globalThis as unknown as { __myco: Myco }).__myco.Lobby.leaveMatch());
  await expect.poll(() => state(page, MATCH)).toBeNull();
  await expect.poll(() => state(page, "Menu")).toMatchObject({ mainView: true, takesInput: true, paused: false, viewHanded: false });
  await expect(visible).toHaveCount(1);
  expect(errors).toEqual([]);
});
