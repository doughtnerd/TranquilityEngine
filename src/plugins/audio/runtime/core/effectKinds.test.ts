import { describe, expect, it } from "vitest";
import { CORE_EFFECT_TYPES, MAX_CORE_BUS_EFFECTS, coreRuns } from "../../../../engine/audio/busCapability";
import { EFFECT_CATALOGUE } from "../../../../engine/audio/effects/catalogue";
import { BUS_FX_CATALOGUE, BUS_SLOT_MAX_EFFECTS, SUBMIX_EFFECTS_MAX, SUBMIX_FX_GAIN, SUBMIX_FX_REVERB } from "../wire.generated";
import { FX_KINDS, busFxType, fxKind, fxParams } from "./effectKinds";
import { wireEffect } from "./busIndex";

describe("effect kinds (ADR 0331, ABI 4.6)", () => {
  it("maps exactly the types the rule module says the core runs, each to its own kind", () => {
    expect(Object.keys(FX_KINDS).sort()).toEqual([...CORE_EFFECT_TYPES].sort());
    const kinds = Object.values(FX_KINDS);
    expect(new Set(kinds).size).toBe(kinds.length);
    expect(Math.min(...kinds)).toBeGreaterThan(0);
    expect(Math.max(...kinds)).toBe(SUBMIX_FX_GAIN);
    for (const t of CORE_EFFECT_TYPES) expect(EFFECT_CATALOGUE[t].levels.some((l) => l === "bus" || l === "instance" || l === "voice"), t).toBe(true);
    expect(fxKind("envelope")).toBe(0);
    expect(coreRuns("reverse")).toBe(false);
  });

  it("holds the core's per-bus effect count equal to the rule module's", () => {
    expect(BUS_SLOT_MAX_EFFECTS).toBe(MAX_CORE_BUS_EFFECTS);
    expect(SUBMIX_EFFECTS_MAX).toBe(MAX_CORE_BUS_EFFECTS);
  });

  it("writes parameters in the catalogue's order with its defaults, and catalogue bus effects as BUS_FX_CATALOGUE + kind", () => {
    expect(fxParams("reverb", { decay: 4 }, 8)).toEqual([0.5, 4, 20, 0, 0, 0, 0, 0]);
    expect(busFxType("reverb")).toBe(BUS_FX_CATALOGUE + SUBMIX_FX_REVERB);
    expect(wireEffect({ type: "fx", fx: "delay", params: { time: 120 } })).toEqual({ type: busFxType("delay"), p: [120, 30, 25, 0, 0, 0, 0] });
    const slots: Record<string, number> = { Music: 3 };
    const sc = wireEffect({ type: "fx", fx: "sidechainCompressor", params: {}, key: "Music" }, (n) => slots[n] ?? -1);
    expect(sc.p.slice(0, 4)).toEqual([-24, 3, 300, 3]);
    expect(wireEffect({ type: "fx", fx: "sidechainCompressor", params: {}, key: "Nope" }, (n) => slots[n] ?? -1).p[3]).toBe(-1);
    expect(wireEffect({ type: "lowpass", frequency: 800, q: 1 })).toEqual({ type: 0, p: [800, 1, 0, 0, 0, 0, 0] });
  });
});
