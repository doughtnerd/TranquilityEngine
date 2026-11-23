import { expect, test, type Page, waitForEditor } from "./fixtures";
import { installFakeFolders, nextFolder } from "./fakeFolders";
import { captureView, pixelsChanged, type ViewCapture } from "./viewCapture";

// Navigation debug drawing (ADR 0065): a scene with a NavChunk over a floor is baked with the
// chunk's Bake button; the scene view's Nav menu then draws the baked navmesh as overlay segments.
// What the scene view draws is read from captures of it, compared with one taken before the toggle.
//
// The scene is built here as a fake folder; the test skips itself when the Bake button isn't there.

test.describe.configure({ timeout: 90_000 });

const sceneView = (page: Page) => captureView(page.locator(".panel.scene #viewport canvas"));
/** How many of the scene view's pixels changed since `before`. */
const changedSince = async (page: Page, before: ViewCapture) => pixelsChanged(before, await sceneView(page));

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
  await waitForEditor(page);

  // Select the chunk and bake it.
  await page.locator(".tree .row", { hasText: "Nav Chunk" }).first().click();
  const bake = page.getByRole("button", { name: /^Bake/ });
  test.skip((await bake.count()) === 0, "engine.NavChunk's Bake button isn't in the Inspector");
  await bake.first().click();
  await expect(page.locator(".status-bar")).not.toContainText(/fail|error/i, { timeout: 60_000 });

  // Navmesh off: the view as it was. On: the baked polygons' outlines are drawn over it.
  await page.getByRole("button", { name: "Navigation overlay" }).click();
  const before = await sceneView(page);
  await page.getByRole("checkbox", { name: "Navmesh" }).check();
  await expect.poll(() => changedSince(page, before), { timeout: 30_000 }).toBeGreaterThan(300);
  await expect(page.locator(".status-bar")).not.toContainText(/fail|error/i);

  // Turning Navmesh off again clears the outlines.
  await page.getByRole("checkbox", { name: "Navmesh" }).uncheck();
  await expect.poll(() => changedSince(page, before)).toBeLessThan(60);
  expect(errors).toEqual([]);
});
