import { describe, expect, it } from "vitest";
import { modeOf, predictModes, rowMode } from "./renderModes";
import { fixtureScene, fixtureVoices } from "./spatialFixture";

describe("how each emitter is drawn before Play", () => {
  const scene = fixtureScene();

  it("folds emitters past the bed distance into the bed, gives the nearest N HRTF and pans the rest", () => {
    const m = predictModes(scene, { hrtf: 2, bedBeyond: 45 });
    // The drone (≈13 m away at its start) and the campfire (≈24 m) are nearest; the generator (≈35 m) is panned; the
    // waterfall high on the cliff (≈51 m) is past 45 m.
    expect(Object.fromEntries(m)).toEqual({ emitter4: "hrtf", emitter3: "hrtf", emitter2: "panned", emitter1: "bed" });
  });

  it("has no bed by distance when the project turns it off, and HRTF for none at 0", () => {
    expect(predictModes(scene, { hrtf: 8, bedBeyond: null }).get("emitter1")).toBe("hrtf");
    expect([...predictModes(scene, { hrtf: 0, bedBeyond: null }).values()].every((v) => v === "panned")).toBe(true);
  });

  it("follows the listening player", () => {
    const s = { ...scene, activeListener: "listener2" };
    // Player 2 stands beside the generator in the cave.
    expect(predictModes(s, { hrtf: 1, bedBeyond: null }).get("emitter2")).toBe("hrtf");
  });

  it("uses the runtime's rows while playing, the prediction when stopped", () => {
    const rows = fixtureVoices();
    const predicted = predictModes(scene, { hrtf: 2, bedBeyond: 45 });
    expect(modeOf("emitter1", true, rows, predicted)).toBe("hrtf");
    expect(modeOf("emitter1", false, rows, predicted)).toBe("bed");
    expect(rowMode({ ...rows[0]!, playing: false })).toBeNull();
    expect(rowMode(rows.find((r) => r.id === "zone2"))).toBe("bed");
    expect(rowMode(rows.find((r) => r.id === "sound1"))).toBeNull();
  });
});
