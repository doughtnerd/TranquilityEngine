import { expect, openEditor, play, test, type Page, type ProjectFiles } from "./fixtures";
import { inLiveWorld } from "./liveWorld";

// Occlusion culling in the editor (ADR 0460): a wall in front of an object hides it from the game camera (its
// `LODGroup.visibility` reads "occluded" through the public `myco` API, and the Stats readout's triangles drop by its
// mesh), the scene view's View menu turns occlusion on for the scene view, and the occlusion debug view shows its
// readout. Everything goes through the editor's UI, the Stats readout and the public `myco` API; never the renderer's
// internals.
//
// Run: `npm run test:e2e -- occlusion` (Chromium).

test.describe.configure({ timeout: 3 * 60_000 });

interface Comp { type: string; data: Record<string, unknown> }
const node = (id: string, name: string, components: Comp[]) => ({ id, name, components });
const transform = (data: Record<string, unknown>): Comp => ({ type: "engine.Transform", data });

/**
 * The project: a perspective camera at (0, 2, -10) looking along +z, a wall (a built-in cube 20 × 10 × 0.5, which
 * occludes with itself) at z = 0, and behind it a sphere at z = 8 with an `LODGroup` (occlusion runs in scenes with
 * one, v1), and lights. The High tier (the editor's default) has a 256×128 occlusion buffer.
 */
function project(): ProjectFiles {
  const files: ProjectFiles = {};
  files["project.json"] = JSON.stringify({ name: "Occlusion spec", display: { width: 1280, height: 720, backgroundColor: "#9ec5e8" }, time: { fixedDeltaTime: 1 / 60 }, render: { sortingLayers: ["Default"], pixelsPerUnit: 100 }, autoload: [] });
  files["materials/wall.material.json"] = JSON.stringify({ format: "myco.material@1", color: "#d8d8d0", roughness: 1 });
  files["materials/ball.material.json"] = JSON.stringify({ format: "myco.material@1", color: "#b83a2a", roughness: 0.6 });
  const nodes = [
    node("camera", "Camera", [transform({ position: [0, 2, -10] }), { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 60, occlusionCulling: true } }]),
    node("sun", "Sun", [transform({ position: [0, 20, -20], rotation: [0.3826834, 0, 0, 0.9238795] }), { type: "engine.Light", data: { type: "directional", intensity: 1.4 } }]),
    node("ambient", "Ambient Light", [transform({}), { type: "engine.Light", data: { type: "ambient", intensity: 0.45 } }]),
    node("wall", "Wall", [transform({ position: [0, 2, 0], scale: [20, 10, 0.5] }), { type: "engine.MeshRenderer", data: { mesh: "builtin:cube", material: "asset:materials/wall.material.json" } }]),
    node("ball", "Ball", [
      transform({ position: [0, 2, 8], scale: [2, 2, 2] }),
      { type: "engine.MeshRenderer", data: { mesh: "builtin:sphere", material: "asset:materials/ball.material.json" } },
      { type: "engine.LODGroup", data: { fade: "none" } },
    ]),
  ];
  files["scenes/main.scene.json"] = JSON.stringify({ format: "myco.scene@5", nodes });
  return files;
}

const trackErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
};

const triangles = (page: Page) => page.locator('.play-stats [data-stat="triangles"]');

/** The Stats readout's triangle count once it holds still for three readings (it refreshes about four times a second). */
async function steadyTriangles(page: Page): Promise<number> {
  let last = -1, same = 0;
  await expect
    .poll(
      async () => {
        const n = Number((await triangles(page).textContent())?.replace(/[^\d]/g, "") ?? 0);
        same = n === last ? same + 1 : 0;
        last = n;
        return same >= 3 && n > 0;
      },
      { timeout: 60_000, intervals: [300] },
    )
    .toBe(true);
  return last;
}

/** The running game's ball `LODGroup.visibility`, read through the public component API. */
const ballVisibility = (page: Page): Promise<string | null> =>
  inLiveWorld(page, null, (w, tools) => {
    if (!w) return null;
    const g = tools.componentsOf<{ visibility: string }>(w.root, tools.myco.LODGroup)[0];
    return g ? g.visibility : null;
  });

/** Set the running game's ball renderer's `occlusion` (a script may change it every frame). */
const setBallOcclusion = (page: Page, value: string) =>
  inLiveWorld(page, null, (w, tools, arg: { value: string }) => {
    type Node = NonNullable<typeof w>["root"];
    const find = (n: Node, name: string): Node | undefined => (n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean));
    const ball = find(w!.root, "Ball")!;
    tools.componentsOf<{ occlusion: string }>(ball, tools.myco.MeshRenderer)[0].occlusion = arg.value;
  }, { value });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("myco.editor.playStats", "true"));
});

test("in play mode a wall hides the object behind it: its LODGroup reads occluded and the game view stops drawing it", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: project(), viewport: { width: 1280, height: 720 }, timeout: 2 * 60_000 });
  await play(page);
  await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();
  // The occlusion core loads the first time a view asks for it: a few frames later the ball is occluded.
  await expect.poll(() => ballVisibility(page), { timeout: 60_000 }).toBe("occluded");
  const hidden = await steadyTriangles(page);
  // The Play Stats panel's Occlusion table reports the run.
  await expect(page.getByRole("region", { name: "Stats" }).getByText("Occlusion", { exact: true })).toBeVisible({ timeout: 30_000 });

  // "none" is never culled: the ball draws again behind the wall, and the triangles grow by its mesh.
  await setBallOcclusion(page, "none");
  await expect.poll(() => ballVisibility(page), { timeout: 30_000 }).toBe("drawn");
  await expect.poll(() => steadyTriangles(page), { timeout: 60_000 }).toBeGreaterThan(hidden);
  // Back to "auto": hidden again, the triangles as before.
  await setBallOcclusion(page, "auto");
  await expect.poll(() => ballVisibility(page), { timeout: 30_000 }).toBe("occluded");
  await expect.poll(() => steadyTriangles(page), { timeout: 60_000 }).toBe(hidden);
  expect(errors).toEqual([]);
});

test("the scene view's View menu turns occlusion on for the scene view, and the occlusion debug view shows its readout", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: project(), viewport: { width: 1600, height: 900 }, timeout: 2 * 60_000 });
  const view = page.getByRole("button", { name: "View", exact: true });
  const menu = page.getByRole("dialog", { name: "View", exact: true });
  await view.click();
  // All off by default: editing shows everything.
  await expect(menu.getByRole("checkbox", { name: "Occlusion culling" })).not.toBeChecked();
  await expect(menu.getByRole("checkbox", { name: "Freeze culling" })).not.toBeChecked();
  await expect(menu.getByRole("checkbox", { name: "Validator" })).not.toBeChecked();
  await expect(menu.getByRole("radio", { name: "None", exact: true })).toBeChecked();

  // The occlusion debug view: without the scene view's toggle, the readout is the main camera's run (the edit-mode
  // World selects for its camera too), which culls the ball behind the wall.
  await menu.getByRole("radio", { name: "Occlusion", exact: true }).check();
  const inset = page.getByRole("region", { name: "Occlusion debug" });
  await expect(inset).toBeVisible();
  await expect(inset.getByText("Main camera")).toBeVisible({ timeout: 60_000 });
  const readout = inset.getByLabel("Occlusion readout");
  await expect(readout.locator('[data-stat="culled"] dd')).toHaveText("1", { timeout: 30_000 });
  await expect(readout.locator('[data-stat="occluders"] dd')).not.toHaveText("0");
  await expect(inset.getByLabel("Occlusion buffer")).toBeVisible();

  // The scene view's own toggle: the readout is now the scene view's run, with its own numbers.
  await menu.getByRole("checkbox", { name: "Occlusion culling" }).check();
  await expect(inset.getByText("Scene view")).toBeVisible({ timeout: 30_000 });
  await expect(readout.locator('[data-stat="tested"] dd')).not.toHaveText("");

  // Remembered per user: a reload keeps the toggle and the debug view.
  await page.reload();
  await expect(page.getByRole("region", { name: "Occlusion debug" })).toBeVisible({ timeout: 2 * 60_000 });
  await page.getByRole("button", { name: "View", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "View", exact: true }).getByRole("checkbox", { name: "Occlusion culling" })).toBeChecked();

  // LOD level colouring and back to none: the inset goes.
  await page.getByRole("dialog", { name: "View", exact: true }).getByRole("radio", { name: "LOD levels", exact: true }).check();
  await expect(page.getByRole("region", { name: "Occlusion debug" })).toHaveCount(0);
  await page.getByRole("dialog", { name: "View", exact: true }).getByRole("radio", { name: "None", exact: true }).check();
  expect(errors).toEqual([]);
});

test("the Inspector shows a renderer's effective occlusion role beside the field", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: project(), viewport: { width: 1600, height: 900 }, timeout: 2 * 60_000 });
  await page.locator(".tree .row", { hasText: "Wall" }).click();
  await expect(page.getByRole("note", { name: "Occlusion role: Occluder + occludee" })).toBeVisible({ timeout: 30_000 });
  expect(errors).toEqual([]);
});
