import { expect, openEditor, play, test, type Page, type ProjectFiles } from "./fixtures";
import { inLiveWorld } from "./liveWorld";
import { noise3, orientOutward, sphereForTris, toObj } from "./render-bench/geom";
import { captureView, pixelsChanged, steadyView, type ViewCapture } from "./viewCapture";

// The LOD crossfade, seen in pixels (ADR 0459 §4). A group with `fade: "crossfade"` and a long `fadeDuration` changes level
// while the camera stands still (its `levels` are rewritten through the public component API); the game view is captured
// while the fade runs. The dither draws the outgoing and the incoming level in complementary pixels, so the object must
// have no holes: its silhouette (the pixels that differ from the same view without the rock) stays about as large as it is
// before and after. And the fade must finish: the view settles on the same picture the incoming level alone draws.
//
// Run: `npm run test:e2e -- lod-fade` (Chromium; about 20,000 triangles per level 0, so software GL is slow: generous timeouts).

test.describe.configure({ timeout: 5 * 60_000 });
test.use({ viewport: { width: 1280, height: 720 } });

const utf8 = new TextEncoder();
const FADE_SECONDS = 5;
/** The silhouette during the fade may differ from the steady ones by this share. */
const AREA_TOLERANCE = 0.05;

/** A displaced sphere of about 20,000 triangles (a rock about 2 m across), as OBJ + MTL bytes. */
function rockModel(): ProjectFiles {
  const disp = (x: number, y: number, z: number) => 0.8 + 0.4 * noise3(x * 1.7 + 3, y * 1.7, z * 1.7, 7) + 0.05 * noise3(x * 6, y * 6, z * 6, 8);
  const g = orientOutward(sphereForTris(20_000, 1, 1, 1, 0, 0, 0, disp), 0, 0, 0);
  return {
    "models/rock.mtl": utf8.encode("newmtl rock\nKd 0.72 0.23 0.17\n"),
    "models/rock.obj": utf8.encode(toObj("rock", [{ ...g, material: "rock" }], "rock.mtl")),
  };
}

const pitchQuat = (degrees: number) => {
  const h = (degrees * Math.PI) / 360;
  return [+Math.sin(h).toFixed(6), 0, 0, +Math.cos(h).toFixed(6)];
};
const node = (id: string, name: string, components: { type: string; data: Record<string, unknown> }[]) => ({ id, name, components });
const transform = (data: Record<string, unknown>) => ({ type: "engine.Transform", data });
const DEFAULT_LOD = { levels: [{ ratio: 0.5, error: 0.01 }, { ratio: 0.25, error: 0.02 }, { ratio: 0.125, error: 0.04 }], attributes: true, permissive: false, lockBorders: false, pixelError: 1 };

/**
 * A camera that stands still, a light ground, and the rock with a crossfading group whose explicit heights (0.3, 0.2,
 * 0.1, 0) show LOD0 from here (the rock is about 45 % of the view's height).
 */
function project(): ProjectFiles {
  const files: ProjectFiles = { ...rockModel() };
  files["project.json"] = JSON.stringify({ name: "LOD fade spec", display: { width: 1280, height: 720, backgroundColor: "#9ec5e8" }, time: { fixedDeltaTime: 1 / 60 }, render: { sortingLayers: ["Default"], pixelsPerUnit: 100 }, autoload: [] });
  files["materials/rock.material.json"] = JSON.stringify({ format: "myco.material@1", color: "#b83a2a", roughness: 0.9 });
  files["materials/ground.material.json"] = JSON.stringify({ format: "myco.material@1", color: "#d8d8d0", roughness: 1 });
  files["models/rock.obj.meta.json"] = JSON.stringify({ format: "myco.import@1", lod: DEFAULT_LOD });
  files["scenes/main.scene.json"] = JSON.stringify({
    format: "myco.scene@5",
    nodes: [
      node("camera", "Camera", [transform({ position: [0, 12, -10], rotation: pitchQuat(25) }), { type: "engine.Camera", data: { projection: "perspective", fieldOfView: 60 } }]),
      node("ambient", "Ambient Light", [transform({}), { type: "engine.Light", data: { type: "ambient", intensity: 1 } }]),
      node("ground", "Ground", [transform({ scale: [12, 1, 12] }), { type: "engine.MeshRenderer", data: { mesh: "builtin:plane", material: "asset:materials/ground.material.json", castShadows: false } }]),
      node("rock", "Rock", [
        transform({ position: [0, 3, 10], scale: [3, 3, 3] }),
        { type: "engine.MeshRenderer", data: { mesh: "asset:models/rock.obj", materials: ["asset:materials/rock.material.json"], castShadows: false } },
        { type: "engine.LODGroup", data: { fade: "crossfade", fadeDuration: FADE_SECONDS, levels: [0.3, 0.2, 0.1, 0] } },
      ]),
    ],
  });
  return files;
}

const gameView = (page: Page) => page.locator("#game-view canvas").first();

const groupLevel = (page: Page): Promise<{ level: number; visibility: string } | null> =>
  inLiveWorld(page, null, (w, tools) => {
    if (!w) return null;
    const g = tools.componentsOf<{ currentLevel: number; visibility: string }>(w.root, tools.myco.LODGroup)[0];
    return g ? { level: g.currentLevel, visibility: g.visibility } : null;
  });

/** Rewrite the rock group's heights through the public component API (the camera doesn't move). */
const setLevels = (page: Page, levels: number[]) =>
  inLiveWorld(page, null, (w, tools, arg: { levels: number[] }) => {
    tools.componentsOf<{ levels: number[] }>(w!.root, tools.myco.LODGroup)[0].levels = arg.levels;
  }, { levels });

/** Show or hide the Rock node, to capture the view without it. */
const showRock = (page: Page, shown: boolean) =>
  inLiveWorld(page, null, (w, _tools, arg: { shown: boolean }) => {
    type N = NonNullable<typeof w>["root"];
    const find = (n: N, name: string): N | undefined => (n.name === name ? n : n.children.map((c) => find(c, name)).find(Boolean));
    (find(w!.root, "Rock") as unknown as { setActive(on: boolean): void }).setActive(arg.shown);
  }, { shown });

/** The silhouette: pixels that differ from the view without the rock. */
const area = (background: ViewCapture, view: ViewCapture) => pixelsChanged(background, view, 40);

test("a crossfade between levels leaves no holes in the object and finishes", async ({ page }) => {
  const errors: string[] = [];
  page.on("pageerror", (err) => errors.push(err.message));
  await page.addInitScript(() => localStorage.setItem("myco.editor.playStats", "true"));
  await openEditor(page, { files: project(), viewport: { width: 1280, height: 720 }, timeout: 2 * 60_000 });
  await play(page);
  await expect(page.getByRole("region", { name: "Stats" })).toBeVisible();
  // The Stats panel over the view changes with every refresh: hide it from captures (it stays in the page).
  await page.addStyleTag({ content: ".play-stats { visibility: hidden !important; }" });
  await expect.poll(() => groupLevel(page), { timeout: 2 * 60_000 }).toEqual({ level: 0, visibility: "drawn" });

  // The view without the rock, then with it at LOD0 (nothing has changed level yet: a steady picture).
  await showRock(page, false);
  const background = await steadyView(gameView(page));
  await showRock(page, true);
  await expect.poll(() => groupLevel(page), { timeout: 60_000 }).toEqual({ level: 0, visibility: "drawn" });
  const before = await steadyView(gameView(page));
  const areaBefore = area(background, before);
  expect(areaBefore, "the rock is in view").toBeGreaterThan(before.width * before.height * 0.02);

  // The camera stays still; the heights change so that the group now draws LOD2: a crossfade over FADE_SECONDS.
  await setLevels(page, [0.9, 0.6, 0.3, 0]);
  const started = Date.now();
  await expect.poll(async () => (await groupLevel(page))?.level, { timeout: 30_000 }).toBe(2);
  const during: { at: number; area: number }[] = [];
  while (Date.now() - started < (FADE_SECONDS - 1) * 1000 && during.length < 6) {
    const view = await captureView(gameView(page));
    during.push({ at: (Date.now() - started) / 1000, area: area(background, view) });
  }
  expect(during.length, "captured while the fade ran").toBeGreaterThanOrEqual(1);

  // The fade finishes: the view settles, and the object is drawn whole at the new level.
  await page.waitForTimeout(Math.max(0, FADE_SECONDS * 1000 + 1000 - (Date.now() - started)));
  const after = await steadyView(gameView(page), { timeout: 60_000 });
  const areaAfter = area(background, after);
  expect(areaAfter, "the rock is still in view at LOD2").toBeGreaterThan(before.width * before.height * 0.02);

  const lo = Math.min(areaBefore, areaAfter) * (1 - AREA_TOLERANCE);
  const hi = Math.max(areaBefore, areaAfter) * (1 + AREA_TOLERANCE);
  for (const d of during) expect(d.area, `silhouette area at ${d.at.toFixed(1)} s of the fade (steady: ${areaBefore} before, ${areaAfter} after)`).toBeGreaterThanOrEqual(lo);
  for (const d of during) expect(d.area).toBeLessThanOrEqual(hi);
  expect(errors).toEqual([]);
});
