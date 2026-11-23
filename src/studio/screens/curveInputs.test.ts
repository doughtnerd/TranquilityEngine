import { describe, expect, it } from "vitest";
import type { ParameterDef } from "../../engine/audio/parameters";
import { parameterInputs, setParameterHistogramSource, setParameterNowSource } from "./curveInputs";

const defs = [{ name: "speed", min: 0, max: 100, default: 0 }, { name: "rpm", min: 0, max: 1, default: 0 }] as unknown as ParameterDef[];

describe("game parameters as curve inputs", () => {
  it("gives each input its own histogram while a take provides one", () => {
    const stop = setParameterHistogramSource((name) => (name === "rpm" ? [1, 2, 3] : name === "speed" ? [4, 5] : null));
    try {
      const [speed, rpm] = parameterInputs(defs);
      expect(speed!.histogram).toEqual([4, 5]);
      expect(rpm!.histogram).toEqual([1, 2, 3]);
    } finally {
      stop();
    }
    expect(parameterInputs(defs)[0]!.histogram).toBeUndefined();
  });

  it("reads the game's value as the take replays (Game now), and nothing without a take", () => {
    expect(parameterInputs(defs)[0]!.live).toBeUndefined();
    let at = 12;
    const stop = setParameterNowSource((name) => (name === "speed" ? at : null));
    try {
      const [speed, rpm] = parameterInputs(defs, { speed: 50 });
      expect(speed!.now).toBe(50);
      expect(speed!.live!()).toBe(12);
      at = 40;
      expect(speed!.live!()).toBe(40);
      expect(rpm!.live!()).toBeUndefined();
    } finally {
      stop();
    }
  });
});
