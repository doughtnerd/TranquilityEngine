/**
 * One case per rule and limit of `api-and-models.md` §2.4 (transitions) and §2.5 (stingers and library), the F2 skeleton.
 * Tag: L-F2a. Each case parses an event through `parseAudioEvent` (a `musicSwitch` or `playlist` root with segment
 * children, `transitions`, `stingers`, `library`) or calls the exported function it names, and asserts the model, the
 * `problems` (message contains the path and the reason) or the written JSON. Every rule needs a passing control and a
 * failing case. `fixtures` below build the trees; the leaf fills the cases and may add helpers, not new exports of
 * `musicRules.ts`.
 */
import { describe, expect, it } from "vitest";
import { AUDIO_EVENT_FORMAT, eventClips, eventNodes, eventRootNode, formatAudioEvent, MAX_EVENT_NODES, parseAudioEvent } from "./eventFormat";
import { musicClips, type PlaylistNode } from "./musicFormat";
import {
  analyzeTransitionRules, buildRuleIndex, DEFAULT_TRANSITION_RULE, MAX_CONCURRENT_STINGERS, MAX_FADE_BEATS, MAX_FADE_SECONDS,
  musicTriggers, resolveStinger, resolveTransition, ruleIndexFor, ruleTier, STINGER_STEAL_FADE_SECONDS, stingerToJson,
  transitionToJson, type TransitionRule,
} from "./musicRules";

type Raw = Record<string, unknown>;

// --- fixtures ------------------------------------------------------------------------------------------------------

const seg = (id: string, extra: Raw = {}): Raw => ({ type: "segment", id, tracks: [{ name: "a", clip: `${id}.ogg` }], ...extra });

/** A playlist root `p` with the children `a`, `b`, `c` unless given, and the extra keys; returns its node and problems. */
function parseRoot(extra: Raw = {}, children: Raw[] = [seg("a"), seg("b"), seg("c")]) {
  const r = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: { type: "playlist", id: "p", children, ...extra } });
  return { node: eventRootNode(r.value) as PlaylistNode, problems: r.problems };
}

/** The problems whose message names `path`. */
const at = (problems: string[], path: string): string[] => problems.filter((p) => p.includes(path));

/** A full rule from the default, with `from` and `to` set. */
const rule = (from: string, to: string, over: Partial<TransitionRule> = {}): TransitionRule => ({ ...DEFAULT_TRANSITION_RULE, from, to, ...over });

describe("transitions: fields and defaults (§2.4)", () => {
  it("L-F2a: a rule with no keys is the default rule (from * to *, exit bar, enter entryCue, 1 beat equalPower fades)", () => {
    const { node, problems } = parseRoot({ transitions: [{}] });
    expect(problems).toEqual([]);
    expect(node.transitions).toEqual([DEFAULT_TRANSITION_RULE]);
    // Control: a key set makes it a different rule.
    expect(parseRoot({ transitions: [{ from: "a" }] }).node.transitions[0]?.from).toBe("a");
  });

  it("L-F2a: from and to accept the id of a direct child or the wildcard", () => {
    const { node, problems } = parseRoot({ transitions: [{ from: "a", to: "b" }, { from: "*", to: "c" }, { from: "c" }] });
    expect(problems).toEqual([]);
    expect(node.transitions.map((r) => [r.from, r.to])).toEqual([["a", "b"], ["*", "c"], ["c", "*"]]);
  });

  it("L-F2a: exit accepts beat, bar, { every, n }, immediate, nextCue and exitCue; anything else keeps the default with a problem", () => {
    for (const exit of ["beat", "bar", { every: "beat", n: 4 }, "immediate", "nextCue", "exitCue"] as const) {
      const { node, problems } = parseRoot({ transitions: [{ exit }] });
      expect(problems).toEqual([]);
      expect(node.transitions[0]?.exit).toEqual(exit);
    }
    const bad = parseRoot({ transitions: [{ exit: "later" }] });
    expect(bad.node.transitions[0]?.exit).toBe("bar");
    expect(at(bad.problems, "root.transitions[0].exit")).toHaveLength(1);
  });

  it("L-F2a: a grid spec { every, n } needs n an integer 2..64 (control at 2 and 64, failing at 1, 65 and 2.5)", () => {
    for (const n of [2, 64]) {
      const { node, problems } = parseRoot({ transitions: [{ exit: { every: "bar", n } }] });
      expect(problems).toEqual([]);
      expect(node.transitions[0]?.exit).toEqual({ every: "bar", n });
    }
    for (const n of [1, 65, 2.5]) {
      const { node, problems } = parseRoot({ transitions: [{ exit: { every: "bar", n } }] });
      expect(node.transitions[0]?.exit).toBe("bar");
      expect(at(problems, "root.transitions[0].exit")).toHaveLength(1);
    }
  });

  it("L-F2a: enter accepts entryCue, sameTime and { cue }; anything else keeps the default with a problem", () => {
    for (const enter of ["entryCue", "sameTime"] as const) {
      const { node, problems } = parseRoot({ transitions: [{ enter }] });
      expect(problems).toEqual([]);
      expect(node.transitions[0]?.enter).toBe(enter);
    }
    // `{ cue }` names no cue of the segments here: a dangling cue only warns (checkMusicRules), so only the key is checked.
    const cue = parseRoot({ transitions: [{ enter: { cue: "hit" } }] });
    expect(cue.node.transitions[0]?.enter).toEqual({ cue: "hit" });
    expect(at(cue.problems, "root.transitions[0].enter")).toHaveLength(1);
    const bad = parseRoot({ transitions: [{ enter: "later" }] });
    expect(bad.node.transitions[0]?.enter).toBe("entryCue");
    expect(at(bad.problems, "root.transitions[0].enter")).toHaveLength(1);
  });

  it("L-F2a: fadeOut and fadeIn accept { beats } or { seconds } with offset (may be negative) and curve linear, sCurve or equalPower", () => {
    const { node, problems } = parseRoot({
      transitions: [
        { fadeOut: { seconds: 2, offset: -0.5, curve: "linear" }, fadeIn: { beats: 4, offset: 1, curve: "sCurve" } },
        { fadeOut: { beats: 1, curve: "equalPower" }, fadeIn: { seconds: 0.25 } },
      ],
    });
    expect(problems).toEqual([]);
    expect(node.transitions[0]?.fadeOut).toEqual({ unit: "seconds", amount: 2, offset: -0.5, curve: "linear" });
    expect(node.transitions[0]?.fadeIn).toEqual({ unit: "beats", amount: 4, offset: 1, curve: "sCurve" });
    expect(node.transitions[1]?.fadeIn).toEqual({ unit: "seconds", amount: 0.25, offset: 0, curve: "equalPower" });
  });

  it("L-F2a: a fade with both beats and seconds uses beats with a problem; with neither, the default with a problem", () => {
    const both = parseRoot({ transitions: [{ fadeOut: { beats: 2, seconds: 5 } }] });
    expect(both.node.transitions[0]?.fadeOut).toMatchObject({ unit: "beats", amount: 2 });
    expect(at(both.problems, "root.transitions[0].fadeOut")).toHaveLength(1);
    const neither = parseRoot({ transitions: [{ fadeIn: { offset: 2 } }] });
    expect(neither.node.transitions[0]?.fadeIn).toMatchObject({ unit: "beats", amount: 1 });
    expect(at(neither.problems, "root.transitions[0].fadeIn")).toHaveLength(1);
    // Control: one unit, no problem.
    expect(at(parseRoot({ transitions: [{ fadeOut: { beats: 2 } }] }).problems, "root.transitions[0].fadeOut")).toEqual([]);
  });

  it("L-F2a: a fade amount past its bound is clamped with a problem; amount 0 (a cut) is kept", () => {
    const big = parseRoot({ transitions: [{ fadeOut: { beats: MAX_FADE_BEATS + 1 }, fadeIn: { seconds: MAX_FADE_SECONDS * 2 } }] });
    expect(big.node.transitions[0]?.fadeOut.amount).toBe(MAX_FADE_BEATS);
    expect(big.node.transitions[0]?.fadeIn.amount).toBe(MAX_FADE_SECONDS);
    expect(at(big.problems, "root.transitions[0].fadeOut").length).toBeGreaterThan(0);
    expect(at(big.problems, "root.transitions[0].fadeIn").length).toBeGreaterThan(0);
    const cut = parseRoot({ transitions: [{ fadeOut: { beats: 0 } }] });
    expect(cut.node.transitions[0]?.fadeOut.amount).toBe(0);
    expect(at(cut.problems, "root.transitions[0].fadeOut")).toEqual([]);
  });

  it("L-F2a: bridge keeps a library segment id and optional fadeOut and fadeIn; an absent bridge fade stays absent", () => {
    const { node, problems } = parseRoot({
      library: [seg("riser")],
      transitions: [{ from: "a", to: "b", bridge: { segment: "riser", fadeOut: { beats: 2 } } }, { from: "b", to: "c", bridge: { segment: "riser" } }],
    });
    expect(problems).toEqual([]);
    const bridge = node.transitions[0]?.bridge;
    expect(bridge?.segment).toBe("riser");
    expect(bridge?.fadeOut).toEqual({ unit: "beats", amount: 2, offset: 0, curve: "equalPower" });
    expect(bridge?.fadeIn).toBeUndefined();
    expect(node.transitions[1]?.bridge).toEqual({ segment: "riser" });
    expect(node.transitions[1]?.bridge?.fadeOut).toBeUndefined();
  });

  it("L-F2a: a rule that is not an object, or whose from or to is not a string, is dropped with a problem", () => {
    const { node, problems } = parseRoot({ transitions: ["x", { from: 3 }, { to: true }, {}] });
    expect(node.transitions).toEqual([DEFAULT_TRANSITION_RULE]);
    for (const i of [0, 1, 2]) expect(at(problems, `root.transitions[${i}]`).length).toBeGreaterThan(0);
  });
});

describe("transitions: dangling ids (§2.4)", () => {
  it("L-F2a: a rule whose from names no direct child is dropped with a problem naming the path", () => {
    const { node, problems } = parseRoot({ transitions: [{ from: "zz", to: "b" }, { from: "a", to: "b" }] });
    expect(node.transitions.map((r) => [r.from, r.to])).toEqual([["a", "b"]]);
    expect(at(problems, "root.transitions[0].from")).toHaveLength(1);
  });

  it("L-F2a: a rule whose to names no direct child is dropped (a grandchild's id is dangling: the table is the nearest common parent's)", () => {
    const inner = { type: "playlist", id: "inner", children: [seg("deep")] };
    const { node, problems } = parseRoot({ transitions: [{ from: "a", to: "deep" }, { from: "a", to: "inner" }] }, [seg("a"), inner]);
    expect(node.transitions.map((r) => r.to)).toEqual(["inner"]);
    expect(at(problems, "root.transitions[0].to")).toHaveLength(1);
  });

  it("L-F2a: a bridge.segment that is not in the container's library drops the rule; one that is, keeps it", () => {
    const { node, problems } = parseRoot({
      library: [seg("riser")],
      transitions: [{ from: "a", to: "b", bridge: { segment: "nope" } }, { from: "b", to: "c", bridge: { segment: "riser" } }],
    });
    expect(node.transitions.map((r) => r.from)).toEqual(["b"]);
    expect(at(problems, "root.transitions[0].bridge.segment")).toHaveLength(1);
  });

  it("L-F2a: a dangling rule does not count for duplicate and shadow warnings of the rules around it", () => {
    const { node, problems } = parseRoot({ transitions: [{ from: "zz", to: "b" }, { from: "a", to: "b" }, { from: "*", to: "*" }] });
    expect(node.transitions).toHaveLength(2);
    expect(problems.filter((p) => /transitions\[[12]\]/.test(p))).toEqual([]);
  });
});

describe("transitions: precedence, duplicates and shadows (§2.4)", () => {
  it("L-F2a: tier of a rule: pair 1, from named 2, to named 3, wildcard pair 4 (ruleTier)", () => {
    expect(ruleTier({ from: "a", to: "b" })).toBe(1);
    expect(ruleTier({ from: "a", to: "*" })).toBe(2);
    expect(ruleTier({ from: "*", to: "b" })).toBe(3);
    expect(ruleTier({ from: "*", to: "*" })).toBe(4);
  });

  it("L-F2a: resolveTransition prefers tier 1 over 2 over 3 over 4 whatever the list order", () => {
    // Listed least specific first.
    const index = buildRuleIndex([rule("*", "*", { exit: "immediate" }), rule("*", "b", { exit: "nextCue" }), rule("a", "*", { exit: "exitCue" }), rule("a", "b", { exit: "beat" })]);
    expect(resolveTransition(index, "a", "b")).toMatchObject({ index: 3, tier: 1, key: "a>b" });
    expect(resolveTransition(index, "a", "c")).toMatchObject({ index: 2, tier: 2, key: "a>*" });
    expect(resolveTransition(index, "c", "b")).toMatchObject({ index: 1, tier: 3, key: "*>b" });
    expect(resolveTransition(index, "c", "d")).toMatchObject({ index: 0, tier: 4, key: "*>*" });
  });

  it("L-F2a: inside a tier the first listed rule wins", () => {
    const pair = buildRuleIndex([rule("a", "b", { exit: "immediate" }), rule("a", "b", { exit: "nextCue" })]);
    expect(resolveTransition(pair, "a", "b")).toMatchObject({ index: 0, tier: 1 });
    expect(resolveTransition(pair, "a", "b").rule.exit).toBe("immediate");
    const from = buildRuleIndex([rule("a", "*", { exit: "immediate" }), rule("a", "*", { exit: "nextCue" })]);
    expect(resolveTransition(from, "a", "c")).toMatchObject({ index: 0, tier: 2 });
    const to = buildRuleIndex([rule("*", "b", { exit: "immediate" }), rule("*", "b", { exit: "nextCue" })]);
    expect(resolveTransition(to, "c", "b")).toMatchObject({ index: 0, tier: 3 });
    const wild = buildRuleIndex([rule("*", "*", { exit: "immediate" }), rule("*", "*", { exit: "nextCue" })]);
    expect(resolveTransition(wild, "x", "y")).toMatchObject({ index: 0, tier: 4 });
  });

  it("L-F2a: with no rule that matches, the always-present default rule resolves (index -1, tier 4, key *>*)", () => {
    expect(resolveTransition(buildRuleIndex([]), "a", "b")).toEqual({ rule: DEFAULT_TRANSITION_RULE, index: -1, tier: 4, key: "*>*" });
  });

  it("L-F2a: a listed *>* rule replaces the default rule", () => {
    const r = resolveTransition(buildRuleIndex([rule("*", "*", { exit: "immediate" })]), "a", "b");
    expect(r.index).toBe(0);
    expect(r.rule.exit).toBe("immediate");
    expect(r.key).toBe("*>*");
  });

  it("L-F2a: ids that name no rule fall through to the wildcard tiers", () => {
    const index = buildRuleIndex([rule("a", "b"), rule("a", "*"), rule("*", "b"), rule("*", "*")]);
    expect(resolveTransition(index, "x", "b")).toMatchObject({ index: 2, tier: 3 });
    expect(resolveTransition(index, "a", "x")).toMatchObject({ index: 1, tier: 2 });
    expect(resolveTransition(index, "x", "y")).toMatchObject({ index: 3, tier: 4 });
  });

  it("L-F2a: a duplicate (same from and to) warns once, names the earlier rule, and is kept", () => {
    const { node, problems } = parseRoot({ transitions: [{ from: "a", to: "b" }, { from: "a", to: "b", exit: "immediate" }] });
    expect(node.transitions).toHaveLength(2);
    const dup = problems.filter((p) => /duplicate/i.test(p));
    expect(dup).toHaveLength(1);
    expect(dup[0]).toContain("root.transitions[1]");
    expect(dup[0]).toContain("root.transitions[0]");
  });

  it("L-F2a: a rule shadowed by an earlier one warns (a later a>* when every a>x pair has its own tier-1 rule)", () => {
    // a>a, a>b, a>c each win their pair, so the later a>* wins no pair of children a, b, c.
    const shadowed = parseRoot({ transitions: [{ from: "a", to: "a" }, { from: "a", to: "b" }, { from: "a", to: "c" }, { from: "a" }] });
    expect(at(shadowed.problems, "root.transitions[3]").some((p) => /shadow/i.test(p))).toBe(true);
    // Control: a>a has no rule, so a>* still wins the a>a pair.
    const control = parseRoot({ transitions: [{ from: "a", to: "b" }, { from: "a", to: "c" }, { from: "a" }] });
    expect(control.problems.some((p) => /shadow/i.test(p))).toBe(false);
  });

  it("L-F2a: a tier-3 *>b rule shadowed by tier-2 rules for every from warns; a rule that still wins one pair does not", () => {
    // a>*, b>*, c>* cover every from of the pairs ending in b, so *>b wins none.
    const shadowed = parseRoot({ transitions: [{ from: "a" }, { from: "b" }, { from: "c" }, { to: "b" }] });
    expect(at(shadowed.problems, "root.transitions[3]").some((p) => /shadow/i.test(p))).toBe(true);
    // Control: c>b is left to *>b, which wins it.
    const control = parseRoot({ transitions: [{ from: "a" }, { from: "b" }, { to: "b" }] });
    expect(control.problems.some((p) => /shadow/i.test(p))).toBe(false);
  });

  it("L-F2a: a duplicate is reported as a duplicate, not also as shadowed", () => {
    const a = analyzeTransitionRules([rule("a", "b"), rule("a", "b", { exit: "immediate" })], ["a", "b"]);
    expect(a.duplicates).toEqual([{ index: 1, of: 0 }]);
    expect(a.shadowed).toEqual([]);
    expect(a.effective).toEqual([0]);
    const parsed = parseRoot({ transitions: [{ from: "a", to: "b" }, { from: "a", to: "b" }] });
    expect(parsed.problems.some((p) => /shadow/i.test(p))).toBe(false);
  });

  it("L-F2a: analyzeTransitionRules lists effective rules, and a pair of a child with itself counts", () => {
    const full = analyzeTransitionRules([rule("a", "a"), rule("a", "*"), rule("*", "*")], ["a", "b"]);
    expect(full.effective).toEqual([0, 1, 2]);
    expect(full.shadowed).toEqual([]);
    // With the only child `a`, the single pair (a, a) is the self pair: a>a wins it and a>* is shadowed by it.
    const self = analyzeTransitionRules([rule("a", "a"), rule("a", "*")], ["a"]);
    expect(self.effective).toEqual([0]);
    expect(self.shadowed).toEqual([{ index: 1, by: 0 }]);
  });

  it("L-F2a: ruleIndexFor returns the same index for the same transitions array and a fresh one for a new array", () => {
    const arr = [rule("a", "b")];
    const first = ruleIndexFor({ transitions: arr });
    expect(ruleIndexFor({ transitions: arr })).toBe(first);
    expect(ruleIndexFor({ transitions: [...arr] })).not.toBe(first);
  });
});

describe("transitions: limits (§2.4)", () => {
  it("L-F2a: 256 rules parse; the 257th and later are dropped with one problem", () => {
    const ids = Array.from({ length: 16 }, (_, i) => `c${i}`);
    const children = ids.map((id) => seg(id));
    const pairs: Raw[] = [];
    for (const from of ids) for (const to of ids) pairs.push({ from, to });
    const ok = parseRoot({ transitions: pairs }, children);
    expect(ok.node.transitions).toHaveLength(256);
    expect(ok.problems).toEqual([]);
    // Four more rules, each a duplicate of the first row: all dropped, and only the cap is reported.
    const over = parseRoot({ transitions: [...pairs, { from: "c0", to: "c0" }, { from: "c0", to: "c1" }, { from: "c0", to: "c2" }, { from: "c0", to: "c3" }] }, children);
    expect(over.node.transitions).toHaveLength(256);
    expect(over.problems).toHaveLength(1);
    expect(over.problems[0]).toContain("at most 256");
  });

  it("L-F2a: transitions on a segment are ignored with a problem", () => {
    const { problems } = parseRoot({}, [seg("a", { transitions: [{}] }), seg("b")]);
    expect(at(problems, "root.children[0].transitions").length).toBeGreaterThan(0);
    // Control: the same key on the container is read.
    expect(at(parseRoot({ transitions: [{}] }, [seg("a"), seg("b")]).problems, "transitions")).toEqual([]);
  });
});

describe("stingers (§2.5)", () => {
  it("L-F2a: a stinger reads trigger, segment, at, dontRepeat, ifTooLate, volume and bus", () => {
    const { node, problems } = parseRoot({
      library: [seg("hit")],
      stingers: [{ trigger: "secret", segment: "hit", at: "bar", dontRepeat: 2, ifTooLate: "playNow", volume: 0.5, bus: "Sfx" }],
    });
    expect(problems).toEqual([]);
    expect(node.stingers).toEqual([{ trigger: "secret", segment: "hit", at: "bar", dontRepeat: 2, ifTooLate: "playNow", volume: 0.5, bus: "Sfx" }]);
  });

  it("L-F2a: defaults: at beat, dontRepeat 0, ifTooLate nextGrid, no volume, no bus", () => {
    const { node, problems } = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit" }] });
    expect(problems).toEqual([]);
    const s = node.stingers[0];
    expect(s).toEqual({ trigger: "t", segment: "hit", at: "beat", dontRepeat: 0, ifTooLate: "nextGrid" });
    expect(s?.volume).toBeUndefined();
    expect(s?.bus).toBeUndefined();
  });

  it("L-F2a: at accepts a grid spec, immediate and { cue }; anything else keeps the default with a problem", () => {
    for (const at_ of ["beat", "bar", { every: "bar", n: 8 }, "immediate", { cue: "hit" }] as const) {
      const { node, problems } = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", at: at_ }] });
      expect(node.stingers[0]?.at).toEqual(at_);
      expect(at(problems, "root.stingers[0].at")).toEqual([]);
    }
    const bad = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", at: "later" }] });
    expect(bad.node.stingers[0]?.at).toBe("beat");
    expect(at(bad.problems, "root.stingers[0].at")).toHaveLength(1);
  });

  it("L-F2a: ifTooLate accepts nextGrid, playNow and skip; anything else keeps nextGrid with a problem", () => {
    for (const ifTooLate of ["nextGrid", "playNow", "skip"]) {
      const { node, problems } = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", ifTooLate }] });
      expect(node.stingers[0]?.ifTooLate).toBe(ifTooLate);
      expect(problems).toEqual([]);
    }
    const bad = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", ifTooLate: "sometimes" }] });
    expect(bad.node.stingers[0]?.ifTooLate).toBe("nextGrid");
    expect(at(bad.problems, "root.stingers[0].ifTooLate")).toHaveLength(1);
  });

  it("L-F2a: dontRepeat is clamped to >= 0 with a problem; volume to 0..4", () => {
    const low = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", dontRepeat: -1 }] });
    expect(low.node.stingers[0]?.dontRepeat).toBe(0);
    expect(at(low.problems, "root.stingers[0].dontRepeat")).toHaveLength(1);
    const loud = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", volume: 9 }] });
    expect(loud.node.stingers[0]?.volume).toBe(4);
    expect(at(loud.problems, "root.stingers[0].volume")).toHaveLength(1);
    const quiet = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", volume: -1 }] });
    expect(quiet.node.stingers[0]?.volume).toBe(0);
    expect(at(quiet.problems, "root.stingers[0].volume")).toHaveLength(1);
    // Control: in range, nothing reported.
    const ok = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit", dontRepeat: 2, volume: 1 }] });
    expect(ok.problems).toEqual([]);
  });

  it("L-F2a: a stinger with no trigger or no segment is dropped with a problem", () => {
    const { node, problems } = parseRoot({ library: [seg("hit")], stingers: [{ segment: "hit" }, { trigger: "t" }, { trigger: "t", segment: "hit" }] });
    expect(node.stingers.map((s) => s.trigger)).toEqual(["t"]);
    expect(at(problems, "root.stingers[0]").length).toBeGreaterThan(0);
    expect(at(problems, "root.stingers[1]").length).toBeGreaterThan(0);
  });

  it("L-F2a: a stinger whose segment is not in the container's library is dropped with a problem; one that is, kept", () => {
    const { node, problems } = parseRoot({ library: [seg("hit")], stingers: [{ trigger: "x", segment: "nope" }, { trigger: "y", segment: "hit" }] });
    expect(node.stingers.map((s) => s.trigger)).toEqual(["y"]);
    expect(at(problems, "root.stingers[0].segment")).toHaveLength(1);
  });

  it("L-F2a: 32 stingers parse; the 33rd and later are dropped with one problem", () => {
    const list = (n: number) => Array.from({ length: n }, (_, i) => ({ trigger: `t${i}`, segment: "hit" }));
    const exact = parseRoot({ library: [seg("hit")], stingers: list(32) });
    expect(exact.node.stingers).toHaveLength(32);
    expect(exact.problems).toEqual([]);
    const over = parseRoot({ library: [seg("hit")], stingers: list(34) });
    expect(over.node.stingers).toHaveLength(32);
    expect(over.node.stingers[31]?.trigger).toBe("t31");
    expect(over.problems).toHaveLength(1);
    expect(over.problems[0]).toContain("at most 32");
  });

  it("L-F2a: stingers on a segment are ignored with a problem", () => {
    const { problems } = parseRoot({}, [seg("a", { stingers: [{ trigger: "t", segment: "b" }] }), seg("b")]);
    expect(at(problems, "root.children[0].stingers").length).toBeGreaterThan(0);
    // Control: the same key on the container is read.
    expect(at(parseRoot({ library: [seg("hit")], stingers: [{ trigger: "t", segment: "hit" }] }).problems, "stingers")).toEqual([]);
  });

  it("L-F2a: resolveStinger: the deepest container above the playing segment wins, then list order", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT,
      root: {
        type: "playlist", id: "outer", library: [seg("s1"), seg("s2")],
        stingers: [{ trigger: "hit", segment: "s1" }, { trigger: "hit", segment: "s2" }],
        children: [{ type: "playlist", id: "inner", library: [seg("s3")], stingers: [{ trigger: "hit", segment: "s3" }], children: [seg("leaf")] }],
      },
    });
    expect(problems).toEqual([]);
    const outer = eventRootNode(value) as PlaylistNode;
    const inner = outer.children[0] as PlaylistNode;
    const deep = resolveStinger([outer, inner], "hit");
    expect(deep?.container).toBe(inner);
    expect(deep?.index).toBe(0);
    expect(deep?.segment.id).toBe("s3");
    const list = resolveStinger([outer], "hit");
    expect(list?.container).toBe(outer);
    expect(list?.index).toBe(0);
    expect(list?.segment.id).toBe("s1");
  });

  it("L-F2a: resolveStinger: the same trigger name on two containers is one namespace (no problem), an unknown trigger gives null", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT,
      root: {
        type: "playlist", id: "outer", library: [seg("s1")], stingers: [{ trigger: "hit", segment: "s1" }],
        children: [{ type: "playlist", id: "inner", library: [seg("s2")], stingers: [{ trigger: "hit", segment: "s2" }], children: [seg("leaf")] }],
      },
    });
    expect(problems).toEqual([]);
    const outer = eventRootNode(value) as PlaylistNode;
    const inner = outer.children[0] as PlaylistNode;
    expect(resolveStinger([outer, inner], "nope")).toBeNull();
    expect(resolveStinger([outer, inner], "hit")?.container).toBe(inner);
  });

  it("L-F2a: musicTriggers lists every trigger of the tree once, sorted", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT,
      root: {
        type: "playlist", id: "outer", library: [seg("s")],
        stingers: [{ trigger: "zeta", segment: "s" }, { trigger: "alpha", segment: "s" }],
        children: [{ type: "playlist", id: "inner", library: [seg("t")], stingers: [{ trigger: "alpha", segment: "t" }, { trigger: "mid", segment: "t" }], children: [seg("leaf")] }],
      },
    });
    expect(problems).toEqual([]);
    expect(musicTriggers(eventRootNode(value))).toEqual(["alpha", "mid", "zeta"]);
  });

  it("L-F2a: the format limits MAX_CONCURRENT_STINGERS is 4 and the steal fade 5 ms", () => {
    expect(MAX_CONCURRENT_STINGERS).toBe(4);
    expect(STINGER_STEAL_FADE_SECONDS).toBe(0.005);
  });
});

describe("library (§2.5)", () => {
  it("L-F2a: library segments are not children and are not reachable as a rule from or to", () => {
    const { node, problems } = parseRoot({ library: [seg("riser")], transitions: [{ from: "riser", to: "b" }, { from: "a", to: "riser" }] });
    expect(node.children.map((c) => c.id)).toEqual(["a", "b", "c"]);
    expect(node.library.map((s) => s.id)).toEqual(["riser"]);
    expect(node.transitions).toEqual([]);
    expect(at(problems, "root.transitions[0].from")).toHaveLength(1);
    expect(at(problems, "root.transitions[1].to")).toHaveLength(1);
  });

  it("L-F2a: library segment ids share the event's id namespace (a clash with a child id is dropped with a problem)", () => {
    const { node, problems } = parseRoot({ library: [seg("a"), seg("lib")] });
    expect(node.library.map((s) => s.id)).toEqual(["lib"]);
    expect(at(problems, "root.library[0]")).toHaveLength(1);
    // Control: a free id is kept.
    expect(parseRoot({ library: [seg("lib")] }).node.library.map((s) => s.id)).toEqual(["lib"]);
  });

  it("L-F2a: 64 library segments parse; the 65th is dropped with a problem", () => {
    const lib = Array.from({ length: 65 }, (_, i) => seg(`l${i}`));
    const over = parseRoot({ library: lib });
    expect(over.node.library).toHaveLength(64);
    expect(over.problems.filter((p) => p.includes("at most 64"))).toHaveLength(1);
    const exact = parseRoot({ library: lib.slice(0, 64) });
    expect(exact.node.library).toHaveLength(64);
    expect(exact.problems).toEqual([]);
  });

  it("L-F2a: the cap is 64 per event: two containers with 40 each keep 64 in all, with one problem", () => {
    const { value, problems } = parseAudioEvent({
      format: AUDIO_EVENT_FORMAT,
      root: {
        type: "playlist", id: "outer", library: Array.from({ length: 40 }, (_, i) => seg(`o${i}`)),
        children: [{ type: "playlist", id: "inner", library: Array.from({ length: 40 }, (_, i) => seg(`i${i}`)), children: [seg("leaf")] }],
      },
    });
    const outer = eventRootNode(value) as PlaylistNode;
    const inner = outer.children[0] as PlaylistNode;
    expect(outer.library.length + inner.library.length).toBe(64);
    expect(problems).toHaveLength(1);
  });

  it("L-F2a: a library entry that is not a segment is dropped with a problem", () => {
    const { node, problems } = parseRoot({ library: [{ type: "clip", id: "c", clip: "x.ogg" }, seg("ok")] });
    expect(node.library.map((s) => s.id)).toEqual(["ok"]);
    expect(at(problems, "root.library[0]")).toHaveLength(1);
  });

  it("L-F2a: library segments count against the event's node budget (MAX_EVENT_NODES)", () => {
    // 1 root + 255 playlists of 3 segments = 1021 nodes: only 3 of the 10 library segments fit under 1024.
    const children = Array.from({ length: 255 }, (_, i) => ({ type: "playlist", id: `c${i}`, children: [seg(`c${i}a`), seg(`c${i}b`), seg(`c${i}c`)] }));
    const library = Array.from({ length: 10 }, (_, i) => seg(`l${i}`));
    const { value, problems } = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: { type: "playlist", id: "p", children, library } });
    const root = eventRootNode(value) as PlaylistNode;
    expect([...eventNodes(root)].length).toBeLessThanOrEqual(MAX_EVENT_NODES);
    expect(root.library.length).toBeLessThan(10);
    expect(problems.some((p) => p.includes("root.library[") && p.includes("node"))).toBe(true);
  });

  it("L-F2a: musicClips lists the library segments' clips", () => {
    const { node, problems } = parseRoot({ library: [seg("riser")] });
    expect(problems).toEqual([]);
    expect(musicClips(node)).toEqual(["a.ogg", "b.ogg", "c.ogg", "riser.ogg"]);
    expect(eventClips(parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: { type: "playlist", id: "p", children: [seg("a")], library: [seg("riser")] } }).value)).toContain("riser.ogg");
  });
});

describe("writer round trips (§2.4, §2.5)", () => {
  // Every rule and stinger key set off its default, a library segment, and a cue for each `enter: { cue }`.
  const writerRoot = {
    type: "playlist", id: "p",
    children: [seg("a"), seg("b", { cues: [{ name: "entry", at: "1:1:0" }] }), seg("c")],
    library: [seg("riser"), seg("hit")],
    transitions: [
      {
        from: "a", to: "b", exit: { every: "bar", n: 2 }, enter: { cue: "entry" },
        fadeOut: { seconds: 2, offset: -0.5, curve: "linear" }, fadeIn: { beats: 2, curve: "sCurve" },
        bridge: { segment: "riser", fadeOut: { beats: 1 } },
      },
      { from: "c", exit: "immediate", enter: "sameTime" },
    ],
    stingers: [
      { trigger: "secret", segment: "hit", at: { cue: "entry" }, dontRepeat: 2, ifTooLate: "skip", volume: 0.5, bus: "Sfx" },
      { trigger: "beat", segment: "hit", at: { every: "beat", n: 4 } },
    ],
  };

  it("L-F2a: parse(write(x)) equals x for a container with rules, stingers and a library, and the text is idempotent", () => {
    const first = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: writerRoot });
    expect(first.problems).toEqual([]);
    const root = eventRootNode(first.value) as PlaylistNode;
    expect(root.transitions).toHaveLength(2);
    expect(root.stingers).toHaveLength(2);
    expect(root.library).toHaveLength(2);
    const text = formatAudioEvent(first.value);
    const second = parseAudioEvent(JSON.parse(text));
    expect(second.value).toEqual(first.value);
    expect(formatAudioEvent(second.value)).toBe(text);
  });

  it("L-F2a: the writer omits defaults (a default rule writes {}, a default stinger only trigger and segment)", () => {
    expect(transitionToJson(DEFAULT_TRANSITION_RULE)).toEqual({});
    expect(stingerToJson({ trigger: "t", segment: "s", at: "beat", dontRepeat: 0, ifTooLate: "nextGrid" })).toEqual({ trigger: "t", segment: "s" });
    // Control: a non-default key is written.
    expect(stingerToJson({ trigger: "t", segment: "s", at: "beat", dontRepeat: 2, ifTooLate: "nextGrid" })).toEqual({ trigger: "t", segment: "s", dontRepeat: 2 });
  });

  it("L-F2a: the written keys of a rule are in a stable order: from, to, exit, enter, fadeOut, fadeIn, bridge", () => {
    const json = transitionToJson({
      from: "a", to: "b", exit: "immediate", enter: { cue: "hit" },
      fadeOut: { unit: "seconds", amount: 2, offset: -0.5, curve: "linear" },
      fadeIn: { unit: "beats", amount: 3, offset: 0, curve: "sCurve" },
      bridge: { segment: "riser", fadeOut: { unit: "beats", amount: 1, offset: 0, curve: "equalPower" } },
    });
    expect(Object.keys(json)).toEqual(["from", "to", "exit", "enter", "fadeOut", "fadeIn", "bridge"]);
  });

  it("L-F2a: a written event re-parses with no problems", () => {
    const first = parseAudioEvent({ format: AUDIO_EVENT_FORMAT, root: writerRoot });
    const root = eventRootNode(first.value) as PlaylistNode;
    expect(root.transitions).toHaveLength(2);
    expect(root.stingers).toHaveLength(2);
    const text = formatAudioEvent(first.value);
    expect(parseAudioEvent(JSON.parse(text)).problems).toEqual([]);
  });
});
