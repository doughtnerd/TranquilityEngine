// ADR 0352 B2: a registered plugin effect reaches the Studio's effect chain through the catalogue alone: the Add effect
// menu lists it at its levels, adding it gives its defaults, edits clamp to its spec, and a card's summary reads it.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerPluginEffects, unregisterPluginEffects } from "../../engine/audio/effects/catalogue";
import { parsePluginAudio } from "../../engine/audio/effects/pluginEffects";
import { addEffect, effectMenu, effectSummary, setEffectParam } from "./effectChainModel";

const AUDIO = {
  modules: { dsp: { wasm: "dsp/tremolo.wasm" } },
  effects: [{
    type: "example.tremolo", module: "dsp", kind: 0, label: "Tremolo", levels: ["instance", "bus"],
    params: [
      { name: "rate", label: "Rate", min: 0.1, max: 20, step: 0.01, unit: "Hz", default: 5, scale: "log" },
      { name: "depth", label: "Depth", min: 0, max: 100, step: 1, unit: "%", default: 50 },
      { name: "shape", label: "Shape", choices: ["Sine", "Triangle", "Square"], default: 0 },
    ],
  }],
};

describe("a plugin effect in the effect chain", () => {
  beforeEach(() => {
    const problems: string[] = [];
    const audio = parsePluginAudio(AUDIO, { name: "example.tremolo", title: "Tremolo", version: "1.0.0" }, problems);
    expect(problems).toEqual([]);
    registerPluginEffects({ plugin: "example.tremolo", title: "Tremolo", version: "1.0.0", enabled: true, effects: audio.effects });
  });
  afterEach(() => unregisterPluginEffects("example.tremolo"));

  it("is listed where it may run, added with its defaults, and edited within its spec", () => {
    expect(effectMenu("bus")).toContainEqual({ type: "example.tremolo", label: "Tremolo" });
    expect(effectMenu("sample").some((i) => i.type === "example.tremolo")).toBe(false);
    const added = addEffect([], "example.tremolo", "bus");
    if (!("next" in added)) throw new Error(added.refused);
    expect(added.next[0]).toEqual({ id: "fx1", type: "example.tremolo", on: true, params: { rate: 5, depth: 50, shape: 0 } });
    expect(addEffect([], "example.tremolo", "sample")).toEqual({ refused: "Tremolo can't run on a sample (it runs at instance, bus)" });
    const set = setEffectParam(added.next, "fx1", "shape", 7);
    if (!("next" in set)) throw new Error(set.refused);
    expect(set.next[0]!.params.shape).toBe(2);
    expect(effectSummary({ ...added.next[0]!, params: { rate: 6, depth: 80, shape: 0 } })).toBe("6.00 Hz · 80 %");
  });
});
