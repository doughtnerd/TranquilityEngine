import { expect, type Hooks, openEditor, type Page, test } from "./fixtures";
import { node, scene, stage } from "./animationAssets";
import { dockBelow, rulerClick, savedJson } from "./animationWindows";
import { menu } from "./menus";
import { captureView, pixelsChanged, steadyView } from "./viewCapture";

// The Timeline window (ADR 0373, T53) on a scene the editor opened: a Director (TimelineDirector) whose timeline
// slides its child A from x -2 to x 2 over 2 s and holds one animation clip as a bar on a subclip track. Selecting the
// Director binds the window; Preview with a scrub moves A in the scene view; splitting the bar at the playhead is one
// undo step on the timeline. What the window wrote is read from the saved timeline file, the view from captures.

test.describe.configure({ timeout: 90_000 });

const TIMELINE = "timelines/show.timeline.json";
const SHOW = {
  format: "myco.timeline@1",
  duration: 2,
  tracks: [
    { kind: "vec3", target: { nodePath: "A", component: "engine.Transform", field: "position" }, curves: [[[0, -2], [2, 2]], [[0, 0.5]], [[0, 0]]] },
    { kind: "subclip", name: "Clips", target: { nodePath: "B", component: "", field: "" }, keys: [{ time: 0, end: 2, clip: "asset:clips/still.anim.json" }] },
  ],
};
const STILL = { format: "myco.anim-source@1", duration: 2, tracks: [] };
const SCENE = scene([
  ...stage(),
  node("director", "Director", [0, 0, 0], [{ type: "engine.TimelineDirector", data: { timeline: `asset:${TIMELINE}`, playOnStart: true } }]),
  node("a", "A", [0, 0.5, 0], [{ type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }], { parent: "director" }),
  node("b", "B", [0, -2, 0], [{ type: "engine.Animator", data: {} }], { parent: "director" }),
]);

type Show = { tracks: { kind: string; keys?: { time: number; end: number }[] }[] };

function trackErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}

const toolbar = (page: Page) => page.getByRole("toolbar", { name: "Timeline" });
const ruler = (page: Page) => page.locator(".aw-root .ce-ruler");
const bars = async (page: Page) => ((await savedJson<Show>(page, TIMELINE))?.tracks.find((t) => t.kind === "subclip")?.keys ?? []).map((k) => [k.time, k.end]);

test("the Timeline window opens on a director, scrubs the scene view in preview, and splits a clip as one undo step", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: { [TIMELINE]: JSON.stringify(SHOW), "clips/still.anim.json": JSON.stringify(STILL), "scenes/main.scene.json": SCENE } });
  await page.locator(".scene-toolbar").getByRole("button", { name: "2D", exact: true }).click();
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([0, 0.5, 0], 9));
  await page.locator(".tree .row", { has: page.locator(".name", { hasText: /^Director$/ }) }).first().click();
  await menu(page, "Window", "Timeline");
  await expect(toolbar(page)).toBeVisible();
  await dockBelow(page, "Timeline");
  await expect(toolbar(page)).toBeVisible();
  // Bound to the director's timeline: a row group for A, and the clip's bar.
  const bar = page.locator(".aw-root .ce-bar-body").first();
  await expect(bar).toBeVisible();

  // Preview: the playhead at 0 s and at the end show A at x -2 and x 2.
  const view = page.locator(".panel.scene #viewport canvas");
  const before = await steadyView(view);
  await toolbar(page).getByRole("button", { name: "Preview", exact: true }).click();
  await toolbar(page).getByRole("button", { name: "To start" }).click();
  await expect(page.locator(".aw-time")).toContainText("0.00 s");
  const atStart = await steadyView(view);
  expect(pixelsChanged(before, atStart), "the preview at 0 s shows A at x -2, not where the scene has it").toBeGreaterThan(300);
  await rulerClick(page, ruler(page), 1);
  await expect(page.locator(".aw-time")).toContainText("2.00 s");
  await expect.poll(async () => pixelsChanged(atStart, await captureView(view)), { message: "pixels A's move changes" }).toBeGreaterThan(300);
  await toolbar(page).getByRole("button", { name: "Preview", exact: true }).click();
  await expect.poll(async () => pixelsChanged(before, await captureView(view)), { message: "pixels still off the scene's own view after the preview" }).toBeLessThan(60);

  // Split the bar at 1 s: two bars in the file; one Undo puts the one bar back.
  await rulerClick(page, ruler(page), 0.5);
  await expect(page.locator(".aw-time")).toContainText("1.00 s");
  const b = (await bar.boundingBox())!;
  await page.mouse.click(b.x + b.width * 0.25, b.y + b.height / 2);
  await expect(bar).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("toolbar", { name: "Items" }).getByRole("button", { name: "Split", exact: true }).click();
  await expect.poll(() => bars(page)).toEqual([
    [0, 1],
    [1, 2],
  ]);
  await page.locator(".aw-root").focus();
  await page.keyboard.press("ControlOrMeta+z");
  await expect.poll(() => bars(page)).toEqual([[0, 2]]);
  await expect(page.locator(".scene-name")).not.toContainText("•");
  expect(errors).toEqual([]);
});
