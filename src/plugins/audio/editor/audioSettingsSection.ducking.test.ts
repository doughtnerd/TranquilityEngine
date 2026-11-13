// Dk1: the ducking section's controls, each with each option (mode, detector, threshold, amount, attack, release, trigger,
// target, add, remove, reorder), the refusals the parse makes (a level cycle naming its rules, the 9th level rule, the 33rd
// rule), "Needs the audio core" on a backend without level ducking, and a live edit reaching a fake mixer through the op
// log. The section is called as a function and its VNode tree walked (the component has no hooks); handlers get plain
// event objects. No DOM, no timers.
import type { VNode } from "preact";
import { afterEach, describe, expect, it } from "vitest";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import { parseAudioSettings, type DuckingRule } from "../../../engine/audio/settings";
import { readDraft } from "../../../editor/projectSettingsModel";
import { createProjectSettingsSection } from "../../../editor/projectSettingsSection";
import { onSectionChanged } from "../../../editor/sectionChanged";
import { closeTestProject, openTestProject } from "../../../editor/testing";
import type { SettingsDraft } from "../../../editor/sdk";
import { DuckingEditor } from "./AudioSettingsSection";
import { addDucking, audioOf, audioProblems, moveDucking, removeDucking, setDuckingValue } from "./audioSettingsModel";
import { createOpLog, type MixApplier } from "./mix/opLog";
import { newDuckRule } from "./mix/duckModel";

// ---- walking a rendered tree (as MixerStrip.test.ts does) ----

type Node = VNode<Record<string, unknown>>;
function find(node: unknown, pred: (n: Node) => boolean, out: Node[] = []): Node[] {
  if (Array.isArray(node)) { node.forEach((c) => find(c, pred, out)); return out; }
  if (!node || typeof node !== "object" || !("props" in node)) return out;
  const v = node as Node;
  if (typeof v.type === "function") return find((v.type as (p: unknown) => unknown)(v.props), pred, out);
  if (pred(v)) out.push(v);
  return find(v.props.children, pred, out);
}
const byLabel = (label: string) => (n: Node): boolean => n.props["aria-label"] === label;
const has = (tree: unknown, label: string): boolean => find(tree, byLabel(label)).length > 0;
function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  const v = node as Node;
  if (typeof v.type === "function") return text((v.type as (p: unknown) => unknown)(v.props));
  return text(v.props.children);
}

// ---- a rig: the editor over an in-memory draft; each handler re-renders, so a stale one would show ----

function rig(ducking: object[] = [], levelDucking = true, buses?: object[]) {
  const s = { draft: readDraft({ audio: { ...(buses ? { buses } : {}), ducking } }) as SettingsDraft, refusal: null as string | null, labels: [] as string[] };
  const view = (): VNode => DuckingEditor({
    a: audioOf(s.draft), draft: s.draft, levelDucking, refusal: s.refusal,
    set: (label, next) => { s.labels.push(label); s.draft = next; },
    onRefusal: (m) => { s.refusal = m; },
  }) as VNode;
  const one = (label: string): Node => {
    const f = find(view(), byLabel(label));
    expect(f, label).toHaveLength(1);
    return f[0]!;
  };
  return {
    s,
    view,
    rules: (): DuckingRule[] => audioOf(s.draft).ducking,
    pick: (label: string, value: string) => (one(label).props.onChange as (e: unknown) => void)({ currentTarget: { value } }),
    type: (label: string, n: number) => (one(label).props.onChange as (e: unknown) => void)({ currentTarget: { valueAsNumber: n, value: String(n) } }),
    click: (label: string) => (one(label).props.onClick as () => void)(),
    options: (label: string): string[] => find(one(label), (n) => n.type === "option").map((o) => String(o.props.value)),
    value: (label: string): unknown => one(label).props.value,
    addButton: (): Node => find(view(), (n) => n.type === "button" && text(n).includes("Ducking rule"))[0]!,
    refusal: (): string => text(find(view(), (n) => n.props["data-duck-refusal"] !== undefined)),
  };
}

const level = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "level", ...over });
const presence = (target: string, trigger: string, over: object = {}) => ({ target, trigger, mode: "presence", ...over });

describe("add: a new rule is a level rule, RMS, -30 dBFS", () => {
  it("the first rule added to a fresh project", () => {
    const r = rig();
    (r.addButton().props.onClick as () => void)();
    expect(r.rules()).toEqual([{ target: "Music", trigger: "Voice", mode: "level", detector: "rms", threshold: -30, amount: 0.4, attack: 0.1, release: 0.5 }]);
    expect(r.s.labels).toEqual(["Add ducking rule"]);
    expect(r.s.refusal).toBeNull();
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("the form shows the new rule's mode, detector and threshold", () => {
    const r = rig();
    (r.addButton().props.onClick as () => void)();
    expect(r.value("Ducking 1 mode")).toBe("level");
    expect(r.value("Ducking 1 detector")).toBe("rms");
    expect(r.value("Ducking 1 threshold")).toBe(-30);
  });
  it("each press adds another, in order", () => {
    const r = rig();
    for (let i = 0; i < 3; i++) (r.addButton().props.onClick as () => void)();
    expect(r.rules()).toHaveLength(3);
    expect(r.rules().every((x) => x.mode === "level" && x.detector === "rms" && x.threshold === -30)).toBe(true);
  });
  it("a project with two buses gets a pair the parse keeps (the child ducked by nothing above it)", () => {
    const r = rig([], true, [{ name: "Master" }, { name: "Fx", parent: "Master" }]);
    (r.addButton().props.onClick as () => void)();
    expect(r.rules()).toHaveLength(1);
    expect(r.rules()[0]).toMatchObject({ target: "Master", trigger: "Fx", mode: "level" });
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("the button is off with fewer than two buses", () => {
    const r = rig([], true, [{ name: "Master" }]);
    expect(r.addButton().props.disabled).toBe(true);
  });
});

describe("mode: each option", () => {
  it("offers presence and level", () => {
    expect(rig([presence("Music", "Voice")]).options("Ducking 1 mode")).toEqual(["presence", "level"]);
  });
  it("presence to level adds the detector and threshold controls with the defaults", () => {
    const r = rig([presence("Music", "Voice")]);
    expect(has(r.view(), "Ducking 1 detector")).toBe(false);
    expect(has(r.view(), "Ducking 1 threshold")).toBe(false);
    r.pick("Ducking 1 mode", "level");
    expect(r.rules()[0]).toMatchObject({ mode: "level", detector: "rms", threshold: -30 });
    expect(r.value("Ducking 1 detector")).toBe("rms");
    expect(r.value("Ducking 1 threshold")).toBe(-30);
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("level to presence drops the detector and threshold, and their controls", () => {
    const r = rig([level("Music", "Voice", { detector: "peak", threshold: -12 })]);
    r.pick("Ducking 1 mode", "presence");
    expect("detector" in r.rules()[0]! || "threshold" in r.rules()[0]!).toBe(false);
    expect(has(r.view(), "Ducking 1 detector")).toBe(false);
    expect(has(r.view(), "Ducking 1 threshold")).toBe(false);
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("choosing the mode a rule already has changes nothing", () => {
    const r = rig([level("Music", "Voice")]);
    const before = r.s.draft;
    r.pick("Ducking 1 mode", "level");
    expect(r.s.draft).toBe(before);
    expect(r.s.labels).toEqual([]);
  });
});

describe("detector: each option", () => {
  it("offers peak and rms; each is written", () => {
    const r = rig([level("Music", "Voice")]);
    expect(r.options("Ducking 1 detector")).toEqual(["peak", "rms"]);
    r.pick("Ducking 1 detector", "peak");
    expect(r.rules()[0]!.detector).toBe("peak");
    expect(r.value("Ducking 1 detector")).toBe("peak");
    r.pick("Ducking 1 detector", "rms");
    expect(r.rules()[0]!.detector).toBe("rms");
  });
});

describe("threshold: minimum, maximum, typical", () => {
  it.each([[-80, "the minimum"], [0, "the maximum"], [-30, "the typical value"], [-18, "a hot mix"]])("%d dBFS (%s)", (n) => {
    const r = rig([level("Music", "Voice", { threshold: n === -30 ? -6 : -30 })]);
    r.type("Ducking 1 threshold", n);
    expect(r.rules()[0]!.threshold).toBe(n);
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("the field's own limits are -80 and 0", () => {
    const r = rig([level("Music", "Voice")]);
    const f = find(r.view(), byLabel("Ducking 1 threshold"))[0]!;
    expect([f.props.min, f.props.max]).toEqual([-80, 0]);
  });
  it("a value outside the limits is clamped, not saved as it was typed", () => {
    const r = rig([level("Music", "Voice")]);
    r.type("Ducking 1 threshold", -200);
    expect(r.rules()[0]!.threshold).toBe(-80);
    r.type("Ducking 1 threshold", 20);
    expect(r.rules()[0]!.threshold).toBe(0);
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
});

describe("amount, attack, release: each limit and a typical value", () => {
  it.each([["amount", 0], ["amount", 1], ["amount", 0.4], ["attack", 0], ["attack", 10], ["attack", 0.1], ["release", 0], ["release", 10], ["release", 0.5]] as const)("%s = %d", (key, n) => {
    const r = rig([level("Music", "Voice", { amount: 0.7, attack: 2, release: 3 })]);
    r.type(`Ducking 1 ${key}`, n);
    expect(r.rules()[0]![key]).toBe(n);
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("the same fields on a presence rule", () => {
    const r = rig([presence("Music", "Voice")]);
    r.type("Ducking 1 amount", 0.25);
    r.type("Ducking 1 attack", 0.02);
    r.type("Ducking 1 release", 1.5);
    expect(r.rules()[0]).toMatchObject({ mode: "presence", amount: 0.25, attack: 0.02, release: 1.5 });
  });
  it("values past the limits are clamped to them", () => {
    const r = rig([level("Music", "Voice")]);
    r.type("Ducking 1 amount", 2);
    r.type("Ducking 1 attack", 50);
    r.type("Ducking 1 release", -1);
    expect(r.rules()[0]).toMatchObject({ amount: 1, attack: 10, release: 0 });
  });
});

describe("target and trigger", () => {
  it("each lists every bus and each choice is written", () => {
    const r = rig([level("Music", "Voice")]);
    expect(r.options("Ducking 1 target")).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
    expect(r.options("Ducking 1 trigger")).toEqual(["Master", "Music", "SFX", "UI", "Voice"]);
    r.pick("Ducking 1 target", "SFX");
    r.pick("Ducking 1 trigger", "UI");
    expect(r.rules()[0]).toMatchObject({ target: "SFX", trigger: "UI" });
    expect(r.s.refusal).toBeNull();
  });
  it("a bus can't duck itself: refused with the parse's message, the rule stays", () => {
    const r = rig([level("Music", "Voice")]);
    const before = r.s.draft;
    r.pick("Ducking 1 trigger", "Music");
    expect(r.s.draft).toBe(before);
    expect(r.refusal()).toContain("a bus can't duck itself");
  });
  it("a trigger above its target is refused (its level can't be measured before the target mixes)", () => {
    const r = rig([level("Music", "Voice")]);
    r.pick("Ducking 1 trigger", "Master");
    expect(r.refusal()).toContain("Master is above Music in the tree");
    expect(r.rules()[0]!.trigger).toBe("Voice");
  });
  it("a presence rule takes the same choices", () => {
    const r = rig([presence("Music", "Voice")]);
    r.pick("Ducking 1 target", "UI");
    expect(r.rules()[0]).toMatchObject({ mode: "presence", target: "UI" });
  });
});

describe("remove and reorder", () => {
  const three = () => rig([level("Music", "Voice"), presence("SFX", "Voice"), level("UI", "Voice", { threshold: -12 })]);
  it("remove drops that rule and clears a showing refusal", () => {
    const r = three();
    r.s.refusal = "old";
    r.click("Remove ducking rule 2");
    expect(r.rules().map((x) => x.target)).toEqual(["Music", "UI"]);
    expect(r.s.refusal).toBeNull();
    expect(r.s.labels).toEqual(["Remove ducking rule"]);
  });
  it("remove the first and the last", () => {
    const r = three();
    r.click("Remove ducking rule 1");
    expect(r.rules().map((x) => x.target)).toEqual(["SFX", "UI"]);
    r.click("Remove ducking rule 2");
    expect(r.rules().map((x) => x.target)).toEqual(["SFX"]);
  });
  it("move down and move up swap neighbours", () => {
    const r = three();
    r.click("Move ducking rule 1 down");
    expect(r.rules().map((x) => x.target)).toEqual(["SFX", "Music", "UI"]);
    r.click("Move ducking rule 3 up");
    expect(r.rules().map((x) => x.target)).toEqual(["SFX", "UI", "Music"]);
    expect(r.rules().map((x) => x.mode)).toEqual(["presence", "level", "level"]); // each rule moved whole
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("the first rule can't move up and the last can't move down", () => {
    const r = three();
    expect(find(r.view(), byLabel("Move ducking rule 1 up"))[0]!.props.disabled).toBe(true);
    expect(find(r.view(), byLabel("Move ducking rule 3 down"))[0]!.props.disabled).toBe(true);
    expect(find(r.view(), byLabel("Move ducking rule 2 up"))[0]!.props.disabled).toBe(false);
  });
  it("a move past the end changes nothing", () => {
    const d = three().s.draft;
    expect(moveDucking(d, 0, -1)).toBe(d);
    expect(moveDucking(d, 2, 1)).toBe(d);
    expect(moveDucking(d, 5, 1)).toBe(d);
  });
});

describe("a rule that closes a level cycle is refused with the parse's message and isn't saved", () => {
  it("two rules: A ducks B and B ducks A", () => {
    const r = rig([level("Music", "Voice"), level("SFX", "Music")]);
    const before = r.s.draft;
    r.pick("Ducking 2 target", "Voice"); // rule 2 becomes: Music ducks Voice
    expect(r.s.draft).toBe(before);
    expect(r.s.labels).toEqual([]);
    const msg = r.refusal();
    expect(msg).toContain("level rules can't form a cycle");
    expect(msg).toContain("ducking[0] (Voice ducks Music)");
    expect(msg).toContain("ducking[1] (Music ducks Voice)");
    expect(r.rules()[1]!.target).toBe("SFX");
    expect(audioProblems(r.s.draft)).toEqual([]);
  });
  it("three rules: A to B to C to A names all three", () => {
    const r = rig([level("Music", "Voice"), level("SFX", "Music"), level("UI", "SFX")]);
    r.pick("Ducking 3 target", "Voice"); // SFX ducks Voice, closing Voice > Music > SFX > Voice
    expect(r.refusal()).toMatch(/ducking\[0\] \(Voice ducks Music\).*ducking\[1\] \(Music ducks SFX\).*ducking\[2\] \(SFX ducks Voice\)/);
    expect(r.rules()[2]!.target).toBe("UI");
  });
  it("switching a presence rule to level refuses when that closes the cycle", () => {
    const r = rig([level("Music", "Voice"), presence("Voice", "Music")]);
    expect(audioProblems(r.s.draft)).toEqual([]); // presence rules add no edge
    r.pick("Ducking 2 mode", "level");
    expect(r.refusal()).toContain("ducking[1] (Music ducks Voice)");
    expect(r.rules()[1]!.mode).toBe("presence");
  });
  it("the same pair as presence is accepted", () => {
    const r = rig([level("Music", "Voice"), level("SFX", "Music")]);
    r.pick("Ducking 2 mode", "presence");
    r.pick("Ducking 2 target", "Voice");
    expect(r.s.refusal).toBeNull();
    expect(r.rules()[1]).toMatchObject({ mode: "presence", target: "Voice", trigger: "Music" });
  });
  it("the next successful edit clears the message", () => {
    const r = rig([level("Music", "Voice"), level("SFX", "Music")]);
    r.pick("Ducking 2 target", "Voice");
    expect(r.s.refusal).not.toBeNull();
    r.type("Ducking 1 amount", 0.2);
    expect(r.s.refusal).toBeNull();
    expect(text(find(r.view(), (n) => n.props["data-duck-refusal"] !== undefined))).toBe("");
  });
});

describe("the limits", () => {
  const eightLevel = () => Array.from({ length: 8 }, () => level("Music", "Voice"));
  it("the 8th level rule is added; the 9th is refused with its message and isn't saved", () => {
    const r = rig(eightLevel().slice(0, 7));
    (r.addButton().props.onClick as () => void)();
    expect(r.rules()).toHaveLength(8);
    expect(r.s.refusal).toBeNull();
    const before = r.s.draft;
    (r.addButton().props.onClick as () => void)();
    expect(r.s.draft).toBe(before);
    expect(r.rules()).toHaveLength(8);
    expect(r.refusal()).toContain("at most 8 level rules");
  });
  it("a presence rule can't be switched to level as the 9th level rule", () => {
    const r = rig([...eightLevel(), presence("SFX", "Voice")]);
    r.pick("Ducking 9 mode", "level");
    expect(r.refusal()).toContain("at most 8 level rules");
    expect(r.rules()[8]!.mode).toBe("presence");
  });
  it("removing a level rule makes room again", () => {
    const r = rig(eightLevel());
    (r.addButton().props.onClick as () => void)();
    expect(r.s.refusal).not.toBeNull();
    r.click("Remove ducking rule 1");
    (r.addButton().props.onClick as () => void)();
    expect(r.s.refusal).toBeNull();
    expect(r.rules()).toHaveLength(8);
  });
  it("the 33rd rule of either mode is refused", () => {
    const r = rig(Array.from({ length: 32 }, () => presence("Music", "Voice")));
    const before = r.s.draft;
    (r.addButton().props.onClick as () => void)();
    expect(r.s.draft).toBe(before);
    expect(r.refusal()).toContain("at most 32 rules");
  });
  it("the model functions say the same without the view", () => {
    const d = rig(eightLevel()).s.draft;
    expect(addDucking(d)).toBe(d);
    expect(audioOf(setDuckingValue(rig([...eightLevel(), presence("SFX", "Voice")]).s.draft, 8, "mode", "level")).ducking[8]!.mode).toBe("presence");
  });
});

describe("a backend without level ducking", () => {
  it("level rules show \"Needs the audio core\"; presence rules don't", () => {
    const r = rig([level("Music", "Voice"), presence("SFX", "Voice"), level("UI", "Voice")], false);
    const notes = find(r.view(), (n) => n.props["data-needs-core"] !== undefined);
    expect(notes.map((n) => [n.props["data-needs-core"], text(n)])).toEqual([[0, "Needs the audio core"], [2, "Needs the audio core"]]);
  });
  it("the core backend shows no note", () => {
    const r = rig([level("Music", "Voice")], true);
    expect(find(r.view(), (n) => n.props["data-needs-core"] !== undefined)).toHaveLength(0);
  });
  it("the rule is kept and still editable there (it does nothing until the core runs)", () => {
    const r = rig([level("Music", "Voice")], false);
    r.type("Ducking 1 threshold", -24);
    r.pick("Ducking 1 detector", "peak");
    expect(r.rules()[0]).toMatchObject({ mode: "level", detector: "peak", threshold: -24 });
  });
  it("switching to presence removes the note", () => {
    const r = rig([level("Music", "Voice")], false);
    r.pick("Ducking 1 mode", "presence");
    expect(find(r.view(), (n) => n.props["data-needs-core"] !== undefined)).toHaveLength(0);
  });
});

describe("the model functions are pure and agree with the parse", () => {
  it("every rule the editor writes parses back to itself", () => {
    let d = rig().s.draft;
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
  const log = createOpLog({ onSectionChanged: (k, l) => (unsubs.push(onSectionChanged(k, l)), unsubs[unsubs.length - 1]!), isPlaying, mixer: () => mixer });
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
    expect(audioOf(section.draft).ducking.map((r) => r.mode)).toEqual(["presence"]);
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
    expect(audioOf(section.draft).ducking[0]!.threshold).toBe(-20);
  });
});
