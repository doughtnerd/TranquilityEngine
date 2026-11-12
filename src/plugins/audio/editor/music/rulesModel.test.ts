// Ed6: the rules table's model. Every case is the L-Ed6a leaf's to fill and un-skip. Build containers by hand (a
// `MusicContainerNode` literal with segment children) or through `parseMusicContainerHead` / `parseAudioEvent`.
import { describe, expect, it } from "vitest";
import { parseAudioEvent } from "../../../../engine/audio/eventFormat";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";
import { analyzeTransitionRules, DEFAULT_TRANSITION_RULE, RULE_WILDCARD } from "../../../../engine/audio/musicRules";
import { matchInContainer } from "../../runtime/music/transitionRules";
import {
  buildRulesGrid, effectiveRule, explainPair, ruleHeaders, ruleMatchesPair, TIER_TEXT,
} from "./rulesModel";

type Raw = Record<string, unknown>;

/** A playlist `p` over the segment children `children` (default a, b, c) with the given raw `transitions`. */
function container(transitions: Raw[], children: string[] = ["a", "b", "c"]): MusicContainerNode {
  const root = {
    type: "playlist", id: "p",
    children: children.map((id) => ({ type: "segment", id, tracks: [{ name: "a", clip: `music/${id}.ogg` }] })),
    transitions,
  };
  const { value } = parseAudioEvent({ format: "myco.audioevent@1", bus: "Music", root });
  if (!value.musicRoot || (value.musicRoot.type !== "playlist" && value.musicRoot.type !== "musicSwitch")) {
    throw new Error("not a music container");
  }
  return value.musicRoot as MusicContainerNode;
}

/**
 * Children a, b, c and rules with every tier, a duplicate and a shadowed rule (list order, index in brackets):
 *   [0] a>b (tier 1, immediate)      [1] a>b (duplicate of 0)        [2] a>* (tier 2)
 *   [3] b>* (tier 2)                 [4] *>c (tier 3)                [5] *>a (tier 3)
 *   [6] *>* (tier 4)                 [7] c>b (tier 1, shadows 6 on c>b)
 */
const FIXTURE: Raw[] = [
  { from: "a", to: "b", exit: "immediate" },
  { from: "a", to: "b", exit: "nextCue" },
  { from: "a", exit: "exitCue" },
  { from: "b" },
  { to: "c", enter: "sameTime" },
  { to: "a" },
  {},
  { from: "c", to: "b" },
];
const IDS = ["a", "b", "c"];

describe("ruleHeaders (L-Ed6a)", () => {
  it("lists the direct children in order, then the wildcard", () => {
    expect(ruleHeaders(container(FIXTURE))).toEqual([
      { id: "a", label: "a", isWildcard: false },
      { id: "b", label: "b", isWildcard: false },
      { id: "c", label: "c", isWildcard: false },
      { id: RULE_WILDCARD, label: RULE_WILDCARD, isWildcard: true },
    ]);
  });
  it("a container with no children has only the wildcard", () => {
    expect(ruleHeaders(container([], []))).toEqual([{ id: RULE_WILDCARD, label: RULE_WILDCARD, isWildcard: true }]);
  });
});

describe("effectiveRule (L-Ed6a)", () => {
  it("the effective rule per pair equals transitionRules", () => {
    const c = container(FIXTURE);
    const headers = [...IDS, RULE_WILDCARD];
    for (const from of headers) {
      for (const to of headers) {
        const cell = effectiveRule(c, from, to);
        const m = matchInContainer(c, from, to);
        expect({ from, to, rule: cell.rule, tier: cell.tier, ruleKey: cell.ruleKey })
          .toEqual({ from, to, rule: m.rule, tier: m.tier, ruleKey: m.ruleKey });
      }
    }
  });
  it("a pair no rule matches resolves to the default rule: index -1, tier 4, key '*>*', isDefault", () => {
    const c = container([{ from: "a", to: "b" }]);
    expect(effectiveRule(c, "c", "c")).toEqual({
      from: "c", to: "c", rule: -1, tier: 4, ruleKey: "*>*", isDefault: true,
    });
  });
  it("the first listed rule wins inside a tier", () => {
    // Tier 1 (a>b listed twice): index 0 wins. Tier 2 (a>* listed twice): index 0 wins.
    const pair = container([{ from: "a", to: "b", exit: "immediate" }, { from: "a", to: "b", exit: "nextCue" }]);
    expect(effectiveRule(pair, "a", "b")).toMatchObject({ rule: 0, tier: 1, ruleKey: "a>b", isDefault: false });
    const from = container([{ from: "a", exit: "exitCue" }, { from: "a" }]);
    expect(effectiveRule(from, "a", "b")).toMatchObject({ rule: 0, tier: 2, ruleKey: "a>*" });
    // Tier 3 (*>c listed twice) and tier 4 (two *>*): the first wins.
    const to = container([{ to: "c", enter: "sameTime" }, { to: "c" }]);
    expect(effectiveRule(to, "b", "c")).toMatchObject({ rule: 0, tier: 3, ruleKey: "*>c" });
  });
  it("a * header only matches wildcard rules", () => {
    const c = container([{ from: "a", to: "b" }, { from: "a" }, { to: "b" }]);
    // The named-from rules never match the * header; only the wildcard-from rule `*>b` does.
    expect(effectiveRule(c, RULE_WILDCARD, "b")).toMatchObject({ rule: 2, tier: 3, ruleKey: "*>b" });
    expect(effectiveRule(c, RULE_WILDCARD, "c")).toMatchObject({ rule: -1, tier: 4, isDefault: true });
    expect(effectiveRule(c, "a", RULE_WILDCARD)).toMatchObject({ rule: 1, tier: 2, ruleKey: "a>*" });
  });
});

describe("buildRulesGrid (L-Ed6a)", () => {
  it("is (children + 1) square, cells[r][c] is the cell of rows[r] by columns[c]", () => {
    const c = container(FIXTURE);
    const grid = buildRulesGrid(c);
    expect(grid.container).toBe("p");
    expect(grid.rows).toHaveLength(4);
    expect(grid.columns).toHaveLength(4);
    expect(grid.cells).toHaveLength(4);
    grid.cells.forEach((row, r) => {
      expect(row).toHaveLength(4);
      row.forEach((cell, col) => {
        expect(cell.from).toBe(grid.rows[r].id);
        expect(cell.to).toBe(grid.columns[col].id);
        expect(cell).toEqual(effectiveRule(c, grid.rows[r].id, grid.columns[col].id));
      });
    });
  });
  it("effective equals analyzeTransitionRules(...).effective", () => {
    const c = container(FIXTURE);
    const grid = buildRulesGrid(c);
    expect(grid.effective).toEqual(analyzeTransitionRules(c.transitions, IDS).effective);
    // Rule 1 (duplicate), 6 (shadowed by 7 on c>b) and 5 (*>a) are checked against the analysis, not hand-listed.
    expect(grid.effective).toEqual([0, 2, 3, 4, 5, 7]);
  });
  it("an empty container gives a 1x1 grid holding the default rule", () => {
    const grid = buildRulesGrid(container([], []));
    expect(grid.rows.map((h) => h.id)).toEqual([RULE_WILDCARD]);
    expect(grid.columns.map((h) => h.id)).toEqual([RULE_WILDCARD]);
    expect(grid.cells).toHaveLength(1);
    expect(grid.cells[0]).toHaveLength(1);
    expect(grid.cells[0][0]).toMatchObject({ from: "*", to: "*", rule: -1, tier: 4, ruleKey: "*>*", isDefault: true });
    expect(grid.effective).toEqual([]);
  });
});

describe("explainPair (L-Ed6a)", () => {
  it("names the tier and the rule index and key of the winner", () => {
    const readout = explainPair(container(FIXTURE), "a", "b");
    expect(readout).toMatchObject({
      from: "a", to: "b", rule: 0, tier: 1,
      tierText: TIER_TEXT[1], ruleText: "Rule 0 (a>b)", summary: "exit: immediate, enter: entryCue",
    });
    expect(readout.transition).toMatchObject({ from: "a", to: "b", exit: "immediate" });
  });
  it("the default rule reads 'The default rule', tier 4, index -1", () => {
    const readout = explainPair(container([{ from: "a", to: "b" }]), "c", "c");
    expect(readout).toMatchObject({
      rule: -1, tier: 4, tierText: TIER_TEXT[4], ruleText: "The default rule", beatenRules: [],
    });
    expect(readout.transition).toEqual(DEFAULT_TRANSITION_RULE);
  });
  it("beatenRules lists the other matching rules ascending, never the winner", () => {
    // a>b matches rules 0 (winner), 1 (duplicate), 2 (a>*) and 6 (*>*); 3, 4, 5, 7 do not match it.
    expect(explainPair(container(FIXTURE), "a", "b").beatenRules).toEqual([1, 2, 6]);
    // c>b: rule 7 wins; rule 6 (*>*) also matches and loses.
    expect(explainPair(container(FIXTURE), "c", "b")).toMatchObject({ rule: 7, beatenRules: [6] });
  });
});

describe("ruleMatchesPair (L-Ed6a)", () => {
  it("a wildcard side matches any id; a named side matches only itself", () => {
    expect(ruleMatchesPair({ from: "*", to: "*" }, "x", "y")).toBe(true);
    expect(ruleMatchesPair({ from: "*", to: "*" }, RULE_WILDCARD, RULE_WILDCARD)).toBe(true);
    expect(ruleMatchesPair({ from: "a", to: "*" }, "a", "y")).toBe(true);
    expect(ruleMatchesPair({ from: "a", to: "*" }, "b", "y")).toBe(false);
    expect(ruleMatchesPair({ from: "a", to: "*" }, RULE_WILDCARD, "y")).toBe(false);
    expect(ruleMatchesPair({ from: "*", to: "b" }, "x", "b")).toBe(true);
    expect(ruleMatchesPair({ from: "*", to: "b" }, "x", "c")).toBe(false);
  });
});
