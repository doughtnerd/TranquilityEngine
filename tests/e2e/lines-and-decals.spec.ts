import { expect, type Hooks, openEditor, type Page, play, test } from "./fixtures";
import { node, scene, stage } from "./animationAssets";
import { inLiveWorld, type LiveNode } from "./liveWorld";
import { captureView, steadyView, type ViewCapture } from "./viewCapture";

// Line and trail renderers (ADR 0396) and decals (ADR 0395) in a real browser: a red 3D line across the view and a
// green decal projected onto a white wall draw in Play; switching the decal off takes its green away; a spawned decal
// (`Decals.project`) and a trail behind a moving node work through the public `myco` API. In the editor, both nodes
// draw in the scene view (`nodeRect`), and the line's Edit Points handles move a point, saved to the scene file.
test.describe.configure({ timeout: 90_000 });

const gameView = (page: Page) => page.locator("#game-view canvas").first();
const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
const card = (page: Page, type: string) => page.locator(".inspector-body .component", { hasText: type }).first();

/** A camera looking along +z at a white wall (z = 3), a red line across the top, and a green decal projected onto the wall's middle. */
const nodes = () => [
  ...stage(),
  node("wall", "Wall", [0, 1, 3], [{ type: "engine.MeshRenderer", data: { mesh: "builtin:cube" } }], { scale: [8, 6, 0.5] }),
  node("beam", "Beam", [0, 0, 0], [{ type: "engine.LineRenderer", data: { width: 0.25, color: "#ff0000", positions: [[-2.5, 2.6, 1], [2.5, 2.6, 1]] } }]),
  node("decal", "Decal", [0, 0.5, 1], [{ type: "engine.DecalProjector", data: { color: "#00ff00", size: [1.6, 1.6, 4], pivot: [0, 0, 0] } }]),
];

/** How many pixels are mostly `channel` (0 red, 1 green, 2 blue): that one well above the other two. */
function pixelsOf(c: ViewCapture, channel: 0 | 1 | 2): number {
  let n = 0;
  for (let i = 0; i < c.data.length; i += c.channels) {
    const v = c.data[i + channel]!, a = c.data[i + ((channel + 1) % 3)]!, b = c.data[i + ((channel + 2) % 3)]!;
    if (v > 120 && v > a * 1.8 && v > b * 1.8) n++;
  }
  return n;
}

test("a 3D line and a projected decal draw in Play; a spawned decal and a trail work through myco", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await openEditor(page, { files: { "scenes/main.scene.json": scene(nodes()) } });
  await play(page);
  const view = gameView(page);
  await expect.poll(async () => pixelsOf(await captureView(view), 0), { timeout: 30_000, message: "the red line draws" }).toBeGreaterThan(80);
  await expect.poll(async () => pixelsOf(await captureView(view), 1), { timeout: 30_000, message: "the green decal draws on the wall" }).toBeGreaterThan(80);

  // Switched off, the decal's green goes.
  await inLiveWorld(page, null, (w, { myco }) => {
    const find = (n: LiveNode): LiveNode | null => (n.name === "Decal" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null));
    (find(w!.root)!.getComponents(myco.DecalProjector)[0] as { enabled: boolean }).enabled = false;
  });
  await expect.poll(async () => pixelsOf(await captureView(view), 1), { timeout: 15_000, message: "the decal is gone" }).toBeLessThan(20);

  // A spawned decal, blue, on the wall's left: drawn, and counted by the pool.
  const count = await inLiveWorld(page, null, (_w, { myco }) => {
    myco.Decals.project({ position: [-2, 0.5, 1], size: [1.2, 1.2, 4], color: new myco.Color(0, 0, 1, 1) });
    return myco.Decals.count as number;
  });
  expect(count).toBe(1);
  await expect.poll(async () => pixelsOf(await captureView(view), 2), { timeout: 15_000, message: "the spawned blue decal draws" }).toBeGreaterThan(60);

  // A trail behind a node the page moves: its history grows as the node moves.
  await inLiveWorld(page, null, (_w, { myco }) => {
    const n = myco.GameObject.create("Streak");
    n.addBehavior(myco.TrailRenderer, { lifetime: 5, minVertexDistance: 0.05, width: 0.2 });
  });
  for (let i = 1; i <= 6; i++) {
    await inLiveWorld(page, null, (w, _t, x: number) => {
      const find = (n: LiveNode): LiveNode | null => (n.name === "Streak" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null));
      find(w!.root)!.transform!.position.set(x, -1, 1);
    }, i * 0.3);
    await page.waitForTimeout(150);
  }
  const points = await inLiveWorld(page, null, (w, { myco }) => {
    const find = (n: LiveNode): LiveNode | null => (n.name === "Streak" ? n : n.children.reduce<LiveNode | null>((hit, c) => hit ?? find(c), null));
    return (find(w!.root)!.getComponents(myco.TrailRenderer)[0] as { positionCount: number }).positionCount;
  });
  expect(points).toBeGreaterThan(3);
  expect(errors).toEqual([]);
});

test("in the editor, the line and the decal draw in the scene view, and Edit Points moves a point (saved)", async ({ page }) => {
  await openEditor(page, { files: { "scenes/main.scene.json": scene(nodes()) } });
  await page.evaluate(() => (window as unknown as Hooks).orbit.focus([0, 1, 2], 12));
  const rect = (key: string) => page.evaluate((k) => (window as unknown as Hooks).nodeRect(k), key);
  await expect.poll(() => rect("beam"), { timeout: 20_000, message: "the line is drawn in the scene view" }).not.toBeNull();
  await expect.poll(() => rect("decal"), { timeout: 20_000, message: "the decal's box is drawn" }).not.toBeNull();
  await steadyView(page.locator(".viewport canvas"));

  await row(page, "beam").click();
  const toggle = card(page, "LineRenderer").getByRole("button", { name: "Edit Points" });
  await toggle.click();
  await expect(toggle).toHaveAttribute("aria-pressed", "true");
  await page.waitForFunction(() => ((window as unknown as Hooks).overlayHandles?.() ?? []).length === 2);
  const canvas = (await page.locator(".viewport canvas").boundingBox())!;
  const handles = await page.evaluate(() => (window as unknown as Hooks).overlayHandles!());
  const end = handles.find((h) => h.id === "point:1")!;
  await page.mouse.move(canvas.x + end.x, canvas.y + end.y);
  await page.mouse.down();
  await page.mouse.move(canvas.x + end.x, canvas.y + end.y + 60, { steps: 8 });
  await page.mouse.up();

  await page.keyboard.press("ControlOrMeta+s");
  /** The beam's saved points, once the scene file has them. */
  const savedPoints = () =>
    page.evaluate(() => {
      const text = (window as unknown as Hooks).testFolder.read("scenes/main.scene.json");
      if (!text) return null;
      const beam = JSON.parse(text).nodes.find((n: { id: string }) => n.id === "beam");
      return (beam?.components.find((c: { type: string }) => c.type === "engine.LineRenderer")?.data.positions ?? null) as number[][] | null;
    });
  await expect.poll(async () => (await savedPoints())?.[1]?.[1] ?? 2.6, { timeout: 15_000, message: "the dragged point is saved lower" }).toBeLessThan(2.6);
  expect((await savedPoints())![0]).toEqual([-2.5, 2.6, 1]); // the other point stays
});
