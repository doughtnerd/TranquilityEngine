// Dk1: the ducking rule's editing model and the gain-reduction model. Timing never enters: every case is a pure function of
// its inputs (no clock, no backend).
import { describe, expect, it } from "vitest";
import { NEEDS_AUDIO_CORE as BABYLON_NEEDS_CORE } from "../../runtime/babylonBackend";
import { parseAudioSettings, type AudioSettings, type DuckingRule } from "../../../../engine/audio/settings";
import {
  DUCK_DEFAULTS,
  DUCK_LIMITS,
  NEEDS_AUDIO_CORE,
  buildDuckRows,
  duckRefusal,
  formatReduction,
  gainReductionDb,
  levelDuckingAvailable,
  levelRuleCount,
  newDuckRule,
  ruleWithField,
  ruleWithMode,
  type DuckBusReading,
} from "./duckModel";

const settings = (ducking: object[], buses?: object[]): AudioSettings => parseAudioSettings({ ...(buses ? { buses } : {}), ducking }).settings;
const level = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "level", ...over });
const presence = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "presence", ...over });

describe("a new rule", () => {
  it("is a level rule with an RMS detector at -30 dBFS (owner decision 8)", () => {
    expect(newDuckRule("Music", "Voice")).toEqual({ target: "Music", trigger: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.1, release: 0.5 });
  });
  it("can be a presence rule, which carries no detector or threshold", () => {
    const r = newDuckRule("Music", "Voice", "presence");
    expect(r).toEqual({ target: "Music", trigger: "Voice", mode: "presence", ...DUCK_DEFAULTS });
    expect("detector" in r || "threshold" in r).toBe(false);
  });
  it("is kept whole by the parse, with no problem", () => {
    const parsed = parseAudioSettings({ ducking: [newDuckRule("Music", "Voice")] });
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings.ducking[0]).toEqual(newDuckRule("Music", "Voice"));
  });
});

describe("the mode switch", () => {
  it("presence to level takes the defaults", () => {
    const r = ruleWithMode(newDuckRule("Music", "Voice", "presence"), "level");
    expect(r).toMatchObject({ mode: "level", detector: "rms", threshold: -30 });
  });
  it("level to presence drops detector and threshold, so the parse has nothing to report", () => {
    const r = ruleWithMode(newDuckRule("Music", "Voice"), "presence");
    expect("detector" in r || "threshold" in r).toBe(false);
    expect(parseAudioSettings({ ducking: [r] }).problems).toEqual([]);
  });
  it("level to level and presence to presence keep the rule as it is", () => {
    const lv: DuckingRule = { ...newDuckRule("Music", "Voice"), detector: "peak", threshold: -12 };
    expect(ruleWithMode(lv, "level")).toEqual(lv);
    const pr = newDuckRule("Music", "Voice", "presence");
    expect(ruleWithMode(pr, "presence")).toEqual(pr);
  });
  it("a round trip back to level keeps nothing of the old values (they were dropped)", () => {
    const lv: DuckingRule = { ...newDuckRule("Music", "Voice"), detector: "peak", threshold: -12 };
    expect(ruleWithMode(ruleWithMode(lv, "presence"), "level")).toMatchObject({ detector: "rms", threshold: -30 });
  });
});

describe("a field edit", () => {
  const lv = newDuckRule("Music", "Voice");
  const pr = newDuckRule("Music", "Voice", "presence");
  it("detector: peak and rms on a level rule; ignored on a presence rule", () => {
    expect(ruleWithField(lv, "detector", "peak").detector).toBe("peak");
    expect(ruleWithField({ ...lv, detector: "peak" }, "detector", "rms").detector).toBe("rms");
    expect(ruleWithField(pr, "detector", "peak")).toBe(pr);
    expect(ruleWithField(lv, "detector", "median")).toBe(lv);
  });
  it("threshold: the minimum, the maximum and the typical value; clamped outside; ignored on presence", () => {
    expect(ruleWithField(lv, "threshold", DUCK_LIMITS.threshold[0]).threshold).toBe(-80);
    expect(ruleWithField(lv, "threshold", DUCK_LIMITS.threshold[1]).threshold).toBe(0);
    expect(ruleWithField({ ...lv, threshold: -6 }, "threshold", -30).threshold).toBe(-30);
    expect(ruleWithField(lv, "threshold", -120).threshold).toBe(-80);
    expect(ruleWithField(lv, "threshold", 12).threshold).toBe(0);
    expect(ruleWithField(lv, "threshold", Number.NaN)).toBe(lv);
    expect(ruleWithField(pr, "threshold", -20)).toBe(pr);
  });
  it("amount, attack and release: both limits and a typical value, clamped outside", () => {
    expect(ruleWithField(lv, "amount", 0).amount).toBe(0);
    expect(ruleWithField(lv, "amount", 1).amount).toBe(1);
    expect(ruleWithField(lv, "amount", 0.25).amount).toBe(0.25);
    expect(ruleWithField(lv, "amount", 3).amount).toBe(1);
    expect(ruleWithField(lv, "attack", 0).attack).toBe(0);
    expect(ruleWithField(lv, "attack", 10).attack).toBe(10);
    expect(ruleWithField(lv, "attack", 99).attack).toBe(10);
    expect(ruleWithField(lv, "attack", -1).attack).toBe(0);
    expect(ruleWithField(lv, "release", 0).release).toBe(0);
    expect(ruleWithField(lv, "release", 10).release).toBe(10);
    expect(ruleWithField(lv, "release", 0.8).release).toBe(0.8);
    expect(ruleWithField(pr, "amount", 0.7).amount).toBe(0.7);
  });
  it("target and trigger take a name; mode goes through the mode switch", () => {
    expect(ruleWithField(lv, "target", "SFX").target).toBe("SFX");
    expect(ruleWithField(lv, "trigger", "UI").trigger).toBe("UI");
    expect(ruleWithField(lv, "mode", "presence").mode).toBe("presence");
    expect(ruleWithField(pr, "mode", "level")).toMatchObject({ mode: "level", detector: "rms", threshold: -30 });
    expect(ruleWithField(lv, "mode", "other")).toBe(lv);
  });
});

describe("duckRefusal: the settings parse's own words", () => {
  const base = settings([level("Music", "Voice"), level("SFX", "Music")]);
  it("accepts a rule list the parse keeps whole", () => {
    expect(duckRefusal(base, base.ducking)).toBeNull();
    expect(duckRefusal(base, [])).toBeNull();
  });
  it("a rule that closes a two-rule level cycle names both rules and the buses", () => {
    const msg = duckRefusal(base, [base.ducking[0]!, newDuckRule("Voice", "Music")])!;
    expect(msg).toContain("level rules can't form a cycle");
    expect(msg).toContain("ducking[0] (Voice ducks Music)");
    expect(msg).toContain("ducking[1] (Music ducks Voice)");
  });
  it("a rule that closes a three-rule cycle names all three", () => {
    const msg = duckRefusal(base, [...base.ducking, newDuckRule("Voice", "SFX")])!;
    expect(msg).toContain("ducking[0] (Voice ducks Music)");
    expect(msg).toContain("ducking[1] (Music ducks SFX)");
    expect(msg).toContain("ducking[2] (SFX ducks Voice)");
  });
  it("a presence rule adds no edge, so the same pair as presence is kept", () => {
    expect(duckRefusal(base, [base.ducking[0]!, newDuckRule("Voice", "Music", "presence")])).toBeNull();
  });
  it("the 9th level rule is refused, the 8th is not", () => {
    const eight = Array.from({ length: 8 }, () => newDuckRule("Music", "Voice"));
    expect(duckRefusal(base, eight)).toBeNull();
    expect(duckRefusal(base, [...eight, newDuckRule("Music", "Voice")])).toContain("at most 8 level rules");
  });
  it("nine presence rules are fine; the 33rd rule is refused", () => {
    const rules = (n: number) => Array.from({ length: n }, () => newDuckRule("Music", "Voice", "presence"));
    expect(duckRefusal(base, rules(32))).toBeNull();
    expect(duckRefusal(base, rules(33))).toContain("at most 32 rules");
  });
  it("a bus ducking itself and a trigger above its target are refused", () => {
    expect(duckRefusal(base, [newDuckRule("Music", "Music")])).toContain("can't duck itself");
    expect(duckRefusal(base, [newDuckRule("Music", "Master")])).toContain("Master is above Music");
  });
  it("a problem the section already had doesn't count against the next edit", () => {
    const withProblem = { ...base, music: { ...base.music, rings: 9999 } } as AudioSettings;
    expect(duckRefusal(withProblem, withProblem.ducking)).toBeNull();
  });
});

describe("levelRuleCount and levelDuckingAvailable", () => {
  it("counts the level rules", () => {
    expect(levelRuleCount(settings([level("Music", "Voice"), presence("SFX", "Voice"), level("UI", "Voice")]).ducking)).toBe(2);
  });
  it("the Babylon setting has no level ducking; core does; a playing backend's mixCaps wins", () => {
    expect(levelDuckingAvailable("core")).toBe(true);
    expect(levelDuckingAvailable("babylon")).toBe(false);
    expect(levelDuckingAvailable("core", { levelDucking: false })).toBe(false); // the core failed to start: Babylon plays
    expect(levelDuckingAvailable("babylon", { levelDucking: true })).toBe(true);
  });
  it("the message is the one the Babylon backend gives", () => {
    expect(NEEDS_AUDIO_CORE).toBe("Needs the audio core");
    expect(NEEDS_AUDIO_CORE).toBe(BABYLON_NEEDS_CORE);
  });
});

describe("gain reduction", () => {
  it("is 0 for a gain of 1 and for nonsense, -20 log10 otherwise, 99 for silence", () => {
    expect(gainReductionDb(1)).toBe(0);
    expect(gainReductionDb(1.5)).toBe(0);
    expect(gainReductionDb(Number.NaN)).toBe(0);
    expect(gainReductionDb(0.5)).toBeCloseTo(6.0206, 4);
    expect(gainReductionDb(0.4)).toBeCloseTo(7.9588, 4);
    expect(gainReductionDb(0)).toBe(99);
    expect(gainReductionDb(1e-9)).toBe(99);
  });
  it("is shown with one decimal", () => {
    expect(formatReduction(gainReductionDb(0.5))).toBe("-6.0 dB");
    expect(formatReduction(0)).toBe("0.0 dB");
    expect(formatReduction(0.04)).toBe("0.0 dB");
  });
});

describe("buildDuckRows", () => {
  const a = settings([level("Music", "Voice", { amount: 0.5, threshold: -20 }), presence("Music", "SFX", { amount: 0.3 }), level("UI", "Voice")]);
  const live = (over: Record<string, Partial<DuckBusReading>>) => (name: string): DuckBusReading | null => ({ duckGain: 1, activeVoices: 0, ...(over[name] ?? {}) });

  it("one row per target bus in order of first appearance, at rest while not playing", () => {
    const rows = buildDuckRows(a);
    expect(rows.map((r) => r.bus)).toEqual(["Music", "UI"]);
    expect(rows[0]).toMatchObject({ gain: 1, reductionDb: 0, reducing: false, lead: null, levelDucked: true });
    expect(rows[0]!.rules.map((r) => [r.index, r.trigger, r.mode, r.engaged, r.needsCore])).toEqual([[0, "Voice", "level", false, false], [1, "SFX", "presence", false, false]]);
  });
  it("reads the duck gain and the reduction in dB from the bus", () => {
    const rows = buildDuckRows(a, live({ Music: { duckGain: 0.5 } }));
    expect(rows[0]!.gain).toBe(0.5);
    expect(rows[0]!.reductionDb).toBeCloseTo(6.0206, 4);
    expect(rows[0]!.reducing).toBe(true);
    expect(rows[1]!.reducing).toBe(false);
  });
  it("the lead is the engaged rule heading lowest: a presence trigger with voices", () => {
    const rows = buildDuckRows(a, live({ Music: { duckGain: 0.3 }, SFX: { activeVoices: 2 }, Voice: { levelDb: -40 } }));
    expect(rows[0]).toMatchObject({ lead: 1, leadEngaged: true });
    expect(rows[0]!.rules.map((r) => r.engaged)).toEqual([false, true]);
  });
  it("a level trigger is engaged at or over its threshold, not under it", () => {
    const at = buildDuckRows(a, live({ Music: { duckGain: 0.5 }, Voice: { levelDb: -20 } }));
    expect(at[0]!.rules[0]!.engaged).toBe(true);
    expect(at[0]).toMatchObject({ lead: 0, leadEngaged: true });
    const under = buildDuckRows(a, live({ Music: { duckGain: 0.5 }, Voice: { levelDb: -20.1 } }));
    expect(under[0]!.rules[0]!.engaged).toBe(false);
    const silent = buildDuckRows(a, live({ Voice: {} }));
    expect(silent[0]!.rules[0]!.engaged).toBe(false);
  });
  it("two rules engaged: the one heading lowest leads; a tie goes to the first", () => {
    const both = buildDuckRows(a, live({ Music: { duckGain: 0.3 }, SFX: { activeVoices: 1 }, Voice: { levelDb: -10 } }));
    expect(both[0]).toMatchObject({ lead: 1, leadEngaged: true }); // 0.3 under 0.5
    const tie = buildDuckRows(settings([level("Music", "Voice", { amount: 0.4 }), presence("Music", "SFX", { amount: 0.4 })]), live({ Music: { duckGain: 0.4 }, SFX: { activeVoices: 1 }, Voice: { levelDb: -5 } }));
    expect(tie[0]!.lead).toBe(0);
  });
  it("in a release tail (reducing, nothing engaged) the lead is the rule heading lowest, marked not engaged", () => {
    const tail = buildDuckRows(a, live({ Music: { duckGain: 0.8 } }));
    expect(tail[0]).toMatchObject({ reducing: true, lead: 1, leadEngaged: false });
  });
  it("not reducing: no lead, even with a trigger engaged", () => {
    const rows = buildDuckRows(a, live({ SFX: { activeVoices: 1 } }));
    expect(rows[0]).toMatchObject({ reducing: false, lead: null });
  });
  it("on a backend without level ducking a level rule needs the core and never leads", () => {
    const rows = buildDuckRows(a, live({ Music: { duckGain: 0.5 }, Voice: { levelDb: -5 }, SFX: { activeVoices: 1 } }), false);
    expect(rows[0]!.rules.map((r) => [r.mode, r.needsCore, r.engaged])).toEqual([["level", true, false], ["presence", false, true]]);
    expect(rows[0]!.lead).toBe(1);
    expect(rows[1]!.rules[0]).toMatchObject({ needsCore: true });
    expect(rows[1]!.lead).toBeNull();
    expect(rows[1]!.levelDucked).toBe(true);
  });
  it("a presence-only bus is not level-ducked", () => {
    const rows = buildDuckRows(settings([presence("Music", "Voice")]));
    expect(rows[0]!.levelDucked).toBe(false);
  });
  it("a gain outside 0..1 reads as not ducked", () => {
    const rows = buildDuckRows(a, live({ Music: { duckGain: Number.NaN } }));
    expect(rows[0]).toMatchObject({ gain: 1, reducing: false });
  });
});
