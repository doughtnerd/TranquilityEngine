// Ed7: the rule lint. Containers come from the real reader; a rule with a dangling id is put in by hand, since the parser drops it.
import { describe, expect, it } from "vitest";
import { DEFAULT_TRANSITION_RULE } from "../../../../engine/audio/musicRules";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";
import { containerOf, segmentRaw, switchEvent, type Raw } from "./ruleFixtures";
import { endSegments, fadeSeconds, issuesOfRule, leafSegments, lintTransitionRules, worstSeverity } from "./ruleLint";

const lint = (transitions: Raw[], over?: Parameters<typeof switchEvent>[1], lengths: Record<string, number> = {}) =>
  lintTransitionRules(containerOf(switchEvent(transitions, over)), { lengthOf: (id) => lengths[id] });
const codes = (issues: ReturnType<typeof lint>) => issues.map((i) => `${i.rule}:${i.code}`);

describe("duplicate and shadowed", () => {
  it("flags a repeated pair as a duplicate, once, and not also as shadowed", () => {
    const issues = lint([{ from: "a", to: "b" }, { from: "a", to: "b", exit: "immediate" }]);
    expect(codes(issues)).toEqual(["1:duplicate"]);
    expect(issues[0].severity).toBe("warn");
  });
  it("treats a rule that wins no child pair but still wins a * cell as a note, as the rules table does", () => {
    // Every child pair is named earlier; `*>*` still answers the * cells (and children added later).
    const issues = lint([{ from: "a" }, { from: "b" }, { from: "c" }, {}]);
    expect(codes(issues)).toEqual(["3:wildcardOnly"]);
    expect(issues[0].severity).toBe("info");
  });
  it("a rule beaten on every pair it matches by an earlier same-key rule is the duplicate, not a second row", () => {
    const issues = lint([{ from: "a", to: "b" }, { from: "a", to: "b" }, { from: "a", to: "b" }]);
    expect(codes(issues)).toEqual(["1:duplicate", "2:duplicate"]);
  });
});

describe("missing targets", () => {
  const withDangling = (rule: Record<string, unknown>): MusicContainerNode => {
    const c = containerOf(switchEvent([]));
    return { ...c, transitions: [{ ...DEFAULT_TRANSITION_RULE, ...rule } as never] };
  };
  it("flags from, to and bridge ids that are not there as errors", () => {
    const issues = lintTransitionRules(withDangling({ from: "zz", to: "yy", bridge: { segment: "nope" } }));
    expect(issues.map((i) => i.code).sort()).toEqual(["missingBridge", "missingFrom", "missingTo"]);
    expect(issues.every((i) => i.severity === "error")).toBe(true);
    expect(worstSeverity(issues)).toBe("error");
  });
  it("flags an enter cue the target segment lacks as an error, and passes a known one", () => {
    const cues = { cues: [{ name: "drop", at: "2:1:0" }] };
    expect(codes(lint([{ from: "a", to: "b", enter: { cue: "drop" } }], { children: [segmentRaw("a"), segmentRaw("b", cues), segmentRaw("c")] }))).toEqual([]);
    expect(codes(lint([{ from: "a", to: "b", enter: { cue: "drop" } }]))).toEqual(["0:missingCue"]);
  });
  it("warns, not errors, when a * target has no child with the cue", () => {
    const issues = lint([{ from: "a", enter: { cue: "drop" } }]);
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ code: "missingCue", severity: "warn" });
  });
  it("warns when exit is nextCue and the source has no cues", () => {
    expect(codes(lint([{ from: "a", to: "b", exit: "nextCue" }]))).toEqual(["0:noCues"]);
  });
});

describe("unreachable", () => {
  it("flags a switch target with no value", () => {
    const issues = lint([{ from: "a", to: "c" }], { children: [segmentRaw("a"), segmentRaw("b"), segmentRaw("c", { value: undefined })] });
    expect(codes(issues)).toEqual(["0:unreachable"]);
  });
  it("notes (info) a rule that wins only * cells", () => {
    const issues = lint([{ from: "a", to: "a" }, { from: "a", to: "b" }, { from: "a", to: "c" }, { from: "a" }]);
    expect(issues.find((i) => i.rule === 3)?.code).toBe("wildcardOnly");
    expect(issues.find((i) => i.rule === 3)?.severity).toBe("info");
  });
});

describe("fades longer than the segment", () => {
  const slow = { tempo: [{ at: "1:1:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] };
  const children = [segmentRaw("a", slow), segmentRaw("b"), segmentRaw("c")];
  it("compares the fade in seconds, at the segment's own tempo, with its length", () => {
    const issues = lint([{ from: "a", to: "b", fadeOut: { beats: 8 } }], { children }, { a: 6, b: 30, c: 30 });
    expect(codes(issues)).toEqual(["0:fadeTooLong"]);
    expect(issues[0].field).toBe("fadeOut");
    expect(codes(lint([{ from: "a", to: "b", fadeOut: { beats: 4 } }], { children }, { a: 6 }))).toEqual([]);
  });
  it("checks fadeIn against the target and stays quiet while lengths are unknown", () => {
    expect(codes(lint([{ from: "a", to: "b", fadeIn: { seconds: 10 } }], undefined, { b: 5 }))).toEqual(["0:fadeTooLong"]);
    expect(codes(lint([{ from: "a", to: "b", fadeIn: { seconds: 10 } }]))).toEqual([]);
  });
  it("converts beats and seconds", () => {
    const seg = leafSegments(containerOf(switchEvent([])))[0];
    expect(fadeSeconds({ unit: "beats", amount: 2, offset: 0, curve: "linear" }, seg)).toBe(1);
    expect(fadeSeconds({ unit: "seconds", amount: 2, offset: 0, curve: "linear" }, seg)).toBe(2);
  });
});

describe("a bridge that doesn't fit", () => {
  const bridge = (extra: Raw = {}) => [segmentRaw("riser", { value: undefined, ...extra })];
  const rule = { from: "a", to: "b", bridge: { segment: "riser" } };
  it("flags an empty bridge, a different metre and a different tempo", () => {
    expect(codes(lint([rule], { library: [{ type: "segment", id: "riser", tracks: [] }] }))).toEqual(["0:bridgeEmpty"]);
    const waltz = { tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 3, beatUnit: 4 }] };
    expect(codes(lint([rule], { library: bridge(waltz) }))).toEqual(["0:bridgeMetre"]);
    const fast = { tempo: [{ at: "1:1:0", bpm: 140, beatsPerBar: 4, beatUnit: 4 }] };
    expect(codes(lint([rule], { library: bridge(fast) }))).toEqual(["0:bridgeTempo"]);
  });
  it("flags a length that is not whole bars, and bridge fades longer than the bridge", () => {
    const issues = lint([{ ...rule, bridge: { segment: "riser", fadeIn: { seconds: 9 } } }], { library: bridge() }, { riser: 5 });
    expect(codes(issues)).toEqual(["0:bridgeLength", "0:fadeTooLong"]);
    expect(codes(lint([rule], { library: bridge() }, { riser: 6 }))).toEqual([]);
  });
});

describe("playlists and helpers", () => {
  it("notes that a playlist ignores a non-default exit", () => {
    const issues = lint([{ from: "a", to: "b", exit: "immediate" }, { from: "b", to: "c" }], { type: "playlist" });
    expect(codes(issues)).toEqual(["0:exitIgnored"]);
  });
  it("finds the segments of a rule end", () => {
    const c = containerOf(switchEvent([]));
    expect(endSegments(c, "b").map((s) => s.id)).toEqual(["b"]);
    expect(endSegments(c, "*").map((s) => s.id)).toEqual(["a", "b", "c"]);
    expect(endSegments(c, "zz")).toEqual([]);
  });
  it("selects a rule's rows and the worst severity", () => {
    const issues = lint([{ from: "a", to: "b" }, { from: "a", to: "b" }]);
    expect(issuesOfRule(issues, 1)).toHaveLength(1);
    expect(issuesOfRule(issues, 0)).toHaveLength(0);
    expect(worstSeverity([])).toBeNull();
  });
});
