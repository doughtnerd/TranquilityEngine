// Shared by the audio-spatial-*.spec.ts files (ADR 0162 E9): a 3D scene built for the M3 editor work, opened as a
// writable in-memory copy of the Flappy sample (its music clips, its project folder) with `scenes/main.scene.json`
// replaced.
import { expect, openTestProject, type Page } from "./fixtures";

type Comp = { type: string; data?: Record<string, unknown> };
const node = (id: string, name: string, position: number[], components: Comp[], extra: Record<string, unknown> = {}) => ({
  id,
  name,
  components: [{ type: "engine.Transform", data: { position } }, ...components],
  ...extra,
});

/**
 * A camera looking along the scene, a listener at the far left, a box zone, an emitter at the far right with a wall (a collider with an occluder) between it and the listener, a bare occluder
 * (no collider), and an occluder over a child occluder with a collider (the overlap warning).
 */
export const SPATIAL_SCENE = {
  format: "myco.scene@2",
  settings: { physics: "3d" },
  nodes: [
    node("camera", "Camera", [0, 3, 14], [{ type: "engine.Camera", data: { projection: "perspective", fieldOfView: 55 } }]),
    node("ears", "Ears", [-8, 1, 0], [{ type: "engine.AudioListener", data: {} }]),
    node("zone", "Zone", [0, 1, 0], [{ type: "engine.AudioReverbZone", data: { shape: "box", size: [10, 4, 10], blendDistance: 2, wet: 0.5 } }]),
    node("wall", "Wall", [4, 1, 0], [{ type: "engine.BoxCollider", data: { size: [0.5, 4, 6] } }, { type: "engine.AudioOccluder", data: {} }]),
    node("emitter", "Emitter", [8, 1, 0], [{ type: "engine.AudioSource", data: { clip: "asset:music/foo.mp3", loop: true, volume: 0.3, playOnAwake: true, spatial: true } }]),
    node("bare", "Bare", [-6, 1, 0], [{ type: "engine.AudioOccluder", data: {} }]),
    node("outer", "Outer", [-6, 1, 6], [{ type: "engine.AudioOccluder", data: {} }]),
    node("inner", "Inner", [0, 0, 1], [{ type: "engine.BoxCollider", data: {} }, { type: "engine.AudioOccluder", data: {} }], { parent: "outer" }),
  ],
};

/** The editor's debug hooks (session.ts). */
export type SpatialHooks = {
  orbit: { focus(point?: [number, number, number], distance?: number): void };
  overlayHandles?: () => { id: string; x: number; y: number }[];
  testFolder: { read(path: string): string | undefined };
};

/** Open the spatial scene in a writable project (a wide window: the Inspector sits in the right dock). */
export async function openSpatial(page: Page, extra: Record<string, string> = {}): Promise<void> {
  await page.setViewportSize({ width: 1600, height: 1000 });
  await openTestProject(page, { "scenes/main.scene.json": JSON.stringify(SPATIAL_SCENE), ...extra });
  await expect(page.locator('.tree .row[data-key="zone"]')).toBeVisible();
}

export const row = (page: Page, key: string) => page.locator(`.tree .row[data-key="${key}"]`);
export const inspector = (page: Page) => page.locator(".panel.inspector");
