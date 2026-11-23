// T53 (ADR 0373): the Timeline window's preview plays the timeline being edited, from its source, on the scene's
// TimelineDirector through the runtime (raw clip, binding table, subclip blocks), in a headless editor Engine's Editor World,
// at the playhead. Time comes from the playhead and `engine.step(0)` only. The curves are linear, so the value at the
// playhead is exact up to the raw clip's f32 samples at 30 Hz (1e-4); the crossfade is checked through two clips each
// holding one constant value, blending linearly over the overlap.
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Assets, Engine, GameObject, Light, TimelineDirector } from "../../../../myco";
import { emptyTimeline, type Timeline } from "../../../../engine/animation/timeline";
import type { Track } from "../../../../engine/animation/tracks";
import { splitItem } from "./timelineEditLogic";
import { TimelinePreviewPlayer } from "./timelinePreviewLogic";

let engine: Engine;
const lampTrack = (to: number): Track => ({ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, name: "", curves: [[[0, 0], [1, to]]] });
const rampTimeline = (to: number): Timeline => ({ ...emptyTimeline(), duration: 1, tracks: [lampTrack(to)] });
const constant = (v: number) => ({ format: "myco.timeline@1", duration: 4, tracks: [{ kind: "float", target: { nodePath: "Lamp", component: "engine.Light", field: "intensity" }, curves: [[[0, v]]] }] });

beforeAll(async () => {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "tl/one.timeline.json": constant(1), "tl/three.timeline.json": constant(3) }));
  engine = await Engine.create({ headless: true, kind: "editor" });
});
afterAll(() => engine?.dispose());

describe("the Timeline window's preview (ADR 0373)", () => {
  it("evaluates the source timeline at the playhead in the Editor World, and an edited version once it changes", async () => {
    expect(engine.world.kind).toBe("editor");
    const dir = GameObject.create("Dir");
    const director = dir.addComponent(TimelineDirector, { timeline: "", playOnStart: true, wrapMode: "loop" });
    const lamp = GameObject.create("Lamp", { parent: dir }).addComponent(Light, { intensity: 9 });
    const preview = new TimelinePreviewPlayer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    const first = rampTimeline(2);
    preview.show(director, first, 0.5, "animation/lamp.timeline.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(1, 4);
    });
    // The director plays the version in memory, held, and nothing plays on its own.
    expect(director.timeline).toBe(preview.pathOf(first));
    expect(director).toMatchObject({ playOnStart: false, wrapMode: "hold" });
    // Scrubbing shows another time of the same version.
    preview.show(director, first, 0.25, "animation/lamp.timeline.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(0.5, 4);
    });
    // An edit is a new timeline value: the next show plays it.
    const edited = rampTimeline(4);
    preview.show(director, edited, 0.25, "animation/lamp.timeline.json");
    expect(preview.pathOf(edited)).not.toBe(preview.pathOf(first));
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(1, 4);
    });
    // No time passes while previewing.
    engine.step(0.25);
    expect(lamp.intensity).toBeCloseTo(1, 4);

    // Leaving puts the director's own fields back.
    preview.stop(director);
    expect(director).toMatchObject({ timeline: "", playOnStart: true, wrapMode: "loop", playhead: 0 });
    preview.dispose();
    warn.mockRestore();
    GameObject.destroy(dir);
  });

  it("shows clips overlapping as a blend, and a split clip shows the same picture", async () => {
    const dir = GameObject.create("Dir2");
    const director = dir.addComponent(TimelineDirector, { timeline: "" });
    const lamp = GameObject.create("Lamp", { parent: dir }).addComponent(Light, { intensity: 9 });
    const preview = new TimelinePreviewPlayer();
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const clip = (time: number, end: number, name: string, extra = {}) => ({ time, end, clip: `asset:tl/${name}.timeline.json`, offset: 0, speed: 1, blendIn: 0, blendOut: 0, ...extra });
    // The first clip (value 1) runs 0..2 and eases out over 1 s; the second (value 3) runs 1..4 and eases in: they overlap from 1 to 2.
    const blended: Timeline = { ...emptyTimeline(), duration: 4, tracks: [{ kind: "subclip", target: { nodePath: "", component: "", field: "" }, keys: [clip(0, 2, "one", { blendOut: 1 }), clip(1, 4, "three", { blendIn: 1 })] }] };

    preview.show(director, blended, 1.5, "animation/fade.timeline.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(2, 3); // halfway through the crossfade: 1 and 3 weigh equally
    });
    preview.show(director, blended, 3, "animation/fade.timeline.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(3, 3);
    });
    // A split (an edit of the window's logic) shows the same picture: the halves play the same clip, the second from its offset.
    const split = (splitItem(blended, "0#1", 2.5) as { next: { timeline: Timeline } }).next.timeline;
    expect(split.tracks[0]).toMatchObject({ keys: [{ end: 2 }, { time: 1, end: 2.5, blendIn: 1 }, { time: 2.5, end: 4, offset: 1.5, blendIn: 0 }] });
    preview.show(director, split, 1.5, "animation/fade.timeline.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(2, 3);
    });
    preview.show(director, split, 3.25, "animation/fade.timeline.json");
    await vi.waitFor(() => {
      engine.step(0);
      expect(lamp.intensity).toBeCloseTo(3, 3);
    });

    preview.dispose();
    warn.mockRestore();
    GameObject.destroy(dir);
  });
});
