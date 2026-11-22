// ADR 0329: the playlist runtime's pure models (accumulation, picks, switch rules, envelope, gate) through their interfaces.
import { describe, expect, it } from "vitest";
import { accumulate, rootProps, voiceControls } from "./accumulate";
import { adsrLevel, envelopeHoldMs, lerpAdsr } from "./envelope";
import { gateTrigger } from "./gate";
import { newPickState, pickEntry, pickRandom } from "./picks";
import { matchChangeRule } from "./switchRules";
import type { ChangeRule } from "./types";

describe("accumulate", () => {
  it("adds dB and semitones, takes the deepest non-zero pan, the lowest low-pass and the highest high-pass", () => {
    let p = accumulate(rootProps(), { gainDb: -3, pitchSt: 2, pan: -0.5, lowpass: 8000, highpass: 100 });
    p = accumulate(p, { gainDb: -3, pitchSt: -1, pan: 0, lowpass: 12000, highpass: 50 });
    expect(voiceControls(p)).toEqual({ gainDb: -6, pitchSt: 1, pan: -0.5, lowpass: 8000, highpass: 100 });
    p = accumulate(p, { pan: 0.25 });
    expect(p.pan).toBe(0.25);
  });

  it("an output override drops the parent's playlist effects, keeping its own and the levels", () => {
    const parent = accumulate(rootProps(), { gainDb: -2, fx: { gainDb: -6, lowpass: 1000 } });
    const child = accumulate(parent, { outputOverride: true, fx: { highpass: 200 } });
    expect(voiceControls(child)).toEqual({ gainDb: -2, pitchSt: 0, pan: 0, lowpass: 24000, highpass: 200 });
    expect(voiceControls(accumulate(parent, {}))).toMatchObject({ gainDb: -8, lowpass: 1000 });
  });
});

describe("picks", () => {
  it("avoid-repeat gives way rather than go silent; weight 0 alone plays nothing", () => {
    expect(pickRandom([1, 0], [0], 1, () => 0.5)).toBe(0);
    expect(pickRandom([0, 0], [], 0, () => 0.5)).toBe(-1);
    expect(pickRandom([0], [], 0, () => 0.5)).toBe(-1);
  });

  it("round robin wraps; a state persists across picks", () => {
    const s = newPickState();
    const q = { pick: "roundRobin" as const, avoidRepeat: 0 };
    expect([0, 1, 2, 3].map(() => pickEntry(q, [1, 1, 1], s, Math.random))).toEqual([0, 1, 2, 0]);
  });
});

describe("switch rules", () => {
  const rule = (from: string, to: string, ms: number): ChangeRule => ({ from, to, when: "now", how: "crossfade", length: { ms } });

  it("exact = 2, any = 0 per side; the highest wins and the first breaks ties; no match is null", () => {
    const rules = [rule("*", "*", 1), rule("*", "B", 2), rule("A", "*", 3), rule("A", "B", 4)];
    expect(matchChangeRule(rules, "A", "B")?.length).toEqual({ ms: 4 });
    expect(matchChangeRule(rules, "C", "B")?.length).toEqual({ ms: 2 });
    expect(matchChangeRule(rules.slice(1, 3), "A", "B")?.length).toEqual({ ms: 2 }); // a tie: the first listed
    expect(matchChangeRule([rule("A", "B", 1)], "B", "A")).toBeNull();
  });
});

describe("envelope", () => {
  const e = { attackMs: 100, decayMs: 100, sustain: 0.5, releaseMs: 200 };
  it("attack, decay, sustain, then a linear release from the level held", () => {
    expect([0, 50, 100, 150, 400].map((ms) => adsrLevel(e, ms, null))).toEqual([0, 0.5, 1, 0.75, 0.5]);
    expect(adsrLevel(e, 50, 50)).toBe(0.5);
    expect(adsrLevel(e, 150, 50)).toBeCloseTo(0.25, 9); // released mid-attack at 0.5
    expect(adsrLevel(e, 250, 50)).toBe(0);
  });

  it("lerps low and high; holds for the longest one-shot, else max(500, A + D + 300)", () => {
    expect(lerpAdsr(e, { attackMs: 0, decayMs: 0, sustain: 1, releaseMs: 0 }, 0.5)).toEqual({ attackMs: 50, decayMs: 50, sustain: 0.75, releaseMs: 100 });
    expect(envelopeHoldMs(e, 1200)).toBe(1200);
    expect(envelopeHoldMs(e, null)).toBe(500);
    expect(envelopeHoldMs({ ...e, attackMs: 400 }, null)).toBe(800);
  });
});

describe("gate", () => {
  const rules = { cooldown: 0, chance: 1, maxInstances: 2, whenFull: "stealOldest" as const };
  const live = [{ ref: "a", startedAt: 1, loudness: 0.9, distance: 3 }, { ref: "b", startedAt: 2, loudness: 0.1, distance: 9 }];
  it("steals enough to make room by its rule", () => {
    expect(gateTrigger(rules, null, 0, Math.random, live)).toEqual({ ok: true, steal: ["a"] });
    expect(gateTrigger({ ...rules, whenFull: "stealQuietest" }, null, 0, Math.random, live)).toEqual({ ok: true, steal: ["b"] });
    expect(gateTrigger({ ...rules, whenFull: "stealFarthest" }, null, 0, Math.random, live)).toEqual({ ok: true, steal: ["b"] });
    expect(gateTrigger({ ...rules, maxInstances: 1 }, null, 0, Math.random, live)).toEqual({ ok: true, steal: ["a", "b"] });
    expect(gateTrigger({ ...rules, whenFull: "refuse" }, null, 0, Math.random, live)).toEqual({ ok: false, reason: "maxInstances" });
  });
  it("cooldown, then chance, then max instances, in that order", () => {
    expect(gateTrigger({ ...rules, cooldown: 1, chance: 0, whenFull: "refuse" }, 0, 0.5, Math.random, live)).toEqual({ ok: false, reason: "cooldown" });
    expect(gateTrigger({ ...rules, chance: 0, whenFull: "refuse" }, null, 0, Math.random, live)).toEqual({ ok: false, reason: "chance" });
  });
});
