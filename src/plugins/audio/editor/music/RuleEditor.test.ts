// Ed7: the rule editor's edits. Each is a pure function of the container; the acceptance is that what the forms write
// survives the writer: format the event, parse it back with no problems, the same rules.
import { describe, expect, it } from "vitest";
import { formatAudioEvent, parseAudioEvent, type AudioEventAsset } from "../../../../engine/audio/eventFormat";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";
import {
  addRule, checkFade, duplicateRule, exitText, gridSpec, moveRule, removeRule, setBridge, setBridgeOwnFade, setEnter, setExit, setFade, setRuleEnds,
  type RuleEdit,
} from "./RuleEditor";
import { containerOf, segmentRaw, switchEvent } from "./ruleFixtures";
import { replaceContainer } from "./rulesModel";

const cues = { cues: [{ name: "drop", at: "2:1:0" }] };
const base = (): AudioEventAsset => switchEvent([{ from: "a", to: "b" }, { from: "b" }], { children: [segmentRaw("a"), segmentRaw("b", cues), segmentRaw("c")] });

const err = (e: RuleEdit): string => ("error" in e ? e.error : "");

/** Apply an edit the way the panel does and push the result through the writer. */
function roundTrip(event: AudioEventAsset, e: RuleEdit, expected: string[] = []): MusicContainerNode {
  if ("error" in e) throw new Error(e.error);
  const next: AudioEventAsset = { ...event, musicRoot: replaceContainer(event.musicRoot!, "s", e.container) };
  const text = formatAudioEvent(next);
  const again = parseAudioEvent(JSON.parse(text));
  expect(again.problems.map((p) => p.replace(/^root\.transitions\[\d+\]: /, "").replace(/ \(.*$/, ""))).toEqual(expected);
  expect(formatAudioEvent(again.value)).toBe(text);
  const read = containerOf(again.value);
  expect(read.transitions).toEqual(e.container.transitions);
  return read;
}

describe("the list", () => {
  it("adds, duplicates, moves and removes rules, round-tripping each", () => {
    const event = base();
    let c = roundTrip(event, addRule(containerOf(event), { from: "c" }));
    expect(c.transitions.map((r) => `${r.from}>${r.to}`)).toEqual(["a>b", "b>*", "c>*"]);
    c = roundTrip(event, moveRule(c, 2, -2));
    expect(c.transitions.map((r) => r.from)).toEqual(["c", "a", "b"]);
    c = roundTrip(event, duplicateRule(c, 0), ["duplicates rule 0"]);
    expect(c.transitions).toHaveLength(4);
    c = roundTrip(event, removeRule(c, 1));
    expect(c.transitions.map((r) => r.from)).toEqual(["c", "a", "b"]);
  });
  it("refuses a dangling id, a move off the end and a missing rule", () => {
    const c = containerOf(base());
    expect(err(addRule(c, { from: "zz" }))).toMatch(/from must be/);
    expect(err(setRuleEnds(c, 0, { to: "zz" }))).toMatch(/to must be/);
    expect(err(moveRule(c, 0, -1))).toMatch(/already/);
    expect(err(removeRule(c, 9))).toMatch(/does not exist/);
  });
  it("stops at the rule limit", () => {
    const c = containerOf(base());
    const full = { ...c, transitions: Array.from({ length: 256 }, () => c.transitions[0]) };
    expect(err(addRule(full))).toMatch(/at most 256/);
    expect(err(duplicateRule(full, 0))).toMatch(/at most 256/);
  });
});

describe("ends, exit and enter", () => {
  it("changes from and to to a child or *", () => {
    const event = base();
    const c = roundTrip(event, setRuleEnds(containerOf(event), 0, { from: "*", to: "c" }));
    expect(c.transitions[0]).toMatchObject({ from: "*", to: "c" });
  });
  it("writes every exit kind and validates the every count like the parser", () => {
    const event = base();
    let c = containerOf(event);
    for (const exit of ["immediate", "nextCue", "exitCue", "beat", "bar", { every: "bar", n: 4 }, { every: "beat", n: 64 }] as const) {
      c = roundTrip(event, setExit(c, 0, exit));
      expect(c.transitions[0].exit).toEqual(exit);
    }
    expect(err(setExit(c, 0, { every: "bar", n: 1 }))).toMatch(/2\.\.64/);
    expect(err(setExit(c, 0, { every: "bar", n: 65 }))).toMatch(/2\.\.64/);
    expect(err(setExit(c, 0, { every: "bar", n: 2.5 }))).toMatch(/whole number/);
    expect(gridSpec("bar", 1)).toBe("bar");
    expect(gridSpec("beat", 8)).toEqual({ every: "beat", n: 8 });
    expect(gridSpec("beat", 0)).toMatch(/2\.\.64/);
    expect(exitText({ every: "bar", n: 4 })).toBe("every 4 bars");
    expect(exitText("immediate")).toBe("immediate");
  });
  it("accepts a cue the target has, refuses one it lacks", () => {
    const event = base();
    const c = roundTrip(event, setEnter(containerOf(event), 0, { cue: "drop" }));
    expect(c.transitions[0].enter).toEqual({ cue: "drop" });
    expect(err(setEnter(c, 0, { cue: "nope" }))).toMatch(/no cue named/);
    expect(err(setEnter(c, 0, { cue: " " }))).toMatch(/cue name/);
    expect(roundTrip(event, setEnter(c, 0, "sameTime")).transitions[0].enter).toBe("sameTime");
  });
});

describe("fades", () => {
  it("sets amount, unit, offset and curve, round-tripping", () => {
    const event = base();
    let c = roundTrip(event, setFade(containerOf(event), 0, "fadeOut", { amount: 2 }));
    c = roundTrip(event, setFade(c, 0, "fadeOut", { unit: "seconds", amount: 1.5, offset: -0.25, curve: "sCurve" }));
    expect(c.transitions[0].fadeOut).toEqual({ unit: "seconds", amount: 1.5, offset: -0.25, curve: "sCurve" });
    c = roundTrip(event, setFade(c, 0, "fadeIn", { curve: "linear", amount: 0 }));
    expect(c.transitions[0].fadeIn).toMatchObject({ amount: 0, curve: "linear" });
  });
  it("refuses amounts and offsets outside the unit's bounds and an unknown curve", () => {
    const c = containerOf(base());
    expect(err(setFade(c, 0, "fadeOut", { amount: -1 }))).toMatch(/0\.\.64 beats/);
    expect(err(setFade(c, 0, "fadeOut", { amount: 65 }))).toMatch(/0\.\.64 beats/);
    expect(err(setFade(c, 0, "fadeOut", { unit: "seconds", amount: 61 }))).toMatch(/0\.\.60 seconds/);
    expect(err(setFade(c, 0, "fadeOut", { offset: 100 }))).toMatch(/offset/);
    expect(err(setFade(c, 0, "fadeIn", { amount: NaN }))).toMatch(/0\.\.64/);
    expect(checkFade({ unit: "beats", amount: 1, offset: 0, curve: "wobble" as never })).toMatch(/curve/);
    expect(checkFade({ unit: "beats", amount: 1, offset: 0, curve: "equalPower" })).toBeNull();
  });
});

describe("the bridge", () => {
  it("sets a library segment, gives it its own fades and removes it, round-tripping", () => {
    const event = base();
    let c = roundTrip(event, setBridge(containerOf(event), 0, "riser"));
    expect(c.transitions[0].bridge).toEqual({ segment: "riser" });
    c = roundTrip(event, setBridgeOwnFade(c, 0, "fadeOut", true));
    c = roundTrip(event, setFade(c, 0, "bridgeFadeOut", { unit: "seconds", amount: 0.5, curve: "linear" }));
    expect(c.transitions[0].bridge!.fadeOut).toMatchObject({ unit: "seconds", amount: 0.5, curve: "linear" });
    c = roundTrip(event, setBridgeOwnFade(c, 0, "fadeOut", false));
    expect(c.transitions[0].bridge).toEqual({ segment: "riser" });
    c = roundTrip(event, setBridge(c, 0, null));
    expect(c.transitions[0].bridge).toBeUndefined();
  });
  it("refuses a segment outside the library and bridge fades on a rule without one", () => {
    const c = containerOf(base());
    expect(err(setBridge(c, 0, "nope"))).toMatch(/not in/);
    expect(err(setFade(c, 0, "bridgeFadeIn", { amount: 1 }))).toMatch(/no bridge/);
    expect(err(setBridgeOwnFade(c, 0, "fadeIn", true))).toMatch(/no bridge/);
  });
});

describe("replaceContainer", () => {
  it("replaces the root, a nested container, and leaves other ids alone", () => {
    const event = switchEvent([], { children: [segmentRaw("a")] });
    const root = containerOf(event);
    const next = { ...root, transitions: [] };
    expect(replaceContainer(root, "s", next)).toBe(next);
    expect(replaceContainer(root, "other", next)).toBe(root);
    const nested = parseAudioEvent({
      format: "myco.audioevent@1",
      root: { type: "playlist", id: "outer", children: [{ type: "musicSwitch", id: "inner", parameter: "p", children: [segmentRaw("a")] }] },
    }).value.musicRoot as MusicContainerNode;
    const inner = nested.children[0] as MusicContainerNode;
    const swapped = replaceContainer(nested, "inner", { ...inner, parameter: "q" } as MusicContainerNode) as MusicContainerNode;
    expect((swapped.children[0] as { parameter: string }).parameter).toBe("q");
  });
});
