import { afterFrames, expect, type Hooks, openEditor, type Page, test } from "./fixtures";
import { node, scene, stage } from "./animationAssets";
import { dockBelow, rulerClick } from "./animationWindows";
import { menu } from "./menus";
import { captureView, pixelsChanged, steadyView } from "./viewCapture";

// The Animation window (ADR 0373, T50 and the edit-mode preview fix D136) on a scene the editor opened: a Mover node
// with an Animator whose default clip slides its child Cube from x -2 (0 s) to x 2 (1 s). Selecting the Cube binds the
// window to the Animator above it; Preview with a scrub moves the Cube in the scene view and turning it off puts it
// back; record mode turns a gizmo drag into keys, one undo step on the clip, with the scene untouched; the Inspector's
// key buttons add and remove keys; a box selection of keys is deleted with Delete; and double-clicking the clip in the
// Assets panel opens it. What the window wrote is read from the saved clip file, what the view shows from captures.

test.describe.configure({ timeout: 90_000 });

const CLIP = "clips/mover.anim.json";
const MOVER = {
  format: "myco.anim-source@1",
  duration: 1,
  tracks: [{ kind: "vec3", target: { nodePath: "Cube", component: "engine.Transform", field: "position" }, curves: [[[0, -2], [1, 2]], [[0, 0]], [[0, 0]]] }],
};
const SCENE = scene([
  ...stage(),
  node("mover", "Mover", [0, 0, 0], [{ type: "engine.Animator", data: { defaultClip: `asset:${CLIP}` } }]),
  node("cube", "Cube", [0, 0.5, 0], [{ type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }], { parent: "mover" }),
]);

type Clip = { tracks: { kind: string; target: { nodePath: string; field: string }; curves?: [number, number][][] }[] };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const sceneCanvas = (page: Page) => page.locator(".panel.scene #viewport canvas");
const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Animation" });
/** The clip file as the editor saved it. */
const savedClip = (page: Page) => page.evaluate((p) => JSON.parse((window as unknown as Hooks).testFolder.read(p) ?? "null"), CLIP) as Promise<Clip>;
const savedScene = (page: Page) => page.evaluate(() => (window as unknown as Hooks).testFolder.read("scenes/main.scene.json") ?? "");
/** Every key time of the clip's tracks, per track and channel. */
const keyTimes = (clip: Clip) => clip.tracks.map((t) => (t.curves ?? []).map((c) => c.map((k) => k[0])));

/** Opens the project in the 2D view framing the Mover, selects the Cube and opens the Animation window from the Window menu. */
async function openWindow(page: Page): Promise<void> {
  await openEditor(page, { files: { [CLIP]: JSON.stringify(MOVER), "scenes/main.scene.json": SCENE } });
  await page.locator(".scene-toolbar").getByRole("button", { name: "2D", exact: true }).click();
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([0, 0.5, 0], 9));
  await page.locator(".tree .row", { has: page.locator(".name", { hasText: /^Cube$/ }) }).first().click();
  await menu(page, "Window", "Animation");
  await expect(toolbar(page)).toBeVisible();
  await dockBelow(page, "Animation");
  await expect(toolbar(page)).toBeVisible();
}

/** Moves the playhead with a click on the ruler at `fraction` of the clip (0 … 1; 0 is the To start button). */
async function scrub(page: Page, fraction: number): Promise<void> {
  if (fraction === 0) return void (await toolbar(page).getByRole("button", { name: "To start" }).click());
  await rulerClick(page, page.locator(".aw-root .ce-ruler"), fraction);
}

test("selecting a node under an Animator binds the window to its clip; Preview scrubs the scene view and stopping puts it back", async ({ page }) => {
  const errors = trackErrors(page);
  await openWindow(page);
  // Bound to the Mover's default clip: the clip picker names it, and the dope sheet has the Cube's position rows.
  await expect(toolbar(page).getByRole("combobox", { name: "Clip" })).toContainText("mover.anim.json");
  await expect(page.locator(".aw-root").getByRole("button", { name: /^position\.x key at 0(\.00)? s/ }).first()).toBeVisible();

  const view = sceneCanvas(page);
  const before = await steadyView(view);
  await toolbar(page).getByRole("button", { name: "Preview", exact: true }).click();
  await scrub(page, 0);
  await expect(page.locator(".aw-time")).toContainText("0.00 s");
  const atStart = await steadyView(view);
  await scrub(page, 1);
  await expect(page.locator(".aw-time")).toContainText("1.00 s");
  await expect.poll(async () => pixelsChanged(atStart, await captureView(view)), { message: "pixels the Cube's move from x -2 to x 2 changes" }).toBeGreaterThan(300);
  expect(pixelsChanged(before, atStart), "the preview at 0 s shows the Cube at x -2, not where the scene has it").toBeGreaterThan(300);

  // Preview off: the Cube is back where the scene holds it, and the scene was never edited.
  await toolbar(page).getByRole("button", { name: "Preview", exact: true }).click();
  await expect.poll(async () => pixelsChanged(before, await captureView(view)), { message: "pixels still off the scene's own view" }).toBeLessThan(60);
  await expect(page.locator(".scene-name")).not.toContainText("•");
  expect(errors).toEqual([]);
});

test("record mode turns a gizmo drag into keys at the playhead: one undo step on the clip, the scene unchanged", async ({ page }) => {
  const errors = trackErrors(page);
  await openWindow(page);
  const sceneBefore = await savedScene(page);
  await toolbar(page).getByRole("button", { name: "● Record" }).click();
  await expect(toolbar(page).getByRole("button", { name: "● Record" })).toHaveAttribute("aria-pressed", "true");
  await scrub(page, 0.5);
  await expect(page.locator(".aw-time")).toContainText("0.50 s");
  await afterFrames(page, 3);

  // Drag the Move gizmo's centre (the free move in the 2D view) from the Cube up and right.
  const canvas = sceneCanvas(page);
  const box = (await canvas.boundingBox())!;
  await page.locator(".scene-toolbar").getByRole("button", { name: "Move", exact: true }).click();
  const r = (await page.evaluate(() => (window as unknown as Hooks).nodeRect("cube")))!;
  const at = { x: box.x + (r.left + r.right) / 2, y: box.y + (r.top + r.bottom) / 2 };
  await afterFrames(page, 4);
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  await page.mouse.move(at.x + 50, at.y - 40, { steps: 6 });
  await page.mouse.up();

  // The clip has keys at 0.5 s now; the scene file and its unsaved mark are as they were.
  await expect.poll(async () => keyTimes(await savedClip(page))[0]![0]).toContain(0.5);
  const recorded = await savedClip(page);
  expect(recorded.tracks[0]!.curves![1]!.map((k) => k[0])).toContain(0.5); // y keyed too: the drag went up
  expect(await savedScene(page)).toBe(sceneBefore);
  await expect(page.locator(".scene-name")).not.toContainText("•");

  // One undo step on the clip takes every key of the drag back.
  await page.locator(".aw-root").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(async () => keyTimes(await savedClip(page))).toEqual([[[0, 1], [0], [0]]]);
  expect(await savedScene(page)).toBe(sceneBefore);
  expect(errors).toEqual([]);
});

test("the Inspector's key buttons add a key at the playhead and remove it again", async ({ page }) => {
  const errors = trackErrors(page);
  await openWindow(page);
  await scrub(page, 0.5);
  await expect(page.locator(".aw-time")).toContainText("0.50 s");
  // The Cube's scale isn't animated: its key button adds a scale track keyed at the playhead.
  const add = page.locator(".inspector").getByRole("button", { name: "Add key: scale" });
  await add.click();
  await expect.poll(async () => (await savedClip(page)).tracks.find((t) => t.target.field === "scale")?.curves?.[0]?.map((k) => k[0]) ?? null).toEqual([0.5]);
  // Keyed now: the same button removes it.
  await page.locator(".inspector").getByRole("button", { name: "Remove key: scale" }).click();
  await expect.poll(async () => (await savedClip(page)).tracks.find((t) => t.target.field === "scale")?.curves?.flat().length ?? 0).toBe(0);
  expect(errors).toEqual([]);
});

test("a box selection of keys is deleted with Delete", async ({ page }) => {
  const errors = trackErrors(page);
  await openWindow(page);
  // Box the keys at 1 s (the right edge of the sheet) on every row.
  await expect(page.locator(".aw-root .ce-dia").last()).toBeVisible();
  const grid = (await page.locator(".aw-root .ce-dope-grid").boundingBox())!;
  const ruler = (await page.locator(".aw-root .ce-ruler").boundingBox())!;
  const right = ruler.x + ruler.width;
  await page.mouse.move(right - ruler.width * 0.2, ruler.y + ruler.height + 4);
  await page.mouse.down();
  await page.mouse.move(right + 6, grid.y + grid.height - 2, { steps: 6 });
  await page.mouse.up();
  await expect(page.locator(".aw-root .ce-dia.on").first()).toBeVisible();
  await page.locator(".aw-root").focus();
  await page.keyboard.press("Delete");
  // Only the 1 s key of x went (the others have one key at 0).
  await expect.poll(async () => keyTimes(await savedClip(page))).toEqual([[[0], [0], [0]]]);
  expect(errors).toEqual([]);
});

test("double-clicking an animation clip in the Assets panel opens it in the Animation window", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: { [CLIP]: JSON.stringify(MOVER), "scenes/main.scene.json": SCENE } });
  const assets = page.locator(".panel.assets");
  const tile = (name: string) => assets.locator(".asset-item", { has: page.locator(".asset-name", { hasText: new RegExp(`^${name}$`) }) });
  await tile("clips").dblclick();
  await tile("mover(\\.anim\\.json)?").dblclick();
  await expect(toolbar(page)).toBeVisible();
  await expect(toolbar(page).locator(".aw-file")).toHaveText("mover.anim.json");
  await expect(page.locator(".aw-root").getByRole("button", { name: /^position\.x key at 1(\.00)? s/ })).toBeVisible();
  expect(errors).toEqual([]);
});
