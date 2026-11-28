import { expect, openEditor, play, test, type Hooks, type Locator, type Page, type ProjectFiles } from "./fixtures";
import { inLiveWorld } from "./liveWorld";
import { noise3, orientOutward, sphereForTris, toObj } from "./render-bench/geom";
import { captureView, pixelsChanged, steadyView, type ViewCapture } from "./viewCapture";

// Mesh LODs in the editor (ADR 0446): the import panel's "Generate LODs", the LODGroup a placed model gets, the LOD bar, and
// the levels an LODGroup picks in play mode. Everything goes through the editor's UI, the saved files, captures and the public
// `myco` API (an LODGroup's `currentLevel` and `visibility`, read through `inLiveWorld`); never the renderer's internals.
//
// Run: `npm run test:e2e -- lod` (Chromium; the model has about 20,000 triangles, so software GL takes a while: the timeouts are generous).

test.describe.configure({ timeout: 4 * 60_000 });

// --- The project ---------------------------------------------------------------------------------------------------------

const utf8 = new TextEncoder();

/** A displaced sphere of about 20,000 triangles (a rock about 2 m across), as OBJ + MTL bytes (the editor reads model files as bytes). */
function rockModel(): ProjectFiles {
  const disp = (x: number, y: number, z: number) => 0.8 + 0.4 * noise3(x * 1.7 + 3, y * 1.7, z * 1.7, 7) + 0.05 * noise3(x * 6, y * 6, z * 6, 8);
  const g = orientOutward(sphereForTris(20_000, 1, 1, 1, 0, 0, 0, disp), 0, 0, 0);
  return {
    "models/rock.mtl": utf8.encode("newmtl rock\nKd 0.72 0.23 0.17\n"),
    "models/rock.obj": utf8.encode(toObj("rock", [{ ...g, material: "rock" }], "rock.mtl")),
  };
}

const sidecar = (lod: unknown) => JSON.stringify({ format: "myco.import@1", lod });
/** The import panel's defaults (ADR 0446 §1). */
const DEFAULT_LOD = { levels: [{ ratio: 0.5, error: 0.01 }, { ratio: 0.25, error: 0.02 }, { ratio: 0.125, error: 0.04 }], attributes: true, permissive: false, lockBorders: false, pixelError: 1 };

/** A rotation about +x by `pitch` degrees (the camera looks down for a positive angle), as a quaternion. */
const pitchQuat = (degrees: number) => {
  const h = (degrees * Math.PI) / 360;
  return [+Math.sin(h).toFixed(6), 0, 0, +Math.cos(h).toFixed(6)];
};

interface Comp { type: string; data: Record<string, unknown> }
const node = (id: string, name: string, components: Comp[]) => ({ id, name, components });
const transform = (data: Record<string, unknown>): Comp => ({ type: "engine.Transform", data });

/** Where the camera stands (a pose that looks at the rock from 20 m); the specs move it along z. */
const NEAR_Z = -10;

/**
 * The project: a camera, a shadow-casting sun, a light ground, and (with `rock`) the rock at (0, 3, 10), three times its size,
 * with an `LODGroup` (unless `group` is false; no crossfade: a level change is one frame). `lod` is the model sidecar's `lod`: absent, the model has no levels.
 */
function project(o: { rock: boolean; lod: unknown | null; group?: boolean }): ProjectFiles {
  const files: ProjectFiles = { ...rockModel() };
  files["project.json"] = JSON.stringify({ name: "LOD spec", display: { width: 1280, height: 720, backgroundColor: "#9ec5e8" }, time: { fixedDeltaTime: 1 / 60 }, render: { sortingLayers: ["Default"], pixelsPerUnit: 100 }, autoload: [] });
  files["materials/rock.material.json"] = JSON.stringify({ format: "myco.material@1", color: "#b83a2a", roughness: 0.9 });
  files["materials/ground.material.json"] = JSON.stringify({ format: "myco.material@1", color: "#d8d8d0", roughness: 1 });
  if (o.lod) files["models/rock.obj.meta.json"] = sidecar(o.lod);
  const nodes = [
    node("camera", "Camera", [transform({ position: [0, 12, NEAR_Z], rotation: pitchQuat(25) }), { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 60 } }]),
    node("sun", "Sun", [transform({ position: [0, 50, 0], rotation: [0.4403775, -0.2667293, -0.1388505, 0.8459573] }), { type: "engine.Light", data: { type: "directional", intensity: 1.6, castShadows: true, shadowArea: 80 } }]),
    node("ambient", "Ambient Light", [transform({}), { type: "engine.Light", data: { type: "ambient", intensity: 0.45 } }]),
    node("ground", "Ground", [transform({ scale: [12, 1, 12] }), { type: "engine.MeshRenderer", data: { mesh: "builtin:plane", material: "asset:materials/ground.material.json", castShadows: false } }]),
  ];
  if (o.rock) {
    nodes.push(node("rock", "Rock", [
      transform({ position: [0, 3, 10], scale: [3, 3, 3] }),
      { type: "engine.MeshRenderer", data: { mesh: "asset:models/rock.obj", materials: ["asset:materials/rock.material.json"] } },
      ...(o.group === false ? [] : [{ type: "engine.LODGroup", data: { fade: "none" } }]),
    ]));
  }
  files["scenes/main.scene.json"] = JSON.stringify({ format: "myco.scene@5", nodes });
  return files;
}

// --- Page helpers --------------------------------------------------------------------------------------------------------

const trackErrors = (page: Page): string[] => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
};

const box = async (l: Locator) => (await l.boundingBox())!;
const read = (page: Page, path: string) => page.evaluate((p) => (window as unknown as Hooks).testFolder.read(p), path);
const card = (page: Page, name: string) => page.locator(".inspector-body .component", { has: page.locator("h3", { hasText: name }) });
const gameView = (page: Page) => page.locator("#game-view canvas").first();
const triangles = (page: Page) => page.locator('.play-stats [data-stat="triangles"]');

/** Press on an asset tile and drop it at (x, y). */
async function dragAsset(page: Page, file: string, x: number, y: number): Promise<void> {
  const t = await box(page.locator(".asset-tile", { hasText: file }).first());
  await page.mouse.move(t.x + t.width / 2, t.y + 20);
  await page.mouse.down();
  await page.mouse.move(t.x + t.width / 2 + 20, t.y - 20, { steps: 3 });
  await page.mouse.move(x, y, { steps: 8 });
  await page.mouse.up();
}

async function showModels(page: Page): Promise<void> {
  await page.locator(".asset-folder", { hasText: /^models$/ }).click();
}

/** The Stats overlay on (remembered per user), for every page of a test. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("myco.editor.playStats", "true"));
});

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
      { timeout: 90_000, intervals: [300] },
    )
    .toBe(true);
  return last;
}

/** What the running game's rock `LODGroup` says, and the camera's z (a pose along the view's axis). */
interface Group { currentLevel: number; visibility: string }
const groupOf = (page: Page): Promise<Group | null> =>
  inLiveWorld(page, null, (w, tools) => {
    if (!w) return null;
    const g = tools.componentsOf<{ currentLevel: number; visibility: string }>(w.root, tools.myco.LODGroup)[0];
    return g ? { currentLevel: g.currentLevel, visibility: g.visibility } : null;
  });

/** Move the game's camera along z (the rock stays at z = 10). */
const moveCamera = (page: Page, z: number) =>
  inLiveWorld(page, null, (w, _tools, arg: { z: number }) => {
    // The scene is a node under the World's root (ADR 0016): look through the whole tree.
    type Node = NonNullable<typeof w>["root"];
    const find = (n: Node, name: string): Node | undefined => (n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean));
    const cam = find(w!.root, "Camera")!;
    cam.transform!.position.set(0, 12, arg.z);
  }, { z });

/** Set a field of the game's rock `LODGroup` through the public component API. */
const setGroup = (page: Page, values: { levels?: number[]; forceLevel?: number }) =>
  inLiveWorld(page, null, (w, tools, arg: { levels?: number[]; forceLevel?: number }) => {
    const g = tools.componentsOf<{ levels: number[]; forceLevel: number }>(w!.root, tools.myco.LODGroup)[0];
    if (arg.levels) g.levels = arg.levels;
    if (arg.forceLevel !== undefined) g.forceLevel = arg.forceLevel;
  }, values);

// --- Specs ---------------------------------------------------------------------------------------------------------------

test("Generate LODs in the import panel reports each level's triangles, and placing the model adds an LODGroup with the LOD bar", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: project({ rock: false, lod: null }), viewport: { width: 1600, height: 900 }, timeout: 2 * 60_000 });
  await showModels(page);

  // Import flow: no levels yet, so no "reached" rows; tick the switch, Apply, and each level reports what it reached.
  await page.locator(".asset-tile", { hasText: "rock.obj" }).first().click();
  const inspector = page.getByLabel("Import settings");
  const generate = inspector.getByRole("checkbox", { name: "Generate LODs" });
  await expect(generate).not.toBeChecked();
  await generate.check();
  await expect(inspector.getByRole("spinbutton", { name: "LOD1 ratio" })).toHaveValue("0.5");
  await inspector.getByRole("button", { name: "Apply" }).click();
  await expect.poll(() => read(page, "models/rock.obj.meta.json"), { timeout: 30_000 }).toContain('"lod"');
  for (const level of [1, 2, 3]) await expect(inspector.getByLabel(`LOD${level} reached`)).toContainText(/reached [\d,]+ triangles/, { timeout: 2 * 60_000 });

  // Placement: drop the model in the viewport; the root has the LODGroup and the Inspector shows the LOD bar.
  const vp = await box(page.locator(".viewport-panel"));
  await dragAsset(page, "rock.obj", vp.x + vp.width * 0.5, vp.y + vp.height * 0.6);
  await expect(page.locator(".tree .row.selected")).toHaveAttribute("data-key", /^rock/, { timeout: 60_000 });
  await expect(card(page, "LODGroup")).toBeVisible();
  const bar = page.getByLabel("LOD bar");
  await expect(bar).toBeVisible();
  await expect(bar.getByText("Transition heights (automatic)")).toBeVisible();
  await expect(bar.getByLabel(/^LOD0,/)).toBeVisible();
  await expect(bar.getByRole("status")).toHaveCount(0); // not forced

  // forceLevel pins the level: the field takes it, the LOD bar shows the badge, and -1 takes it away again.
  const force = card(page, "LODGroup").getByRole("textbox", { name: "forceLevel" });
  await force.fill("2");
  await force.press("Enter");
  await expect(bar.getByRole("status")).toHaveText("Forced to LOD2");
  await force.fill("-1");
  await force.press("Enter");
  await expect(bar.getByRole("status")).toHaveCount(0);

  // The placement is one undo step: undoing it removes the node (and the group with it).
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(page.locator(".tree .row", { hasText: "rock" })).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("a model without levels is placed without an LODGroup", async ({ page }) => {
  const errors = trackErrors(page);
  await openEditor(page, { files: project({ rock: false, lod: null }), viewport: { width: 1600, height: 900 }, timeout: 2 * 60_000 });
  await showModels(page);
  const vp = await box(page.locator(".viewport-panel"));
  await dragAsset(page, "rock.obj", vp.x + vp.width * 0.5, vp.y + vp.height * 0.6);
  await expect(page.locator(".tree .row.selected")).toHaveAttribute("data-key", /^rock/, { timeout: 60_000 });
  await expect(card(page, "MeshRenderer")).toBeVisible();
  await expect(card(page, "LODGroup")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test.describe("in play mode", () => {
  test.use({ viewport: { width: 1280, height: 720 } });

  /** Open the project with the rock and its levels, and play until the rock's group has a level (its model has loaded). */
  async function playRock(page: Page): Promise<void> {
    await openEditor(page, { files: project({ rock: true, lod: DEFAULT_LOD }), viewport: { width: 1280, height: 720 }, timeout: 2 * 60_000 });
    await play(page);
    await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();
    // The view is drawn once the levels have generated and the model has loaded. Which level shows from here depends on the
    // levels' measured errors: a smooth rock's first level is invisible at 1 px from most distances, so it may already be 1.
    await expect.poll(async () => (await groupOf(page))?.visibility, { timeout: 2 * 60_000 }).toBe("drawn");
  }

  test("a far camera draws a lower level and fewer triangles, and a group culled below its last height draws nothing", async ({ page }) => {
    const errors = trackErrors(page);
    await playRock(page);
    const near = await steadyTriangles(page);
    const nearLevel = (await groupOf(page))!.currentLevel;
    expect(near).toBeGreaterThan(1_000);

    await moveCamera(page, -300);
    await expect.poll(async () => (await groupOf(page))?.currentLevel, { timeout: 60_000 }).toBeGreaterThan(nearLevel);
    await expect.poll(() => steadyTriangles(page), { timeout: 90_000 }).toBeLessThan(near * 0.75);

    // Back close: the near level again.
    await moveCamera(page, NEAR_Z);
    await expect.poll(async () => (await groupOf(page))?.currentLevel, { timeout: 60_000 }).toBe(nearLevel);

    // Explicit heights that cull at this distance (the rock is 45% of the view's height, below the last value 0.6).
    const drawn = await steadyView(gameView(page));
    await setGroup(page, { levels: [0.9, 0.8, 0.7, 0.6] });
    await expect.poll(() => groupOf(page), { timeout: 60_000 }).toEqual({ currentLevel: -1, visibility: "lodCulled" });
    const culled = await steadyView(gameView(page));
    // The rock's body is gone from the view (it covered a good share of it).
    expect(pixelsChanged(drawn, culled)).toBeGreaterThan(drawn.width * drawn.height * 0.03);
    // A last value of 0 never culls.
    await setGroup(page, { levels: [0.9, 0.8, 0.7, 0] });
    await expect.poll(async () => (await groupOf(page))?.currentLevel, { timeout: 60_000 }).toBeGreaterThanOrEqual(3);
    expect(errors).toEqual([]);
  });

  test("forceLevel pins the level whatever the distance", async ({ page }) => {
    const errors = trackErrors(page);
    await playRock(page);
    await moveCamera(page, -300);
    await expect.poll(async () => (await groupOf(page))?.currentLevel, { timeout: 60_000 }).toBeGreaterThan(1);
    await setGroup(page, { forceLevel: 0 });
    await expect.poll(async () => (await groupOf(page))?.currentLevel, { timeout: 60_000 }).toBe(0);
    await setGroup(page, { forceLevel: 2 });
    await expect.poll(async () => (await groupOf(page))?.currentLevel, { timeout: 60_000 }).toBe(2);
    await setGroup(page, { forceLevel: -1 });
    await expect.poll(async () => (await groupOf(page))?.currentLevel, { timeout: 60_000 }).toBeGreaterThan(0);
    expect(errors).toEqual([]);
  });

  test("a culled group still casts its shadow", async ({ page }) => {
    const errors = trackErrors(page);
    await playRock(page);
    // Cull the rock at this distance (the sun's shadow of it falls on the ground left of it and beyond it, in view).
    await setGroup(page, { levels: [0.9, 0.8, 0.7, 0.6] });
    await expect.poll(async () => (await groupOf(page))?.visibility, { timeout: 60_000 }).toBe("lodCulled");
    const shadowed = await steadyView(gameView(page));

    // The same view with the light's shadows off: the dark patch on the ground is the shadow, and only it.
    await inLiveWorld(page, null, (w, tools) => {
      type Node = NonNullable<typeof w>["root"];
    const find = (n: Node, name: string): Node | undefined => (n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean));
      const sun = find(w!.root, "Sun")!;
      tools.componentsOf<{ castShadows: boolean }>(sun, tools.myco.Light)[0].castShadows = false;
    });
    await expect.poll(async () => darkPixels(await steadyView(gameView(page))), { timeout: 60_000 }).toBeLessThan(darkPixels(shadowed) / 2);
    const lit = await steadyView(gameView(page));
    expect(darkPixels(shadowed)).toBeGreaterThan(darkPixels(lit) + 300);
    expect(pixelsChanged(shadowed, lit)).toBeGreaterThan(300);
    expect(errors).toEqual([]);
  });
});

/** How many pixels are much darker than the view's median brightness: the ground is lit evenly, so they are shadow. */
function darkPixels(c: ViewCapture): number {
  const lum: number[] = [];
  for (let i = 0; i < c.data.length; i += c.channels) lum.push(0.3 * c.data[i] + 0.59 * c.data[i + 1] + 0.11 * c.data[i + 2]);
  const median = [...lum].sort((a, b) => a - b)[lum.length >> 1];
  return lum.filter((l) => l < median * 0.75).length;
}

test("a scene without LOD groups draws the same triangles after visiting the LOD settings", async ({ page }) => {
  const errors = trackErrors(page);
  // The rock has no levels and no group: drawn as it always was.
  const files = project({ rock: true, lod: null, group: false });
  await openEditor(page, { files, viewport: { width: 1600, height: 900 }, timeout: 2 * 60_000 });
  await play(page);
  await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();
  const before = await steadyTriangles(page);
  expect(before).toBeGreaterThan(15_000);
  await page.getByRole("button", { name: /Stop/ }).click();

  // Visit the LOD settings: tick Generate LODs, then revert it without applying.
  await showModels(page);
  await page.locator(".asset-tile", { hasText: "rock.obj" }).first().click();
  const inspector = page.getByLabel("Import settings");
  await inspector.getByRole("checkbox", { name: "Generate LODs" }).check();
  await expect(inspector.getByRole("spinbutton", { name: "LOD1 ratio" })).toBeVisible();
  await inspector.getByRole("button", { name: "Revert" }).click();
  await expect(inspector.getByRole("checkbox", { name: "Generate LODs" })).not.toBeChecked();
  expect(await read(page, "models/rock.obj.meta.json")).toBeUndefined();

  await play(page);
  await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();
  expect(await steadyTriangles(page)).toBe(before);
  expect(errors).toEqual([]);
});
