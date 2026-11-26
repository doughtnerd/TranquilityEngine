import { expect, openEditor, type Page, play, test } from "./fixtures";
import { inLiveWorld } from "./liveWorld";
import { captureView, pixelsNear, type ViewCapture } from "./viewCapture";

// Keyboard focus navigation of game UI (ADR 0340, docs/wiki/guide/ui.md "Keyboard and gamepad navigation"), played for real: a
// UI document's screen canvas with `auto-focus` and four buttons in a 2×2 grid (game UI comes only from documents, ADR 0417). The arrow keys move focus spatially, Tab and Shift+Tab in
// tree order, Enter clicks the focused button and Escape cancels on the canvas, all read through the public `myco` API
// (`UIButton.focused`, `UICanvas`, `InputPlayers`) and a script that counts clicks and cancels. While a button has focus,
// the arrows are the UI's: a game action bound to them doesn't see them. The focused button is drawn in its `focusColor`.
test.describe.configure({ timeout: 90_000 }); // opening a project compiles its scripts, and Play type-checks them

/** A game action on the right arrow, which focused UI takes for itself. */
const ACTIONS = `import { button, defineActions } from "myco";

export const NavActions = defineActions("game.NavActions", { right: button("<Keyboard>/arrowright") });
`;

/** Counts the grid's clicks and the canvas's cancels, and shows them in the #status text (what the spec reads). */
const PROBE = `import { GameBehavior, UIButton, UICanvas, UIDocument, UIText, behavior } from "myco";

@behavior("game.MenuProbe")
export class MenuProbe extends GameBehavior {
  private readonly clicks: Record<string, number> = { a: 0, b: 0, c: 0, d: 0 };
  private cancels = 0;

  update(): void {
    const ui = this.gameObject.getComponent(UIDocument);
    if (!ui?.root) return;
    for (const name of ["a", "b", "c", "d"]) if (ui.query("#" + name)?.as(UIButton).clicked) this.clicks[name]++;
    if (ui.root.as(UICanvas).canceled) this.cancels++;
    const text = ui.query("#status")?.as(UIText);
    if (text) text.text = \`a\${this.clicks.a} b\${this.clicks.b} c\${this.clicks.c} d\${this.clicks.d} cancel\${this.cancels}\`;
  }
}
`;

/** Magenta: the buttons' focus colour, far from anything else the view draws. */
const FOCUS: [number, number, number] = [255, 0, 255];

const node = (id: string, parent: string | null, components: object[]) => ({ id, name: id, ...(parent ? { parent } : {}), components: [{ type: "engine.Transform", data: {} }, ...components] });

/** A screen canvas: a column holding two rows of two buttons (a b / c d) and a status line. */
const MENU = `<Canvas auto-focus>
  <Style src="menu.ui.css"/>
  <Panel id="screen">
    <Panel class="row"><Button id="a"/><Button id="b"/></Panel>
    <Panel class="row"><Button id="c"/><Button id="d"/></Panel>
    <Text id="status"/>
  </Panel>
</Canvas>`;
const MENU_CSS = `#screen { width: 100%; height: 100%; flex-direction: column; justify-content: center; align-items: center; gap: 60px; }
.row { flex-direction: row; gap: 200px; }
Button { width: 220px; height: 120px; background-color: #333333; focus-color: #ff00ff; }
#status { font-size: 24px; }`;

/** A camera and the menu document, with the probe beside it. */
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
    node("menu", null, [
      { type: "engine.UIDocument", data: { document: "asset:ui/menu.ui.xml" } },
      { type: "game.MenuProbe", data: {} },
    ]),
  ],
});

type MenuState = { focused: string[]; status: string; canvasCanceled: boolean; right: { held: boolean; value: number } | null };

/** Which buttons have focus, the probe's status line, and player 0's `right` action, through the public `myco` API. */
const menuState = (page: Page): Promise<MenuState | null> =>
  inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    if (!w) return null;
    type Button = { focused: boolean; gameObject: { name: string } };
    const buttons = componentsOf<Button>(w.root, myco.UIButton);
    if (buttons.length < 4) return null;
    const status = componentsOf<{ text: string }>(w.root, myco.UIText)[0]?.text ?? "";
    const canvas = componentsOf<{ canceled: boolean }>(w.root, myco.UICanvas)[0];
    const player = myco.InputPlayers.get(0) as { held(a: string): boolean; value(a: string): number } | null;
    return {
      focused: buttons.filter((b) => b.focused).map((b) => b.gameObject.name),
      status,
      canvasCanceled: canvas.canceled,
      right: player ? { held: player.held("right"), value: player.value("right") } : null,
    };
  });

/**
 * Wait until the game has stepped `n` more frames. With the e2e frame cap a frame lasts 100 ms, and a press of a key right
 * after one reads a frame or two later (the snapshot puts a frame that reads the key up between two presses, ADR 0336), so
 * a spec tapping one key again waits for a frame without it first, as a player's taps, many frames apart, always are.
 */
async function frames(page: Page, n = 2): Promise<void> {
  const at = await inLiveWorld(page, null, (w) => w?.time.frameCount ?? 0);
  await expect.poll(() => inLiveWorld(page, null, (w) => w?.time.frameCount ?? 0)).toBeGreaterThanOrEqual(at + n);
}

const focused = async (page: Page) => (await menuState(page))?.focused ?? null;
const status = async (page: Page) => (await menuState(page))?.status ?? null;

/** Where the focus colour is drawn: its pixels' count and centre (as fractions of the view), or null if it isn't. */
function focusPaint(shot: ViewCapture): { n: number; x: number; y: number } | null {
  let n = 0;
  let sx = 0;
  let sy = 0;
  for (let i = 0, p = 0; i < shot.data.length; i += shot.channels, p++) {
    const d = shot.data;
    if (Math.hypot(d[i] - FOCUS[0], d[i + 1] - FOCUS[1], d[i + 2] - FOCUS[2]) >= 40) continue;
    n++;
    sx += p % shot.width;
    sy += Math.floor(p / shot.width);
  }
  return n < 200 ? null : { n, x: sx / n / shot.width, y: sy / n / shot.height };
}

test("arrow keys and Tab move focus between a canvas's buttons, Enter clicks, Escape cancels, and the focused button shows its focus colour", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openEditor(page, { files: { "scripts/navActions.ts": ACTIONS, "scripts/menuProbe.ts": PROBE, "ui/menu.ui.xml": MENU, "ui/menu.ui.css": MENU_CSS, "scenes/main.scene.json": SCENE } });
  await play(page);
  const view = page.locator("#game-view canvas").first();
  // Keys go to the game from the window; take the page's focus off the Stop button (Enter would press it) without a
  // press in the game view, which would take the UI's focus away.
  await view.focus();

  // autoFocus: the canvas's first button has focus as the game starts.
  await expect.poll(() => focused(page), { timeout: 15_000 }).toEqual(["a"]);
  await expect.poll(() => status(page)).toBe("a0 b0 c0 d0 cancel0");
  // The arrows move focus spatially: right to b, down to d, left to c, up to a.
  for (const [key, to] of [["ArrowRight", "b"], ["ArrowDown", "d"], ["ArrowLeft", "c"], ["ArrowUp", "a"]] as const) {
    await page.keyboard.press(key);
    await expect.poll(() => focused(page), { message: `${key} focuses ${to}` }).toEqual([to]);
  }
  // There's nothing left of a: focus stays.
  await page.keyboard.press("ArrowLeft");
  await page.waitForTimeout(300);
  expect(await focused(page)).toEqual(["a"]);

  // Tab goes in tree order, wrapping; Shift+Tab back.
  for (const to of ["b", "c", "d", "a"]) {
    await frames(page);
    await page.keyboard.press("Tab");
    await expect.poll(() => focused(page), { message: `Tab focuses ${to}` }).toEqual([to]);
  }
  // Shift held first, as a player holds it (Shift+Tab inside one frame counts too; the unit tests cover it).
  await page.keyboard.down("Shift");
  for (const to of ["d", "c"]) {
    await frames(page);
    await page.keyboard.press("Tab");
    await expect.poll(() => focused(page), { message: `Shift+Tab focuses ${to}` }).toEqual([to]);
  }
  await page.keyboard.up("Shift");

  // Enter clicks the focused button (once), Escape cancels on its canvas.
  await page.keyboard.press("Enter");
  await expect.poll(() => status(page)).toBe("a0 b0 c1 d0 cancel0");
  await page.keyboard.press("Escape");
  await expect.poll(() => status(page)).toBe("a0 b0 c1 d0 cancel1");
  await expect.poll(async () => (await menuState(page))?.canvasCanceled).toBe(false); // `canceled` lasts one frame
  await frames(page);
  expect(await status(page)).toBe("a0 b0 c1 d0 cancel1"); // counted once
  expect(await focused(page)).toEqual(["c"]);

  // While a button has focus, the right arrow is the UI's: it moves focus, and the game's `right` action never sees it.
  await page.keyboard.down("ArrowRight");
  await expect.poll(() => focused(page)).toEqual(["d"]);
  for (let i = 0; i < 3; i++) {
    expect((await menuState(page))!.right).toEqual({ held: false, value: 0 });
    await page.waitForTimeout(100);
  }
  await page.keyboard.up("ArrowRight");

  // The focus colour is drawn on the focused button (navigation was the last UI input): d, bottom right.
  await expect.poll(async () => focusPaint(await captureView(view)), { timeout: 10_000 }).toMatchObject({ x: expect.any(Number) });
  const atD = focusPaint(await captureView(view))!;
  expect(atD.x).toBeGreaterThan(0.5);
  expect(atD.y).toBeGreaterThan(0.5);
  // Up to b: it moves to the top right.
  await page.keyboard.press("ArrowUp");
  await expect.poll(() => focused(page)).toEqual(["b"]);
  await expect.poll(async () => (focusPaint(await captureView(view))?.y ?? 1) < 0.5).toBe(true);
  const atB = focusPaint(await captureView(view))!;
  expect(atB.x).toBeGreaterThan(0.5);
  expect(Math.abs(atB.n - atD.n) / atD.n).toBeLessThan(0.2); // one button's worth either way
  expect(pixelsNear(await captureView(view), FOCUS, 40)).toBeGreaterThan(200);

  // A script unfocusing it gives the arrows back to the game: holding right now holds the game's action.
  await inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    for (const b of componentsOf<{ focused: boolean }>(w!.root, myco.UIButton)) b.focused = false;
  });
  await expect.poll(() => focused(page)).toEqual([]);
  await page.keyboard.down("ArrowRight");
  await expect.poll(async () => (await menuState(page))?.right).toEqual({ held: true, value: 1 });
  await page.keyboard.up("ArrowRight");
  await expect.poll(async () => (await menuState(page))?.right?.held).toBe(false);
  // The focus colour went with the focus.
  await expect.poll(async () => focusPaint(await captureView(view))).toBeNull();
  expect(await status(page)).toBe("a0 b0 c1 d0 cancel1");
  expect(errors).toEqual([]);
});

/** A pause menu as a UI document: auto-focus on Options, Resume and Quit wrapping round through nav-up and nav-down, a title that can't take focus. */
const PAUSE = `<Canvas auto-focus first-selected="options">
  <Panel width="100%" height="100%" flex-direction="column" justify-content="center" align-items="center" gap="16">
    <Button id="title" focusable="false" width="260" height="50">Paused</Button>
    <Button id="resume" nav-up="quit" width="260" height="50">Resume</Button>
    <Button id="options" width="260" height="50">Options</Button>
    <Button id="quit" nav-down="resume" width="260" height="50">Quit</Button>
    <Text id="log">-</Text>
  </Panel>
</Canvas>`;

/** Logs the document's focus, click and cancel handlers into its #log text (what the spec reads). */
const PAUSE_PROBE = `import { GameBehavior, UIDocument, UIText, behavior } from "myco";

@behavior("game.PauseProbe")
export class PauseProbe extends GameBehavior {
  private readonly lines: string[] = [];

  async start(): Promise<void> {
    const doc = this.gameObject.getComponent(UIDocument)!;
    await doc.ready;
    const write = (line: string) => {
      this.lines.push(line);
      const text = doc.query("#log")?.node.getComponent(UIText);
      if (text) text.text = this.lines.slice(-6).join(", ");
    };
    for (const id of ["resume", "options", "quit"]) doc.query("#" + id)!.on("focus", () => write("focus " + id)).on("click", () => write("click " + id));
    doc.root!.on("cancel", () => write("cancel"));
  }
}
`;

const PAUSE_SCENE = JSON.stringify({
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
    node("pause", null, [
      { type: "engine.UIDocument", data: { document: "asset:ui/pause.ui.xml" } },
      { type: "game.PauseProbe", data: {} },
    ]),
  ],
});

type PauseState = { focused: string[]; log: string };

/** Which of the document's buttons has focus, and its #log text, through `UIDocument.query`. */
const pauseState = (page: Page): Promise<PauseState | null> =>
  inLiveWorld(page, null, (w, { myco, componentsOf }) => {
    if (!w) return null;
    type El = { focused: boolean; node: { getComponent(t: unknown): { text: string } | null } };
    const doc = componentsOf<{ query(s: string): El | null }>(w.root, myco.UIDocument)[0];
    const log = doc?.query("#log")?.node.getComponent(myco.UIText);
    if (!doc || !log) return null;
    return { focused: ["title", "resume", "options", "quit"].filter((id) => doc.query(`#${id}`)?.focused), log: log.text };
  });

test("a UI document's auto-focus, first-selected, nav-up and nav-down, focusable and handlers drive keyboard navigation", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  await openEditor(page, { files: { "ui/pause.ui.xml": PAUSE, "scripts/pauseProbe.ts": PAUSE_PROBE, "scenes/main.scene.json": PAUSE_SCENE } });
  await play(page);
  await page.locator("#game-view canvas").first().focus(); // off the Stop button, without a press in the game

  // auto-focus on first-selected.
  await expect.poll(async () => (await pauseState(page))?.focused, { timeout: 15_000 }).toEqual(["options"]);
  // Down to Quit, then nav-down wraps to Resume; up from Resume, nav-up wraps to Quit; the title never takes focus.
  for (const [key, to] of [["ArrowDown", "quit"], ["ArrowDown", "resume"], ["ArrowUp", "quit"], ["ArrowUp", "options"], ["ArrowUp", "resume"]] as const) {
    await frames(page);
    await page.keyboard.press(key);
    await expect.poll(async () => (await pauseState(page))?.focused, { message: `${key} focuses ${to}` }).toEqual([to]);
  }
  // Enter clicks Resume through its click handler; Escape runs the root's cancel handler.
  await page.keyboard.press("Enter");
  await expect.poll(async () => (await pauseState(page))?.log).toMatch(/focus resume, click resume$/);
  await page.keyboard.press("Escape");
  await expect.poll(async () => (await pauseState(page))?.log).toMatch(/click resume, cancel$/);
  expect((await pauseState(page))!.log).toBe("focus resume, focus quit, focus options, focus resume, click resume, cancel"); // the last six lines
  expect(errors).toEqual([]);
});
