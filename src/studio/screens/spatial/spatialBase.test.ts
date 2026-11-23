// ADR 0347: the base game scene's layer on the Spatial screen's plan: shapes and labels for each imported object, their
// height spans, Fit framing them, and the banner (which scene is underneath, or that it is missing).
import { describe, expect, it } from "vitest";
import { baseBanner, baseFramePoints, basePlanItems } from "./baseLayer";
import { FIXTURE_BASE_PATH, fixtureBase, fixtureScene, fixtureVoices } from "./spatialFixture";
import { baseObjectOf, baseSoundId, baseSoundRefs, rayEnd, voiceTable } from "./voicesTable";
import type { TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";

describe("the base scene's plan layer", () => {
  it("draws boxes, circles and points with labels, biggest shapes first", () => {
    const items = basePlanItems(fixtureBase());
    expect(items.map((i) => [i.kind, i.label, i.shape.kind])).toEqual([
      ["reverbZone", "Courtyard · room", "circle"],
      ["audioZone", "Fountain", "box"],
      ["collider", "North wall · stone", "box"],
      ["collider", "Pillar · stone", "circle"],
      ["emitter", "Well", "point"],
    ]);
    const wall = items.find((i) => i.label.startsWith("North wall"))!;
    expect(wall.shape.kind === "box" && wall.shape.corners).toEqual([{ x: 34, z: 35.5 }, { x: 46, z: 35.5 }, { x: 46, z: 36.5 }, { x: 34, z: 36.5 }]);
    expect([wall.low, wall.high]).toEqual([0, 5]);
    const pillar = items.find((i) => i.label.startsWith("Pillar"))!;
    expect(pillar.shape).toEqual({ kind: "circle", center: { x: 36, z: 30 }, radius: 0.8 });
    expect(basePlanItems(null)).toEqual([]);
  });

  it("frames the base's objects for Fit", () => {
    const pts = baseFramePoints(fixtureBase());
    expect(Math.min(...pts.map((p) => p.x))).toBe(8); // the fountain's west edge
    expect(Math.max(...pts.map((p) => p.x))).toBe(58); // the well
    expect(baseFramePoints(null)).toEqual([]);
  });

  it("says which game scene is underneath, or that it's missing", () => {
    expect(baseBanner(null)).toBeNull();
    expect(baseBanner(fixtureBase())).toEqual({ text: "Over canyon: 5 objects, read-only", warning: false });
    expect(baseBanner(fixtureBase(null))).toEqual({ text: "Base scene scenes/gone.scene.json is missing; playing without it", warning: true });
    expect(fixtureBase().path).toBe(FIXTURE_BASE_PATH);
  });
});

describe("the base scene's sounds in the Voices table and the rays (D43)", () => {
  const base = fixtureBase();
  const key = (name: string) => base.objects.find((o) => o.name === name)!.key;

  it("the player reads the base's active emitters and audio zones by their replace keys", () => {
    expect(baseSoundRefs(base)).toEqual([
      { id: baseSoundId(key("Well")), path: "Well/AudioSource" },
      { id: baseSoundId(key("Fountain")), path: "Fountain/AudioZone" },
    ]);
    expect(baseSoundRefs(null)).toEqual([]);
  });

  it("base rows follow the scene's, named by their nodes and marked base; never silenced by the audition", () => {
    const well: TestSceneVoiceRow = { id: baseSoundId(key("Well")), kind: "emitter", playing: true, rendered: "hrtf", distance: 15.7, occlusion: { gain: 1, cutoffHz: null, material: null }, doppler: 1, dopplerCents: 0 };
    const rows = voiceTable(fixtureScene(), [...fixtureVoices(), well], () => true, { base });
    const last = rows.at(-1)!;
    expect(last).toMatchObject({ name: "Well", base: true, silenced: false, renderedText: "HRTF", distanceText: "15.7 m" });
    expect(rows[0]).toMatchObject({ name: "Waterfall", base: false, silenced: true });
    expect(baseObjectOf(base, last.id)?.name).toBe("Well");
    expect(baseObjectOf(base, "emitter1")).toBeNull();
  });

  it("a ray ends at a base emitter's place, a base zone's nearest point, and a moving emitter where it is now", () => {
    const s = fixtureScene();
    const listener = s.listeners[0]!.position; // (50, 1.7, 35)
    expect(rayEnd(s, baseSoundId(key("Well")), listener, [], base)).toMatchObject({ x: 58, z: 22 });
    const zone = rayEnd(s, baseSoundId(key("Fountain")), listener, [], base)!;
    expect(zone.x).toBeCloseTo(16, 6); // the 8 m box around (12, 28): its east edge, the listener's z clamped to its north edge
    expect(zone.z).toBeCloseTo(32, 6);
    const now = [{ id: "emitter4", position: { x: 70, y: 9, z: 44 }, direction: { x: 1, y: 0, z: 0 }, speed: 12 }];
    expect(rayEnd(s, "emitter4", listener, now, base)).toMatchObject({ x: 70, z: 44 });
    expect(rayEnd(s, "emitter4", listener, [], base)).not.toMatchObject({ x: 70, z: 44 }); // stopped: its start on the route
    expect(rayEnd(s, "base:nothing", listener, [], base)).toBeNull();
  });

  it("a moving emitter's distance is read from where it is now while the scene plays", () => {
    const now = [{ id: "emitter4", position: { x: 50, y: 1.7, z: 45 }, direction: null, speed: 0 }];
    const rows = voiceTable(fixtureScene(), fixtureVoices(), undefined, { motion: now });
    expect(rows.find((r) => r.id === "emitter4")!.distanceText).toBe("10.0 m");
    expect(voiceTable(fixtureScene(), fixtureVoices()).find((r) => r.id === "emitter4")!.distanceText).toBe("48.2 m"); // the readout's
  });
});
