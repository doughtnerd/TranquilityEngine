// Dk1: the ducking rule's editing model and the gain-reduction model. Timing never enters: every case is a pure function of
// its inputs (no clock, no backend).
import { describe, expect, it } from "vitest";
import { reasonMessage } from "../../../../engine/audio/busCapability";
import { parseAudioSettings, type AudioSettings, type DuckingMode, type DuckingRule } from "../../../../engine/audio/settings";
import { DUCK_LIMITS, NEEDS_AUDIO_CORE, duckRefusal, gainReductionDb, levelDuckingAvailable, newDuckRule, ruleWithField } from "./duckModel";

// A new rule's numbers.
const DUCK_DEFAULTS = { amount: 0.4, attack: 0.1, release: 0.5 } as const;

const settings = (ducking: object[], buses?: object[]): AudioSettings => parseAudioSettings({ ...(buses ? { buses } : {}), ducking }).settings;
const level = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "level", ...over });

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
  /** Switch a rule's mode as the section's mode control does. */
  const ruleWithMode = (rule: DuckingRule, mode: DuckingMode): DuckingRule => ruleWithField(rule, "mode", mode);
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

describe("levelDuckingAvailable", () => {
  it("the Babylon setting has no level ducking; core does; a playing backend's mixCaps wins", () => {
    expect(levelDuckingAvailable("core")).toBe(true);
    expect(levelDuckingAvailable("babylon")).toBe(false);
    expect(levelDuckingAvailable("core", { levelDucking: false })).toBe(false); // the core failed to start: Babylon plays
    expect(levelDuckingAvailable("babylon", { levelDucking: true })).toBe(true);
  });
  it("the message is the needsAudioCore reason's (the Mixer answers it on the Babylon fallback)", () => {
    expect(NEEDS_AUDIO_CORE).toBe("Needs the audio core");
    expect(NEEDS_AUDIO_CORE).toBe(reasonMessage("needsAudioCore"));
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
  });
});

