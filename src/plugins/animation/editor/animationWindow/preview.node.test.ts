// T50 (ADR 0373): the Animation window's preview plays the clip being edited, from its source, on the bound Animator
// through the runtime (raw clip, binding table), in a headless editor Engine's Editor World, at the playhead. Time comes
// from the playhead and `engine.step(0)` only (no time passes). The clip's float track is linear, so the value at the
// playhead is exact up to the raw clip's f32 samples at 30 Hz (1e-4).
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Animator, Assets, Engine, GameObject, Light } from "../../../../myco";
import { emptyAnimSource, type AnimSource } from "../../../../engine/animation/animSource";
import { ClipPreviewPlayer } from "./previewLogic";

let engine: Engine;
const lampClip = (to: number): AnimSource => ({
  ...emptyAnimSource(),
  duration: 1,
  tracks: [{ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [1, to]]] }],
});

beforeAll(async () => {
  Assets.clearSources();
  engine = await Engine.create({ headless: true, kind: "editor" });
});
afterAll(() => engine?.dispose());

describe("the Animation window's preview (ADR 0373)", () => {
  it("evaluates the source clip at the playhead in the Editor World, and an edited version once it changes", async () => {
    expect(engine.world.kind).toBe("editor");
    const hero = GameObject.create("Hero");
    const anim = hero.addComponent(Animator);
    const lamp = GameObject.create("Lamp", { parent: hero }).addComponent(Light, { intensity: 9 });
    const preview = new ClipPreviewPlayer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = lampClip(2);
    preview.show(anim, first, 0.5, "animation/lamp.anim.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(1, 4);
    });
    // Scrubbing shows another time of the same version.
    preview.show(anim, first, 0.25, "animation/lamp.anim.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(0.5, 4);
    });
    // An edit is a new clip value: the next show plays it.
    const edited = lampClip(4);
    preview.show(anim, edited, 0.25, "animation/lamp.anim.json");
    expect(preview.pathOf(edited)).not.toBe(preview.pathOf(first));
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(1, 4);
    });
    // No time passes while previewing (speed 0).
    engine.step(0.5);
    expect(lamp.intensity).toBeCloseTo(1, 4);

    preview.stop(anim);
    preview.dispose();
    warn.mockRestore();
    GameObject.destroy(hero);
  });
});
