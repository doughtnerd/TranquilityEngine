// Dk1: the ducking edits the Audio section makes (`audioSettingsModel`'s `addDuckingEdit`, `setDuckingValueEdit`,
// `moveDucking`, `removeDucking`), each with each option (mode, detector, threshold, amount, attack, release, trigger,
// target, add, remove, reorder): the drafts they write parse back clean, numbers are clamped to their limits, and the
// refusals the parse makes (a bus ducking itself, a trigger above its target, a level cycle naming its rules, the 9th
// level rule, the 33rd rule) leave the draft as it was; then a live edit reaching a fake mixer through the op log. The
// section's controls, their options and "Needs the audio core" on a backend without level ducking are
// AudioSettingsSection.stories.tsx. No timers.
import { afterEach, describe, expect, it } from "vitest";
import { audioSection } from "../../../engine/audio/audioSection";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import { parseAudioSettings, type DuckingRule } from "../../../engine/audio/settings";
import { createProjectSettingsSection } from "../../../editor/projectSettingsSection";
import { closeTestProject, openTestProject, readDraft } from "../../../editor/testing";
import type { SettingsDraft } from "../../../editor/sdk";
import { addDuckingEdit, moveDucking, removeDucking, setDuckingValueEdit, type DuckEdit } from "./audioSettingsModel";
import { audioSettings } from "./audioDraft";
import { playState } from "../../../editor/state";
import { startOpLog, type MixApplier } from "./mix/opLog";
import { newDuckRule } from "./mix/duckModel";

/** Add a ducking rule as the section's button does (a refused add leaves the draft). */
const addDucking = (d: SettingsDraft): SettingsDraft => addDuckingEdit(d).draft;
/** Set one field of a rule as the section's controls do (a refused edit leaves the draft). */
const setDuckingValue = (d: SettingsDraft, index: number, key: keyof DuckingRule, value: string | number): SettingsDraft => setDuckingValueEdit(d, index, key, value).draft;

/** A draft whose audio section has these ducking rules (and these buses, else the default ones). */
const draftOf = (ducking: object[] = [], buses?: object[]): SettingsDraft => readDraft({ audio: { ...(buses ? { buses } : {}), ducking } }) as SettingsDraft;
const rulesOf = (d: SettingsDraft): DuckingRule[] => audioSettings.read(d).ducking;
/** The draft parses with no problem: the parse keeps every rule the edit wrote. */
const expectClean = (d: SettingsDraft): void => expect(audioSection(d.audio).problems).toEqual([]);
/** The edit was refused: the draft is the one it was given, and the refusal is the parse's message. */
function expectRefused(e: DuckEdit, d: SettingsDraft, message: string | RegExp): void {
  expect(e.draft).toBe(d);
  if (typeof message === "string") expect(e.refusal).toContain(message);
  else expect(e.refusal).toMatch(message);
}

const level = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "level", ...over });
const presence = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "presence", ...over });

describe("add: a new rule is a level rule, RMS, -30 dBFS", () => {
  it("the first rule added to a fresh project", () => {
    const e = addDuckingEdit(draftOf());
    expect(e.refusal).toBeNull();
    expect(rulesOf(e.draft)).toEqual([{ target: "Music", trigger: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.1, release: 0.5 }]);
    expectClean(e.draft);
  });
  it("each add appends another, in order", () => {
    let d = draftOf();
    for (let i = 0; i < 3; i++) d = addDucking(d);
    expect(rulesOf(d)).toHaveLength(3);
    expect(rulesOf(d).every((x) => x.mode === "level" && x.detector === "rms" && x.threshold === -30)).toBe(true);
    expectClean(d);
  });
  it("a project with two buses gets a pair the parse keeps (the child ducked by nothing above it)", () => {
    const d = addDucking(draftOf([], [{ name: "Master" }, { name: "Fx", parent: "Master" }]));
    expect(rulesOf(d)).toHaveLength(1);
    expect(rulesOf(d)[0]).toMatchObject({ target: "Master", trigger: "Fx", mode: "level" });
    expectClean(d);
  });
  it("is refused with fewer than two buses", () => {
    const d = draftOf([], [{ name: "Master" }]);
    expectRefused(addDuckingEdit(d), d, "A ducking rule needs two buses.");
  });
});

describe("mode", () => {
  it("presence to level adds the detector and threshold with the defaults", () => {
    const d = setDuckingValue(draftOf([presence("Music", "Voice")]), 0, "mode", "level");
    expect(rulesOf(d)[0]).toMatchObject({ mode: "level", detector: "rms", threshold: -30 });
    expectClean(d);
  });
  it("level to presence drops the detector and threshold", () => {
    const d = setDuckingValue(draftOf([level("Music", "Voice", { detector: "peak", threshold: -12 })]), 0, "mode", "presence");
    expect("detector" in rulesOf(d)[0]! || "threshold" in rulesOf(d)[0]!).toBe(false);
    expectClean(d);
  });
  it("choosing the mode a rule already has changes nothing", () => {
    const d = draftOf([level("Music", "Voice")]);
    const e = setDuckingValueEdit(d, 0, "mode", "level");
    expect(e.draft).toBe(d);
    expect(e.refusal).toBeNull();
  });
});

describe("detector and the numbers: each option, each limit, a typical value", () => {
  it("the detector is written as peak or rms", () => {
    let d = setDuckingValue(draftOf([level("Music", "Voice")]), 0, "detector", "peak");
    expect(rulesOf(d)[0]!.detector).toBe("peak");
    d = setDuckingValue(d, 0, "detector", "rms");
    expect(rulesOf(d)[0]!.detector).toBe("rms");
  });
  it.each([[-80, "the minimum"], [0, "the maximum"], [-30, "the typical value"], [-18, "a hot mix"]])("threshold %d dBFS (%s)", (n) => {
    const d = setDuckingValue(draftOf([level("Music", "Voice", { threshold: n === -30 ? -6 : -30 })]), 0, "threshold", n);
    expect(rulesOf(d)[0]!.threshold).toBe(n);
    expectClean(d);
  });
  it("a threshold outside -80..0 is clamped, not saved as it was typed", () => {
    const d = draftOf([level("Music", "Voice")]);
    expect(rulesOf(setDuckingValue(d, 0, "threshold", -200))[0]!.threshold).toBe(-80);
    expect(rulesOf(setDuckingValue(d, 0, "threshold", 20))[0]!.threshold).toBe(0);
    expectClean(setDuckingValue(d, 0, "threshold", -200));
  });
  it.each([["amount", 0], ["amount", 1], ["amount", 0.4], ["attack", 0], ["attack", 10], ["attack", 0.1], ["release", 0], ["release", 10], ["release", 0.5]] as const)("%s = %d", (key, n) => {
    const d = setDuckingValue(draftOf([level("Music", "Voice", { amount: 0.7, attack: 2, release: 3 })]), 0, key, n);
    expect(rulesOf(d)[0]![key]).toBe(n);
    expectClean(d);
  });
  it("the same fields on a presence rule", () => {
    let d = draftOf([presence("Music", "Voice")]);
    d = setDuckingValue(d, 0, "amount", 0.25);
    d = setDuckingValue(d, 0, "attack", 0.02);
    d = setDuckingValue(d, 0, "release", 1.5);
    expect(rulesOf(d)[0]).toMatchObject({ mode: "presence", amount: 0.25, attack: 0.02, release: 1.5 });
  });
  it("values past the limits are clamped to them", () => {
    let d = draftOf([level("Music", "Voice")]);
    d = setDuckingValue(d, 0, "amount", 2);
    d = setDuckingValue(d, 0, "attack", 50);
    d = setDuckingValue(d, 0, "release", -1);
    expect(rulesOf(d)[0]).toMatchObject({ amount: 1, attack: 10, release: 0 });
  });
});

describe("target and trigger", () => {
  it("each choice is written, on a level or a presence rule", () => {
    const e = setDuckingValueEdit(draftOf([level("Music", "Voice")]), 0, "target", "SFX");
    expect(e.refusal).toBeNull();
    const f = setDuckingValueEdit(e.draft, 0, "trigger", "UI");
    expect(f.refusal).toBeNull();
    expect(rulesOf(f.draft)[0]).toMatchObject({ target: "SFX", trigger: "UI" });
    expect(rulesOf(setDuckingValue(draftOf([presence("Music", "Voice")]), 0, "target", "UI"))[0]).toMatchObject({ mode: "presence", target: "UI" });
  });
  it("a bus can't duck itself: refused with the parse's message, the rule stays", () => {
    const d = draftOf([level("Music", "Voice")]);
    expectRefused(setDuckingValueEdit(d, 0, "trigger", "Music"), d, "a bus can't duck itself");
  });
  it("a trigger above its target is refused (its level can't be measured before the target mixes)", () => {
    const d = draftOf([level("Music", "Voice")]);
    expectRefused(setDuckingValueEdit(d, 0, "trigger", "Master"), d, "Master is above Music in the tree");
  });
});

describe("remove and reorder", () => {
  const three = () => draftOf([level("Music", "Voice"), presence("SFX", "Voice"), level("UI", "Voice", { threshold: -12 })]);
  it("remove drops that rule: the second, the first, the last", () => {
    expect(rulesOf(removeDucking(three(), 1)).map((x) => x.target)).toEqual(["Music", "UI"]);
    const d = removeDucking(three(), 0);
    expect(rulesOf(d).map((x) => x.target)).toEqual(["SFX", "UI"]);
    expect(rulesOf(removeDucking(d, 1)).map((x) => x.target)).toEqual(["SFX"]);
  });
  it("move down and move up swap neighbours, each rule moved whole", () => {
    let d = moveDucking(three(), 0, 1);
    expect(rulesOf(d).map((x) => x.target)).toEqual(["SFX", "Music", "UI"]);
    d = moveDucking(d, 2, -1);
    expect(rulesOf(d).map((x) => x.target)).toEqual(["SFX", "UI", "Music"]);
    expect(rulesOf(d).map((x) => x.mode)).toEqual(["presence", "level", "level"]);
    expectClean(d);
  });
  it("a move past the end changes nothing", () => {
    const d = three();
    expect(moveDucking(d, 0, -1)).toBe(d);
    expect(moveDucking(d, 2, 1)).toBe(d);
    expect(moveDucking(d, 5, 1)).toBe(d);
  });
});

describe("a rule that closes a level cycle is refused with the parse's message and isn't saved", () => {
  it("two rules: A ducks B and B ducks A", () => {
    const d = draftOf([level("Music", "Voice"), level("SFX", "Music")]);
    const e = setDuckingValueEdit(d, 1, "target", "Voice"); // rule 2 becomes: Music ducks Voice
    expectRefused(e, d, "level rules can't form a cycle");
    expect(e.refusal).toContain("ducking[0] (Voice ducks Music)");
    expect(e.refusal).toContain("ducking[1] (Music ducks Voice)");
    expectClean(d);
  });
  it("three rules: A to B to C to A names all three", () => {
    const d = draftOf([level("Music", "Voice"), level("SFX", "Music"), level("UI", "SFX")]);
    expectRefused(setDuckingValueEdit(d, 2, "target", "Voice"), d, /ducking\[0\] \(Voice ducks Music\).*ducking\[1\] \(Music ducks SFX\).*ducking\[2\] \(SFX ducks Voice\)/);
  });
  it("switching a presence rule to level refuses when that closes the cycle", () => {
    const d = draftOf([level("Music", "Voice"), presence("Voice", "Music")]);
    expectClean(d); // presence rules add no edge
    expectRefused(setDuckingValueEdit(d, 1, "mode", "level"), d, "ducking[1] (Music ducks Voice)");
  });
  it("the same pair as presence is accepted", () => {
    const d = setDuckingValue(draftOf([level("Music", "Voice"), level("SFX", "Music")]), 1, "mode", "presence");
    const e = setDuckingValueEdit(d, 1, "target", "Voice");
    expect(e.refusal).toBeNull();
    expect(rulesOf(e.draft)[1]).toMatchObject({ mode: "presence", target: "Voice", trigger: "Music" });
  });
});

describe("the limits", () => {
  const eightLevel = () => Array.from({ length: 8 }, () => level("Music", "Voice"));
  it("the 8th level rule is added; the 9th is refused with its message and isn't saved", () => {
    const e = addDuckingEdit(draftOf(eightLevel().slice(0, 7)));
    expect(e.refusal).toBeNull();
    expect(rulesOf(e.draft)).toHaveLength(8);
    expectRefused(addDuckingEdit(e.draft), e.draft, "at most 8 level rules");
  });
  it("a presence rule can't be switched to level as the 9th level rule", () => {
    const d = draftOf([...eightLevel(), presence("SFX", "Voice")]);
    expectRefused(setDuckingValueEdit(d, 8, "mode", "level"), d, "at most 8 level rules");
  });
  it("removing a level rule makes room again", () => {
    const e = addDuckingEdit(removeDucking(draftOf(eightLevel()), 0));
    expect(e.refusal).toBeNull();
    expect(rulesOf(e.draft)).toHaveLength(8);
  });
  it("the 33rd rule of either mode is refused", () => {
    const d = draftOf(Array.from({ length: 32 }, () => presence("Music", "Voice")));
    expectRefused(addDuckingEdit(d), d, "at most 32 rules");
  });
});

describe("the model functions are pure and agree with the parse", () => {
  it("every rule the editor writes parses back to itself", () => {
    let d = draftOf();
    d = addDucking(d);
    d = setDuckingValue(d, 0, "detector", "peak");
    d = setDuckingValue(d, 0, "threshold", -12);
    d = addDucking(d);
    d = setDuckingValue(d, 1, "mode", "presence");
    const written = (d.audio as { ducking: DuckingRule[] }).ducking;
    const parsed = parseAudioSettings(d.audio);
    expect(parsed.problems).toEqual([]);
    expect(parsed.settings.ducking).toEqual(written);
    expect(removeDucking(d, 0)).not.toBe(d);
    expect(newDuckRule("Music", "Voice").mode).toBe("level");
  });
});

// ---- a live edit during Play: the op log and a fake mixer ----

class FakeMixer implements MixApplier {
  applied: MixOp[] = [];
  apply(op: MixOp): ApplyResult {
    this.applied.push(op);
    return { ok: true, class: "direct" };
  }
}

const unsubs: Array<() => void> = [];
afterEach(() => {
  while (unsubs.length) unsubs.pop()!();
  closeTestProject();
});

async function playing(ducking: object[], isPlaying: () => boolean = () => true) {
  const { project } = await openTestProject({ "project.json": JSON.stringify({ name: "G", audio: { ducking } }) });
  const section = createProjectSettingsSection().open(project);
  const mixer = new FakeMixer();
  playState.value = isPlaying() ? "playing" : "edit"; // the op log is live only while Play runs
  const log = startOpLog(() => mixer);
  unsubs.push(log.dispose, () => void (playState.value = "edit"));
  return { section, mixer, log };
}

describe("a live edit in the section applies through the op path while Play runs", () => {
  it("a threshold edit is one setDucking op with the whole rule, answered by the mixer", async () => {
    const { section, mixer, log } = await playing([level("Music", "Voice")]);
    await section.edit("Set ducking threshold", setDuckingValue(section.draft, 0, "threshold", -20));
    expect(mixer.applied).toEqual([{ op: "setDucking", index: 0, rule: { ...newDuckRule("Music", "Voice"), threshold: -20 } }]);
    expect(log.entries).toHaveLength(1);
    expect(log.entries[0]!.results).toEqual([{ ok: true, class: "direct" }]);
    expect(log.entries[0]!.restartRequired).toEqual([]);
  });
  it("each option reaches the mixer: detector, mode, amount, attack, release, trigger, target", async () => {
    const { section, mixer } = await playing([level("Music", "Voice")]);
    const edits: [keyof DuckingRule, string | number][] = [["detector", "peak"], ["mode", "presence"], ["amount", 0.2], ["attack", 0.3], ["release", 0.9], ["trigger", "UI"], ["target", "SFX"]];
    for (const [key, value] of edits) await section.edit(`Set ${key}`, setDuckingValue(section.draft, 0, key, value));
    expect(mixer.applied).toHaveLength(edits.length);
    expect(mixer.applied.every((o) => o.op === "setDucking" && o.index === 0)).toBe(true);
    const last = mixer.applied[mixer.applied.length - 1] as Extract<MixOp, { op: "setDucking" }>;
    expect(last.rule).toEqual({ target: "SFX", trigger: "UI", mode: "presence", amount: 0.2, attack: 0.3, release: 0.9 });
  });
  it("add inserts at the end and remove sends null; reorder sends the two replaced rules", async () => {
    const { section, mixer } = await playing([presence("Music", "Voice")]);
    await section.edit("Add ducking rule", addDucking(section.draft));
    expect(mixer.applied[0]).toEqual({ op: "setDucking", index: 1, rule: newDuckRule("Music", "Voice"), insert: true });
    mixer.applied.length = 0;
    await section.edit("Move ducking rule up", moveDucking(section.draft, 1, -1));
    expect(mixer.applied).toEqual([
      { op: "setDucking", index: 0, rule: newDuckRule("Music", "Voice") },
      { op: "setDucking", index: 1, rule: { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 } },
    ]);
    mixer.applied.length = 0;
    await section.edit("Remove ducking rule", removeDucking(section.draft, 0));
    // the live op log diffs by position (no recorded ops here): the last entry leaves, the first takes the survivor
    expect(mixer.applied).toEqual([
      { op: "setDucking", index: 1, rule: null },
      { op: "setDucking", index: 0, rule: { target: "Music", trigger: "Voice", mode: "presence", amount: 0.4, attack: 0.1, release: 0.5 } },
    ]);
    expect(audioSettings.read(section.draft).ducking.map((r) => r.mode)).toEqual(["presence"]);
  });
  it("removing the only rule sends one null", async () => {
    const { section, mixer } = await playing([level("Music", "Voice")]);
    await section.edit("Remove ducking rule", removeDucking(section.draft, 0));
    expect(mixer.applied).toEqual([{ op: "setDucking", index: 0, rule: null }]);
  });
  it("undo sends the previous rule back", async () => {
    const { section, mixer } = await playing([level("Music", "Voice")]);
    await section.edit("Set ducking threshold", setDuckingValue(section.draft, 0, "threshold", -20));
    await section.undo();
    expect(mixer.applied).toHaveLength(2);
    expect(mixer.applied[1]).toEqual({ op: "setDucking", index: 0, rule: newDuckRule("Music", "Voice") });
  });
  it("a refused edit never reaches the section, so nothing reaches the mixer", async () => {
    const { section, mixer, log } = await playing([level("Music", "Voice"), level("SFX", "Music")]);
    const before = section.draft;
    const refused = setDuckingValue(section.draft, 1, "target", "Voice");
    expect(refused).toBe(before);
    expect(mixer.applied).toEqual([]);
    expect(log.entries).toEqual([]);
  });
  it("outside Play nothing reaches the mixer; the edit is still saved", async () => {
    const { section, mixer } = await playing([level("Music", "Voice")], () => false);
    await section.edit("Set ducking threshold", setDuckingValue(section.draft, 0, "threshold", -20));
    expect(mixer.applied).toEqual([]);
    expect(audioSettings.read(section.draft).ducking[0]!.threshold).toBe(-20);
  });
});
