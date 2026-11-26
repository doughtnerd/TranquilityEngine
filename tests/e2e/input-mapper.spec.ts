import { expect, openEditor, type Page, play, test } from "./fixtures";
import { inLiveWorld } from "./liveWorld";
import { captureView, pixelsNear } from "./viewCapture";

// The UIControlMapper (ADR 0337, docs/wiki/guide/input.md "A rebinding screen") drawn for real: a scene with a UICanvas and
// a UIControlMapper plays in the editor; its rows come from the player's bindings, it draws its panel and cells, and
// a real click on the keyboard cell then a key press rebinds the action, read back through the public `myco` API
// (`InputPlayers.get(0).prompt`, the mapper's `rows`, `rebinding` and `status`).
test.describe.configure({ timeout: 90_000 }); // opening a project compiles its scripts, and Play type-checks them

const ACTIONS = `import { button, defineActions } from "myco";

export const MenuActions = defineActions("game.MenuActions", { jump: button("<Keyboard>/j", "<Gamepad>/buttonSouth") });
`;

/** A camera and a screen canvas holding a control mapper for player 0's jump. */
const SCENE = JSON.stringify({
  format: "myco.scene@4",
  settings: { physics: "2d" },
  nodes: [
    {
      id: "camera",
      name: "Camera",
      components: [
        { type: "engine.Transform", data: { position: [0, 0, -10] } },
        { type: "engine.Camera", data: { projection: "orthographic", orthographicSize: 10, backgroundColor: "#4ec0ca" } },
      ],
    },
    {
      id: "menu",
      name: "Menu",
      components: [
        { type: "engine.UICanvas", data: {} },
        { type: "engine.UIControlMapper", data: { actions: "jump" } },
      ],
    },
  ],
});

type Cell = { label: string; part: string | null; hovered: boolean };
type MapperView = { rows: { label: string; keyboard: Cell | null; gamepad: Cell | null }[]; rebinding: { action: string; device: string } | null; status: string };

/** The playing game's control mapper, read through its public members. */
const mapper = (page: Page): Promise<MapperView | null> =>
  inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    if (!w) return null;
    type LiveCell = { label: string; part: string | null; button: { hovered: boolean } } | null;
    type Live = { rows: { label: string; keyboard: LiveCell; gamepad: LiveCell }[]; rebinding: MapperView["rebinding"]; status: string };
    const m = componentsOf<Live>(w.root, myco.UIControlMapper)[0];
    if (!m) return null;
    const cell = (c: LiveCell) => c && { label: c.label, part: c.part, hovered: c.button.hovered };
    return { rows: m.rows.map((r) => ({ label: r.label, keyboard: cell(r.keyboard), gamepad: cell(r.gamepad) })), rebinding: m.rebinding, status: m.status };
  });

/** Player 0's keyboard prompt for jump, through `InputPlayers` (the public API a game's script uses). */
const jumpPrompt = (page: Page) =>
  inLiveWorld(page, null, (_w, { myco }) => {
    const p = myco.InputPlayers.get(0)?.prompt("jump", "keyboard") as { label: string; controls: string[] } | null | undefined;
    return p ? { label: p.label, controls: [...p.controls] } : null;
  });

test("a UIControlMapper lists its rows, draws them, and rebinds the clicked keyboard cell to the next key", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openEditor(page, { files: { "scripts/menuActions.ts": ACTIONS, "scenes/main.scene.json": SCENE } });
  await play(page);
  const view = page.locator("#game-view canvas").first();

  // One row for jump, with its keyboard and gamepad bindings.
  await expect.poll(async () => (await mapper(page))?.rows.length, { timeout: 15_000 }).toBe(1);
  const before = (await mapper(page))!;
  expect(before.rows[0]).toMatchObject({ label: "Jump", keyboard: { label: "J", part: "control" }, gamepad: { part: "control" } });
  expect(before.rebinding).toBeNull();
  expect(await jumpPrompt(page)).toEqual({ label: "J", controls: ["<Keyboard>/j"] });

  // It draws: the panel's background and its cells' colour (UIControlMapper's defaults) cover part of the view.
  const drawn = async () => {
    const shot = await captureView(view);
    return {
      panel: pixelsNear(shot, [28, 34, 40], 10) > shot.width * shot.height * 0.05, // backgroundColor (0.1, 0.11, 0.13) at 0.96 over the sky
      cells: pixelsNear(shot, [61, 69, 82], 10) > 100, // cellColor (0.24, 0.27, 0.32)
    };
  };
  await expect.poll(drawn).toEqual({ panel: true, cells: true });

  // Find the keyboard cell as the pointer does: move down the view's middle (the keyboard column) until it's hovered.
  const box = (await view.boundingBox())!;
  const x = box.x + box.width / 2;
  let at: number | null = null;
  for (let y = box.y + 4; y < box.y + box.height && at === null; y += 8) {
    await page.mouse.move(x, y);
    await expect.poll(async () => (await mapper(page))?.rows[0].keyboard?.hovered ?? false, { timeout: 400 }).toBe(true).then(
      () => (at = y),
      () => {},
    );
  }
  expect(at, "the keyboard cell is somewhere down the middle of the view").not.toBeNull();

  // Click it: the mapper waits for a key; press K: jump is bound to K.
  await page.mouse.click(x, at!);
  await expect.poll(async () => (await mapper(page))?.rebinding).toEqual({ action: "jump", device: "keyboard" });
  expect((await mapper(page))!.status).toBe("Press a key… (Esc to cancel)");
  await page.keyboard.press("k");
  await expect.poll(async () => (await jumpPrompt(page))?.controls).toEqual(["<Keyboard>/k"]);
  expect(await jumpPrompt(page)).toEqual({ label: "K", controls: ["<Keyboard>/k"] });
  await expect.poll(async () => (await mapper(page))?.rows[0].keyboard?.label).toBe("K");
  const after = (await mapper(page))!;
  expect(after.rebinding).toBeNull();
  expect(after.status).toBe("Jump: K");
  expect(errors).toEqual([]);
});
