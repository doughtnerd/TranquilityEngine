import { expect, test, type Page } from "./fixtures";
import { installFakeFolders, nextFolder } from "./fakeFolders";

// Navigation debug drawing (ADR 0065): a scene with a NavChunk over a floor is baked with the
// chunk's Bake button; the scene view's Nav menu then draws the baked navmesh as overlay segments.
// The test hook `window.navOverlay()` (src/plugins/navigation/editor/navGizmo.ts) reports what the scene view draws.
//
// NOT YET RUN. It needs the engine.NavChunk component and its Inspector "Bake" button (the editor
// bake wave). Until the coordinator adds the navigation sample, the scene is built here as a fake
// folder; the test skips itself when the component or button isn't there yet.

test.describe.configure({ timeout: 90_000 });

type Hooks = {
  engine?: { world: { time: { frameCount: number } } };
  navOverlay?: () => { bakes: number; loaded: number; segments: number; byColor: Record<number, number>; failed: string[] };
};

const waitForEngine = (page: Page) => page.waitForFunction(() => ((window as unknown as Hooks).engine?.world.time.frameCount ?? 0) > 10);
const overlay = (page: Page) => page.evaluate(() => (window as unknown as Hooks).navOverlay?.() ?? null);

/** A floor (a 20 m box mesh renderer) and a NavChunk covering it. */
const SCENE = {
  format: "myco.scene@1",
  nodes: [
    { id: "floor", name: "Floor", components: [{ type: "engine.MeshRenderer", data: { mesh: "primitive:cube" } }, { type: "engine.BoxCollider", data: { size: { x: 20, y: 0.2, z: 20 } } }] },
    { id: "chunk", name: "Nav Chunk", components: [{ type: "engine.NavChunk", data: { useChunkBounds: true, center: { x: 0, y: 5, z: 0 }, size: { x: 32, y: 16, z: 32 } } }] },
  ],
};

test("Baking a NavChunk and toggling Navmesh draws its polygon outlines in the scene view", async ({ page, browserName }) => {
  test.skip(browserName !== "chromium", "folders open writably through File System Access in Chromium only");
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));

  await installFakeFolders(page, {
    NavTest: {
      "project.json": JSON.stringify({ name: "NavTest", mainScene: "scenes/main.scene.json" }),
      "scenes/main.scene.json": JSON.stringify(SCENE),
    },
  });
  await page.goto("/editor.html");
  await nextFolder(page, "NavTest");
  await page.getByRole("dialog", { name: "Start" }).getByRole("button", { name: "Open Project…" }).click();
  await waitForEngine(page);

  // Select the chunk and bake it (the Inspector's button belongs to the editor bake wave).
  await page.locator(".tree .row", { hasText: "Nav Chunk" }).first().click();
  const bake = page.getByRole("button", { name: /^Bake/ });
  test.skip((await bake.count()) === 0, "engine.NavChunk's Bake button isn't in the Inspector yet");
  await bake.first().click();
  await expect(page.locator(".status-bar")).not.toContainText(/fail|error/i, { timeout: 60_000 });

  // Navmesh off: nothing drawn. On: outlines (and the colour set by the theme) appear.
  expect((await overlay(page))?.segments ?? 0).toBe(0);
  await page.getByRole("button", { name: "Navigation overlay" }).click();
  await page.getByRole("checkbox", { name: "Navmesh" }).check();
  await expect.poll(async () => (await overlay(page))?.segments ?? 0, { timeout: 30_000 }).toBeGreaterThan(10);
  const drawn = await overlay(page);
  expect(drawn?.bakes).toBe(1);
  expect(drawn?.failed).toEqual([]);

  // Links add their own colours; turning Navmesh off again clears the outlines.
  await page.getByRole("checkbox", { name: "Navmesh" }).uncheck();
  await expect.poll(async () => (await overlay(page))?.segments ?? 0).toBe(0);
  expect(errors).toEqual([]);
});
