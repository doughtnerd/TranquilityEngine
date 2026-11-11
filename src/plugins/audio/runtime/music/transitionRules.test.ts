/**
 * R1's rule engine at play time (api-and-models §2.4, §1.6 `pending`; architecture §3.2). Leaf **L-R1a** fills the
 * skipped cases; R1 fills `transitionRules.ts`. Build fixtures from JSON through the format's own parser (`music`
 * below), so the rules carry every default exactly as the runtime sees them. Times: heard seconds unless a name says
 * file seconds or ticks; compare seconds with `toBeCloseTo(x, 9)` and frames and ticks exactly.
 *
 * Expected values are computed by hand from the spec and the doc comments, not by G1 helpers: at 120 bpm 4/4 one beat
 * is 0.5 s and one tick is 1/1920 s, a bar is 2 s (3840 ticks); at 60 bpm one beat is 1 s and a 3/4 bar 3 s.
 */
import { describe, expect, it } from "vitest";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicNode, PlaylistNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { compileSegmentGrid, type SegmentGrid } from "../../../../engine/audio/musicGrid";
import {
  DEFAULT_TRANSITION_RULE, type TransitionEnter, type TransitionExit, type TransitionRule,
} from "../../../../engine/audio/musicRules";
import {
  enterFrame, enterPoint, exitTime, findRule, heardTimeAt, resolveFades, ruleIndexOf, ticksAtHeard,
  type GridAt, type PlayingGrid, type RuleMatch,
} from "./transitionRules";

type Raw = Record<string, unknown>;

/** The music root of an event whose `root` is `root` (the format's parser fills every default). */
function music(root: unknown): MusicNode {
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root });
  if (!value.musicRoot) throw new Error("not a music root");
  return value.musicRoot;
}

/** A segment's compiled grid, `endSeconds` its file length (G1). */
function grid(seg: SegmentNode, endSeconds?: number): SegmentGrid {
  return compileSegmentGrid(seg, { endSeconds });
}

/** A segment child with one track (ids must be unique per event). */
const seg = (id: string, extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  type: "segment", id, tracks: [{ name: "a", clip: `music/${id}.ogg` }], ...extra,
});

/** A playlist `p` over the children (default a, b, c) with its `transitions` and `library`. */
const tree = (transitions: Raw[], children: Raw[] = [seg("a"), seg("b"), seg("c")], library: Raw[] = []): MusicNode =>
  music({ type: "playlist", id: "p", children, transitions, library });

/** The transitions of a playlist root. */
const rulesOf = (root: MusicNode): TransitionRule[] => (root as PlaylistNode).transitions;

/** Segment `a` (or `id`) of a one-child playlist, compiled: `extra` its keys, `endSeconds` its file length. */
function gridOf(extra: Raw = {}, endSeconds?: number, id = "a"): SegmentGrid {
  const root = music({ type: "playlist", id: "p", children: [seg(id, extra)] }) as PlaylistNode;
  return grid(root.children[0] as SegmentNode, endSeconds);
}

/** A grid position: the grid and the ticks the segment is at (for an exit point T or an incoming side). */
const at = (g: SegmentGrid, ticks: number): GridAt => ({ grid: g, ticks });

/** The playing segment's grid with its anchor (default: file 0 is heard at 0). */
const playing = (g: SegmentGrid, anchorTicks = 0, anchorTime = 0): PlayingGrid => ({ grid: g, anchorTicks, anchorTime });

/** The text `RuleMatch.exit` shows for a rule's exit (§2.4 `exit`, `RuleMatch`). */
const exitText = (e: TransitionExit): string => {
  if (typeof e === "string") return e;
  return e.every === "bar" ? `${e.n} bars` : `${e.n} beats`;
};

/** The text `RuleMatch.enter` shows for a rule's enter. */
const enterText = (e: TransitionEnter): string => (typeof e === "string" ? e : `cue:${e.cue}`);

/**
 * A match for one rule (`over` its own fields, the rest the default), built the way `findRule` reports one. Used where
 * a test feeds a match straight to `exitTime`, `enterPoint`, `enterFrame` or `resolveFades`.
 */
function matchOf(over: Partial<TransitionRule> = {}): RuleMatch {
  const transition: TransitionRule = { ...DEFAULT_TRANSITION_RULE, from: "a", to: "b", ...over };
  return {
    rule: 0, ruleKey: "a>b", tier: 1, parent: "p",
    exit: exitText(transition.exit), enter: enterText(transition.enter),
    bridge: transition.bridge?.segment ?? null, transition,
  };
}

describe("findRule: §2.4 precedence in one container", () => {
  it("L-R1a: no rules gives the default rule (index -1, tier 4, *>*, exit bar, enter entryCue, 1 beat equalPower fades)", () => {
    const m = findRule(tree([]), "a", "b");
    expect(m).toMatchObject({ rule: -1, ruleKey: "*>*", tier: 4, parent: "p", exit: "bar", enter: "entryCue", bridge: null });
    expect(m.transition).toEqual(DEFAULT_TRANSITION_RULE);
    expect(m.transition.fadeOut).toEqual({ unit: "beats", amount: 1, offset: 0, curve: "equalPower" });
  });

  it("L-R1a: tier 1 (pair) beats tier 2, 3 and 4 listed before it", () => {
    const list: Raw[] = [
      { exit: "beat" },                           // 0: tier 4
      { to: "b", exit: "exitCue" },               // 1: tier 3
      { from: "a", exit: "nextCue" },             // 2: tier 2
      { from: "a", to: "b", exit: "immediate" },  // 3: tier 1
    ];
    expect(findRule(tree(list), "a", "b")).toMatchObject({ rule: 3, ruleKey: "a>b", tier: 1, parent: "p", exit: "immediate" });
    // Control: without the pair, the tier 2 rule wins the same change.
    expect(findRule(tree(list.slice(0, 3)), "a", "b")).toMatchObject({ rule: 2, tier: 2 });
  });

  it("L-R1a: tier 2 (from named) beats tier 3 (to named) and tier 4 whatever the order", () => {
    const listed: Raw[] = [{ to: "b", exit: "exitCue" }, { exit: "beat" }, { from: "a", exit: "nextCue" }];
    expect(findRule(tree(listed), "a", "b")).toMatchObject({ rule: 2, tier: 2, ruleKey: "a>*", exit: "nextCue" });
    const reversed: Raw[] = [{ from: "a", exit: "nextCue" }, { exit: "beat" }, { to: "b", exit: "exitCue" }];
    expect(findRule(tree(reversed), "a", "b")).toMatchObject({ rule: 0, tier: 2, ruleKey: "a>*", exit: "nextCue" });
  });

  it("L-R1a: tier 3 (to named) beats tier 4", () => {
    const list: Raw[] = [{ exit: "beat" }, { to: "b", exit: "exitCue" }];
    expect(findRule(tree(list), "a", "b")).toMatchObject({ rule: 1, tier: 3, ruleKey: "*>b", exit: "exitCue" });
    // Control: a change to another child is not matched by the to-rule.
    expect(findRule(tree(list), "a", "c")).toMatchObject({ rule: 0, tier: 4, ruleKey: "*>*" });
  });

  it("L-R1a: tier 4 *>* listed beats the default rule (index >= 0)", () => {
    const m = findRule(tree([{ exit: "beat" }]), "a", "b");
    expect(m).toMatchObject({ rule: 0, tier: 4, ruleKey: "*>*", exit: "beat" });
    expect(findRule(tree([]), "a", "b").rule).toBe(-1);
  });

  it("L-R1a: the first listed wins inside a tier (duplicate pair, two from-rules, two to-rules)", () => {
    expect(findRule(tree([{ from: "a", to: "b", exit: "beat" }, { from: "a", to: "b", exit: "nextCue" }]), "a", "b"))
      .toMatchObject({ rule: 0, tier: 1, exit: "beat" });
    expect(findRule(tree([{ from: "a", exit: "beat" }, { from: "a", exit: "exitCue" }]), "a", "c"))
      .toMatchObject({ rule: 0, tier: 2, exit: "beat" });
    expect(findRule(tree([{ to: "b", exit: "beat" }, { to: "b", exit: "exitCue" }]), "c", "b"))
      .toMatchObject({ rule: 0, tier: 3, exit: "beat" });
  });

  it("L-R1a: a change from a child to itself matches a rule naming it on both sides", () => {
    const list: Raw[] = [{ from: "a", to: "a", exit: "beat" }, { from: "a", exit: "exitCue" }];
    expect(findRule(tree(list), "a", "a")).toMatchObject({ rule: 0, tier: 1, ruleKey: "a>a", exit: "beat" });
    // Control: a change from a to b does not take the pair a>a.
    expect(findRule(tree(list), "a", "b")).toMatchObject({ rule: 1, tier: 2, ruleKey: "a>*" });
  });

  it("L-R1a: the match reports rule index, ruleKey, tier, parent id, exit and enter text, bridge id, and the rule", () => {
    const root = tree(
      [{ from: "a", to: "b", exit: "nextCue", enter: { cue: "intro" }, bridge: { segment: "riser" } }],
      [seg("a"), seg("b", { cues: [{ name: "intro", at: "1:1:0" }] }), seg("c")],
      [seg("riser")],
    );
    const m = findRule(root, "a", "b");
    expect(m).toMatchObject({ rule: 0, ruleKey: "a>b", tier: 1, parent: "p", exit: "nextCue", enter: "cue:intro", bridge: "riser" });
    expect(m.transition).toEqual(rulesOf(root)[0]);
  });

  it("L-R1a: exit and enter text: \"bar\", \"beat\", \"immediate\", \"nextCue\", \"exitCue\", { every } grids, \"cue:<name>\"", () => {
    // Each exit kind and grid spec, one rule per tree.
    const exits: [TransitionExit, string][] = [
      ["bar", "bar"], ["beat", "beat"], ["immediate", "immediate"], ["nextCue", "nextCue"], ["exitCue", "exitCue"],
      [{ every: "bar", n: 2 }, "2 bars"], [{ every: "beat", n: 4 }, "4 beats"],
    ];
    for (const [exit, text] of exits) {
      expect(findRule(tree([{ from: "a", to: "b", exit }]), "a", "b").exit).toBe(text);
    }
    // Each enter kind: the cue exists in b, so the rule is kept whole.
    const withCue = (): Raw[] => [seg("a"), seg("b", { cues: [{ name: "intro", at: "1:1:0" }] }), seg("c")];
    const enters: [TransitionEnter, string][] = [["entryCue", "entryCue"], ["sameTime", "sameTime"], [{ cue: "intro" }, "cue:intro"]];
    for (const [enter, text] of enters) {
      expect(findRule(tree([{ from: "a", to: "b", enter }], withCue()), "a", "b").enter).toBe(text);
    }
  });

  it("L-R1a: the precedence table: every ordered pair of three children against one mixed rule list", () => {
    const root = tree([
      { from: "c", to: "a", exit: "nextCue" },                 // 0: tier 1
      { from: "a", to: "b", exit: "exitCue" },                 // 1: tier 1
      { from: "a", exit: "beat" },                             // 2: tier 2
      { to: "c", exit: { every: "bar", n: 2 } },               // 3: tier 3
      { from: "b", exit: "immediate" },                        // 4: tier 2
      { to: "a", exit: "immediate" },                          // 5: tier 3, loses every pair it matches
      { exit: { every: "beat", n: 2 } },                       // 6: tier 4
    ]);
    // [from, to] -> [rule index, tier, ruleKey, exit text], worked by hand from the tiers.
    const table: [string, string, number, 1 | 2 | 3 | 4, string, string][] = [
      ["a", "a", 2, 2, "a>*", "beat"],
      ["a", "b", 1, 1, "a>b", "exitCue"],
      ["a", "c", 2, 2, "a>*", "beat"],
      ["b", "a", 4, 2, "b>*", "immediate"],
      ["b", "b", 4, 2, "b>*", "immediate"],
      ["b", "c", 4, 2, "b>*", "immediate"],
      ["c", "a", 0, 1, "c>a", "nextCue"],
      ["c", "b", 6, 4, "*>*", "2 beats"],
      ["c", "c", 3, 3, "*>c", "2 bars"],
    ];
    for (const [from, to, rule, tier, ruleKey, exit] of table) {
      expect(findRule(root, from, to), `${from}>${to}`).toMatchObject({ rule, tier, ruleKey, exit });
    }
  });

  it("L-R1a: ruleIndexOf returns the same index object for the same container, a fresh one for a reparsed asset", () => {
    const list: Raw[] = [{ from: "a", to: "b", exit: "beat" }];
    const root = tree(list);
    const first = ruleIndexOf(root);
    expect(ruleIndexOf(root)).toBe(first);
    expect(first.container).toBe("p");
    expect(first.pairs).toBeInstanceOf(Map);
    expect(ruleIndexOf(tree(list))).not.toBe(first);
  });
});

describe("findRule: nested containers (nearest common parent)", () => {
  /** Root `r` over the playlist `x` (p1, p2, with `xRules`), playlist `w` (q1) and segment `y`. */
  const nested = (rootRules: Raw[], xRules?: Raw[]): MusicNode => music({
    type: "playlist", id: "r", transitions: rootRules,
    children: [
      { type: "playlist", id: "x", children: [seg("p1"), seg("p2")], ...(xRules ? { transitions: xRules } : {}) },
      { type: "playlist", id: "w", children: [seg("q1")] },
      seg("y"),
    ],
  });

  it("L-R1a: segments under two different children of the root match in the root's table, by those children's ids", () => {
    const root = nested([{ from: "x", to: "w", exit: "beat" }]);
    expect(findRule(root, "p1", "q1")).toMatchObject({ rule: 0, ruleKey: "x>w", tier: 1, parent: "r", exit: "beat" });
    expect(findRule(root, "p2", "q1")).toMatchObject({ rule: 0, ruleKey: "x>w", tier: 1, parent: "r", exit: "beat" });
  });

  it("L-R1a: siblings deep inside one child match in that child's table, not the root's (parent is the inner id)", () => {
    const root = nested([{ from: "x", exit: "exitCue" }], [{ from: "p1", to: "p2", exit: "nextCue" }]);
    expect(findRule(root, "p1", "p2")).toMatchObject({ rule: 0, ruleKey: "p1>p2", tier: 1, parent: "x", exit: "nextCue" });
  });

  it("L-R1a: the inner table's default wins over a root rule naming the outer child (no fall-through upward)", () => {
    // The inner table holds its own *>* rule: it answers, not the root's x>* rule.
    const withInner = nested([{ from: "x", exit: "exitCue" }], [{ exit: "beat" }]);
    expect(findRule(withInner, "p1", "p2")).toMatchObject({ rule: 0, tier: 4, ruleKey: "*>*", parent: "x", exit: "beat" });
    // The inner table has no rules at all: the default rule, not the root's.
    const noInner = nested([{ from: "x", exit: "exitCue" }]);
    expect(findRule(noInner, "p1", "p2")).toMatchObject({ rule: -1, tier: 4, ruleKey: "*>*", exit: "bar" });
  });

  it("L-R1a: a target that is a container matches by that container's id", () => {
    const root = nested([{ to: "w", exit: "beat" }]);
    expect(findRule(root, "y", "w")).toMatchObject({ rule: 0, ruleKey: "*>w", tier: 3, parent: "r", exit: "beat" });
    // A segment inside the container is matched by the container's id too (the child that holds it).
    expect(findRule(root, "y", "q1")).toMatchObject({ rule: 0, ruleKey: "*>w", tier: 3, parent: "r" });
  });

  it("L-R1a: a segment root (no container) gives the default rule with parent \"\"", () => {
    const root = music(seg("s"));
    expect(findRule(root, "s", "s")).toMatchObject({ rule: -1, ruleKey: "*>*", tier: 4, parent: "" });
  });

  it("L-R1a: an unknown id gives the default rule", () => {
    // The root has a *>* rule; an id that is not a child must still give the default, not that rule.
    const root = tree([{ exit: "beat" }]);
    expect(findRule(root, "a", "nope")).toMatchObject({ rule: -1, tier: 4, ruleKey: "*>*", exit: "bar" });
    expect(findRule(root, "nope", "a")).toMatchObject({ rule: -1, tier: 4, ruleKey: "*>*", exit: "bar" });
  });
});

describe("exitTime under tempo maps", () => {
  it("L-R1a: exit bar: the next bar line at or after notBefore, in heard seconds through the anchor", () => {
    // 120 bpm 4/4 from file 0 (bar lines at 0, 2, 4 ... s).
    expect(exitTime(matchOf({ exit: "bar" }), playing(gridOf({}, 10)), 0.3, false)).toBeCloseTo(2.0, 9);
    // The anchor: file 0 is heard at 5 s, so heard 5.3 is file 0.3 and the bar line is heard at 7.0.
    expect(exitTime(matchOf({ exit: "bar" }), playing(gridOf({}, 10), 0, 5), 5.3, false)).toBeCloseTo(7.0, 9);
  });

  it("L-R1a: exit beat, { every: bar, n }, { every: beat, n }: the next such point", () => {
    const p = playing(gridOf({}, 10));
    // Beats are 0.5 s apart: the next beat at or after 0.3 s is beat 2 at 0.5 s.
    expect(exitTime(matchOf({ exit: "beat" }), p, 0.3, false)).toBeCloseTo(0.5, 9);
    // Bars 1, 3, 5 (bar number minus 1 a multiple of 2) fall at 0, 4, 8 s.
    expect(exitTime(matchOf({ exit: { every: "bar", n: 2 } }), p, 0.3, false)).toBeCloseTo(4.0, 9);
    expect(exitTime(matchOf({ exit: { every: "bar", n: 2 } }), p, 4.5, false)).toBeCloseTo(8.0, 9);
    // Beat indices 0, 4, 8 (multiples of 4 beats) fall at 0, 2, 4 s.
    expect(exitTime(matchOf({ exit: { every: "beat", n: 4 } }), p, 0.3, false)).toBeCloseTo(2.0, 9);
  });

  it("L-R1a: notBefore exactly on a bar line returns that line", () => {
    expect(exitTime(matchOf({ exit: "bar" }), playing(gridOf({}, 10)), 2.0, false)).toBeCloseTo(2.0, 9);
  });

  it("L-R1a: a bar exit across a tempo change (120 to 90 bpm) and a metre change (4/4 to 3/4) lands on the true bar line", () => {
    // Bars 1-2 at 120 4/4 (2 s each); from bar 3 at 60 bpm 3/4 (3 s each): bar lines at 0, 2, 4, 7, 10, 13 s.
    const g = gridOf({
      tempo: [
        { at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 },
        { at: "3:1:0", bpm: 60, beatsPerBar: 3, beatUnit: 4 },
      ],
    }, 20);
    expect(exitTime(matchOf({ exit: "bar" }), playing(g), 2.5, false)).toBeCloseTo(4.0, 9);
    expect(exitTime(matchOf({ exit: "bar" }), playing(g), 4.5, false)).toBeCloseTo(7.0, 9);
    expect(exitTime(matchOf({ exit: "bar" }), playing(g), 7.5, false)).toBeCloseTo(10.0, 9);
  });

  it("L-R1a: gridOffset (a pickup) and an anchor mid-segment both shift heard time correctly", () => {
    // Bar 1 beat 1 sits at file 0.5 s: bar lines at file 0.5, 2.5, 4.5 s. The anchor is bar 2 (tick 3840, file 2.5 s)
    // heard at 10 s, so heard(t) = 10 + file(t) - 2.5.
    const g = gridOf({ gridOffset: 0.5 }, 12);
    const p = playing(g, 3840, 10.0);
    expect(heardTimeAt(p, 3840)).toBeCloseTo(10.0, 9);
    expect(heardTimeAt(p, 0)).toBeCloseTo(8.0, 9); // bar 1 beat 1 is 2 s before the anchor
    // Heard 11.0 is file 3.5: the next bar line is file 4.5, heard 12.0.
    expect(exitTime(matchOf({ exit: "bar" }), p, 11.0, false)).toBeCloseTo(12.0, 9);
  });

  it("L-R1a: immediate returns notBefore", () => {
    expect(exitTime(matchOf({ exit: "immediate" }), playing(gridOf({}, 10)), 0.3, false)).toBeCloseTo(0.3, 9);
  });

  it("L-R1a: nextCue: the first cue at or after notBefore; none before the exit cue gives the exit cue", () => {
    // hit at 1:3:0 (1.0 s), drop at 3:1:0 (4.0 s), the exit cue at 5:1:0 (8.0 s).
    const g = gridOf({ cues: [{ name: "hit", at: "1:3:0" }, { name: "drop", at: "3:1:0" }, { name: "exit", at: "5:1:0" }] }, 10);
    const p = playing(g);
    expect(exitTime(matchOf({ exit: "nextCue" }), p, 0.3, false)).toBeCloseTo(1.0, 9);
    expect(exitTime(matchOf({ exit: "nextCue" }), p, 1.0, false)).toBeCloseTo(1.0, 9);
    expect(exitTime(matchOf({ exit: "nextCue" }), p, 1.5, false)).toBeCloseTo(4.0, 9);
    // No cue between 4.5 and the exit cue: the exit cue answers.
    expect(exitTime(matchOf({ exit: "nextCue" }), p, 4.5, false)).toBeCloseTo(8.0, 9);
    expect(exitTime(matchOf({ exit: "nextCue" }), p, 6.0, false)).toBeCloseTo(8.0, 9);
  });

  it("L-R1a: exitCue: the exit cue (named, default cue \"exit\", else the end with endSeconds)", () => {
    // Named by the segment's `exit` key: the cue "out" at 2:3:0 = 3.0 s.
    const named = gridOf({ exit: "out", cues: [{ name: "out", at: "2:3:0" }] }, 10);
    expect(exitTime(matchOf({ exit: "exitCue" }), playing(named), 0.3, false)).toBeCloseTo(3.0, 9);
    // No exit cue: the end of the audio, 10 s.
    expect(exitTime(matchOf({ exit: "exitCue" }), playing(gridOf({}, 10)), 0.3, false)).toBeCloseTo(10.0, 9);
  });

  it("L-R1a: the clamp: a grid point after the exit cue gives the exit cue", () => {
    // Exit cue "out" at 3.0 s; the bar line at 4.0 s is past it.
    const p = playing(gridOf({ exit: "out", cues: [{ name: "out", at: "2:3:0" }] }, 10));
    expect(exitTime(matchOf({ exit: "bar" }), p, 2.5, false)).toBeCloseTo(3.0, 9);
    expect(exitTime(matchOf({ exit: { every: "bar", n: 2 } }), p, 2.5, false)).toBeCloseTo(3.0, 9);
  });

  it("L-R1a: past the exit cue (notBefore after it) gives NaN; an unknown end gives NaN for exitCue", () => {
    const p = playing(gridOf({ exit: "out", cues: [{ name: "out", at: "2:3:0" }] }, 10));
    expect(exitTime(matchOf({ exit: "bar" }), p, 3.5, false)).toBeNaN();
    // Control: before the exit cue the same bar exit has a time (the bar line at 2.0 s).
    expect(exitTime(matchOf({ exit: "bar" }), p, 0.3, false)).toBeCloseTo(2.0, 9);
    // No end length known: the exit cue is the end, unknown, so exitCue has no time.
    expect(exitTime(matchOf({ exit: "exitCue" }), playing(gridOf({})), 0.3, false)).toBeNaN();
  });

  it("L-R1a: natural advance: the exit cue whatever the rule's exit, even when notBefore is later", () => {
    const p = playing(gridOf({ exit: "out", cues: [{ name: "out", at: "2:3:0" }] }, 10));
    // notBefore is after the exit cue here, and the rule asks for a grid point: a playlist advance still leaves at the cue.
    expect(exitTime(matchOf({ exit: "beat" }), p, 3.5, true)).toBeCloseTo(3.0, 9);
    expect(exitTime(matchOf({ exit: "immediate" }), p, 0.3, true)).toBeCloseTo(3.0, 9);
    expect(exitTime(matchOf({ exit: "bar" }), p, 0.3, true)).toBeCloseTo(3.0, 9);
  });

  it("L-R1a: heardTimeAt and ticksAtHeard are inverse across a tempo change", () => {
    // 120 bpm to bar 3, then 60 bpm (960 ticks per second from tick 7680, file 4.0 s).
    const g = gridOf({ tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, { at: "3:1:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] }, 20);
    const p = playing(g);
    expect(heardTimeAt(p, 7680)).toBeCloseTo(4.0, 9);
    expect(heardTimeAt(p, 8640)).toBeCloseTo(5.0, 9);
    expect(heardTimeAt(p, 8160)).toBeCloseTo(4.5, 9);
    expect(ticksAtHeard(p, 5.0)).toBeCloseTo(8640, 6);
    expect(ticksAtHeard(p, 4.5)).toBeCloseTo(8160, 6);
    // With an anchor: tick 3840 (file 2.0 s) heard at 7.0 s. Heard 9.0 is tick 7680; heard 8.0 is file 3.0 = tick 5760.
    const q = playing(g, 3840, 7.0);
    expect(heardTimeAt(q, 7680)).toBeCloseTo(9.0, 9);
    expect(ticksAtHeard(q, 9.0)).toBeCloseTo(7680, 6);
    expect(ticksAtHeard(q, 8.0)).toBeCloseTo(5760, 6);
  });
});

describe("enterPoint and enterFrame", () => {
  it("L-R1a: entryCue: start at file 0, preEntry = the entry cue's file seconds (gridOffset with entry 1:1:0)", () => {
    const incoming = gridOf({ gridOffset: 0.5 }, 12);
    const ep = enterPoint(matchOf({ enter: "entryCue" }), incoming, at(gridOf({}, 10), 0));
    expect(ep.seconds).toBe(0);
    expect(ep.preEntry).toBeCloseTo(0.5, 9);
    expect(ep.ticksAtExit).toBe(0);
  });

  it("L-R1a: entryCue on a cue at bar 3: preEntry includes the pickup and two bars at the incoming's tempo", () => {
    // Pickup 0.5 s, then bars 1 and 2 at 120 bpm (4 s): the entry at bar 3 is 4.5 s into the file.
    const incoming = gridOf({ gridOffset: 0.5, entry: "entry", cues: [{ name: "entry", at: "3:1:0" }] }, 12);
    const ep = enterPoint(matchOf({ enter: "entryCue" }), incoming, at(gridOf({}, 10), 0));
    expect(ep.seconds).toBe(0);
    expect(ep.preEntry).toBeCloseTo(4.5, 9);
    expect(ep.ticksAtExit).toBe(7680);
  });

  it("L-R1a: { cue }: start exactly at the cue, preEntry 0; a missing cue reads as entryCue", () => {
    // hit at 2:1:0 is 2.0 s into the grid, 2.5 s into the file.
    const incoming = gridOf({ gridOffset: 0.5, cues: [{ name: "hit", at: "2:1:0" }] }, 12);
    const out = at(gridOf({}, 10), 0);
    const hit = enterPoint(matchOf({ enter: { cue: "hit" } }), incoming, out);
    expect(hit.seconds).toBeCloseTo(2.5, 9);
    expect(hit.preEntry).toBe(0);
    expect(hit.ticksAtExit).toBe(3840);
    // No cue "nope": the same as entryCue (file 0, the pre-entry 0.5 s).
    const missing = enterPoint(matchOf({ enter: { cue: "nope" } }), incoming, out);
    expect(missing).toEqual({ seconds: 0, preEntry: enterPoint(matchOf({ enter: "entryCue" }), incoming, out).preEntry, ticksAtExit: 0 });
    expect(missing.preEntry).toBeCloseTo(0.5, 9);
  });

  it("L-R1a: sameTime: the outgoing's ticks since its entry, from the incoming's entry, preEntry 0", () => {
    // Incoming entry at 1:3:0 (tick 1920, 1.0 s). Outgoing entry at 1:1:0; at the exit point it is at 2:1:0 (tick 3840),
    // so 3840 ticks (2 s) have passed. Start: 1920 + 3840 = 5760 ticks = 3.0 s, no wrap (exit at the end, 10 s).
    const incoming = gridOf({ entry: "entry", cues: [{ name: "entry", at: "1:3:0" }] }, 10);
    const ep = enterPoint(matchOf({ enter: "sameTime" }), incoming, at(gridOf({}, 10), 3840));
    expect(ep.seconds).toBeCloseTo(3.0, 9);
    expect(ep.preEntry).toBe(0);
    expect(ep.ticksAtExit).toBe(5760);
  });

  it("L-R1a: sameTime past the incoming's exit cue wraps by its entry-to-exit length", () => {
    // Incoming entry 1:1:0 (0), exit cue at 2:1:0 (3840): the loop is 3840 ticks. The outgoing has 5760 ticks since its
    // entry; 5760 is past the exit, so it wraps by 3840 to 1920 ticks = 1.0 s.
    const incoming = gridOf({ cues: [{ name: "exit", at: "2:1:0" }] }, 10);
    const ep = enterPoint(matchOf({ enter: "sameTime" }), incoming, at(gridOf({}, 10), 5760));
    expect(ep.ticksAtExit).toBe(1920);
    expect(ep.seconds).toBeCloseTo(1.0, 9);
    expect(ep.preEntry).toBe(0);
  });

  it("L-R1a: ticksAtExit is the incoming position heard at T for each mode", () => {
    const incoming = gridOf({ entry: "entry", cues: [{ name: "entry", at: "1:3:0" }, { name: "hit", at: "2:1:0" }] }, 10);
    const out = at(gridOf({}, 10), 3840);
    // entryCue: the entry cue (1:3:0) is heard at T.
    expect(enterPoint(matchOf({ enter: "entryCue" }), incoming, out).ticksAtExit).toBe(1920);
    // sameTime: the entry plus the 3840 ticks the outgoing has played since its entry.
    expect(enterPoint(matchOf({ enter: "sameTime" }), incoming, out).ticksAtExit).toBe(5760);
    // {cue}: the cue itself (2:1:0) is heard at T.
    expect(enterPoint(matchOf({ enter: { cue: "hit" } }), incoming, out).ticksAtExit).toBe(3840);
  });

  it("L-R1a: enterFrame is round(seconds x rate) at 44.1 and 48 kHz", () => {
    // 90 bpm: 1440 ticks per second. The cue 1:1:1 is tick 1, at 1/1440 s.
    // 44100 / 1440 = 30.625 -> 31. 48000 / 1440 = 33.33 -> 33.
    const incoming = gridOf({ tempo: [{ at: "1:1:0", bpm: 90, beatsPerBar: 4, beatUnit: 4 }], cues: [{ name: "hit", at: "1:1:1" }] }, 10);
    const out = at(gridOf({}, 10), 0);
    const m = matchOf({ enter: { cue: "hit" } });
    expect(enterFrame(m, incoming, out, 44100)).toBe(31);
    expect(enterFrame(m, incoming, out, 48000)).toBe(33);
    // entryCue starts at file 0: frame 0 at any rate.
    expect(enterFrame(matchOf({ enter: "entryCue" }), incoming, out, 44100)).toBe(0);
  });
});

describe("resolveFades", () => {
  it("L-R1a: the default rule: 1 beat equalPower each way, 0.5 s at 120 bpm on both sides", () => {
    const r = resolveFades(matchOf(), at(gridOf({}, 10), 0), at(gridOf({}, 10), 0));
    expect(r.out.seconds).toBeCloseTo(0.5, 9);
    expect(r.out.offset).toBe(0);
    expect(r.out.curve).toBe("equalPower");
    expect(r.in.seconds).toBeCloseTo(0.5, 9);
    expect(r.in.offset).toBe(0);
    expect(r.in.curve).toBe("equalPower");
  });

  it("L-R1a: seconds fades pass through; curves pass through (linear, sCurve, equalPower)", () => {
    const r = resolveFades(matchOf({
      fadeOut: { unit: "seconds", amount: 0.75, offset: -0.25, curve: "linear" },
      fadeIn: { unit: "seconds", amount: 1.5, offset: 0.5, curve: "sCurve" },
    }), at(gridOf({}, 10), 0), at(gridOf({}, 10), 0));
    expect(r.out).toEqual({ seconds: 0.75, offset: -0.25, curve: "linear" });
    expect(r.in).toEqual({ seconds: 1.5, offset: 0.5, curve: "sCurve" });
    // Each curve name comes back as written, on a beat fade too.
    for (const curve of ["linear", "sCurve", "equalPower"] as const) {
      const c = resolveFades(matchOf({ fadeOut: { unit: "beats", amount: 1, offset: 0, curve } }), at(gridOf({}, 10), 0), at(gridOf({}, 10), 0));
      expect(c.out.curve).toBe(curve);
    }
  });

  it("L-R1a: a fade-out in beats uses the outgoing's tempo, a fade-in the incoming's (120 vs 90 bpm)", () => {
    const out = gridOf({}, 10);                                                                  // 120 bpm: a beat 0.5 s
    const into = gridOf({ tempo: [{ at: "1:1:0", bpm: 90, beatsPerBar: 4, beatUnit: 4 }] }, 10); // 90 bpm: a beat 2/3 s
    const r = resolveFades(matchOf(), at(out, 0), at(into, 0));
    expect(r.out.seconds).toBeCloseTo(0.5, 9);
    expect(r.in.seconds).toBeCloseTo(2 / 3, 9);
  });

  it("L-R1a: a 2-beat fade across a tempo change (one beat at 120, one at 60) lasts 0.5 + 1.0 s", () => {
    // 120 bpm for beat 1, 60 bpm from beat 2: the fade from T = 0 covers beat 1 (0.5 s) and beat 2 (1.0 s).
    const out = gridOf({ tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, { at: "1:2:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] }, 10);
    const r = resolveFades(matchOf({ fadeOut: { unit: "beats", amount: 2, offset: 0, curve: "equalPower" } }), at(out, 0), at(gridOf({}, 10), 0));
    expect(r.out.seconds).toBeCloseTo(1.5, 9);
    expect(r.out.offset).toBe(0);
  });

  it("L-R1a: a negative offset in beats starts the fade before T, converted at the tempo before T", () => {
    // 120 bpm for beats 1-2, 60 bpm from beat 3. T is tick 1920 (beat 3, 1.0 s). The fade is one beat, starting one beat
    // before T: the beat before T is at 120 bpm, so it starts 0.5 s before T and lasts 0.5 s.
    const out = gridOf({ tempo: [{ at: "1:1:0", bpm: 120, beatsPerBar: 4, beatUnit: 4 }, { at: "1:3:0", bpm: 60, beatsPerBar: 4, beatUnit: 4 }] }, 10);
    const r = resolveFades(matchOf({ fadeOut: { unit: "beats", amount: 1, offset: -1, curve: "equalPower" } }), at(out, 1920), at(gridOf({}, 10), 0));
    expect(r.out.offset).toBeCloseTo(-0.5, 9);
    expect(r.out.seconds).toBeCloseTo(0.5, 9);
  });

  it("L-R1a: a zero-length fade is a cut (0 s)", () => {
    const r = resolveFades(matchOf({ fadeOut: { unit: "beats", amount: 0, offset: 0, curve: "equalPower" } }), at(gridOf({}, 10), 0), at(gridOf({}, 10), 0));
    expect(r.out.seconds).toBe(0);
    expect(r.out.offset).toBe(0);
    // Control: a one-beat fade at the same tempo is 0.5 s.
    const one = resolveFades(matchOf(), at(gridOf({}, 10), 0), at(gridOf({}, 10), 0));
    expect(one.out.seconds).toBeCloseTo(0.5, 9);
  });

  it("L-R1a: legs: toBridge uses the rule's fades; fromBridge the bridge's, each defaulting to the rule's", () => {
    const out = at(gridOf({}, 10), 0), into = at(gridOf({}, 10), 0);
    const beats = (amount: number) => ({ unit: "beats" as const, amount, offset: 0, curve: "equalPower" as const });
    // The rule: 1 beat each way. The bridge: a 2-beat fade-out, no fade-in (so it takes the rule's).
    const m = matchOf({ fadeOut: beats(1), fadeIn: beats(1), bridge: { segment: "riser", fadeOut: beats(2) } });
    const direct = resolveFades(m, out, into);
    expect(direct.out.seconds).toBeCloseTo(0.5, 9);
    expect(direct.in.seconds).toBeCloseTo(0.5, 9);
    const to = resolveFades(m, out, into, "toBridge");
    expect(to.out.seconds).toBeCloseTo(0.5, 9);
    expect(to.in.seconds).toBeCloseTo(0.5, 9);
    const from = resolveFades(m, out, into, "fromBridge");
    expect(from.out.seconds).toBeCloseTo(1.0, 9);  // the bridge's fadeOut
    expect(from.in.seconds).toBeCloseTo(0.5, 9);   // no bridge fadeIn: the rule's
    // With a bridge fadeIn of 4 beats, the fromBridge leg takes it.
    const m2 = matchOf({ fadeOut: beats(1), fadeIn: beats(1), bridge: { segment: "riser", fadeIn: beats(4) } });
    expect(resolveFades(m2, out, into, "fromBridge").in.seconds).toBeCloseTo(2.0, 9);
    expect(resolveFades(m2, out, into, "toBridge").in.seconds).toBeCloseTo(0.5, 9);
  });
});
