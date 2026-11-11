// Ed6 (api-and-models §7, §2.4): the model behind the rules table of a music container. Pure: no DOM, no clock, never
// throws. The grid is `rows` (from) by `columns` (to), each the container's direct children in list order plus the
// wildcard `*` last; a cell holds the rule that wins that pair, taken from R1's `matchInContainer` (the same result as
// F2's `resolveTransition`), so the highlight equals what the runtime resolves. L-Ed6a fills every stub tagged
// `L-Ed6a` and un-skips `rulesModel.test.ts`.

import { RULE_WILDCARD, type RuleTier, type TransitionRule } from "../../../../engine/audio/musicRules";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";

/** One cell of the grid: the rule that wins the pair (`from`, `to`). `from` and `to` are child ids or `"*"`. */
export interface RuleCell {
  readonly from: string;
  readonly to: string;
  /** Index into the container's `transitions`; -1 for the always-present default rule. */
  readonly rule: number;
  readonly tier: RuleTier;
  /** `"from>to"` of the winning rule (`"*>*"` for the default). */
  readonly ruleKey: string;
  /** True when the winning rule is the default (index -1). */
  readonly isDefault: boolean;
}

/** One header: a direct child of the container, or the wildcard. */
export interface RuleHeader {
  /** The child id, or `"*"`. */
  readonly id: string;
  /** What the header shows: the child's `id`, or `"*"`. */
  readonly label: string;
  readonly isWildcard: boolean;
}

/** The whole grid of one container. `cells[r][c]` is the cell of `rows[r]` by `columns[c]`. */
export interface RulesGrid {
  /** The container's id. */
  readonly container: string;
  /** `from` headers: the children, then `*`. */
  readonly rows: readonly RuleHeader[];
  /** `to` headers: the children, then `*`. */
  readonly columns: readonly RuleHeader[];
  readonly cells: readonly (readonly RuleCell[])[];
  /** Rule indices that win at least one pair of two children (the `effective` list of `analyzeTransitionRules`). */
  readonly effective: readonly number[];
}

/** The "why" readout for a chosen pair (`from`, `to`). */
export interface RuleReadout {
  readonly from: string;
  readonly to: string;
  readonly rule: number;
  readonly tier: RuleTier;
  /** e.g. `"Tier 2: from named"`. */
  readonly tierText: string;
  /** e.g. `"Rule 3 (explore>*)"`, or `"The default rule"` for index -1. */
  readonly ruleText: string;
  /** The winning rule itself (the default rule for -1), for its exit, enter, fades and bridge. */
  readonly transition: Readonly<TransitionRule>;
  /** `"exit: bar, enter: entryCue"` style one-liner of the rule's exit and enter as R1 shows them. */
  readonly summary: string;
  /** The rule indices that also match the pair but lose, ascending (a lower tier, or later in the list). */
  readonly beatenRules: readonly number[];
}

/** The tier names the readout uses: 1 `pair`, 2 `from named`, 3 `to named`, 4 `*>*`. */
export const TIER_TEXT: Readonly<Record<RuleTier, string>> = {
  1: "Tier 1: pair (from and to named)",
  2: "Tier 2: from named",
  3: "Tier 3: to named",
  4: "Tier 4: * to * (or the default rule)",
};

/**
 * The headers of a container: its direct children's ids in list order, then `*`. A container with no children has just
 * `*`. L-Ed6a.
 */
export function ruleHeaders(container: MusicContainerNode): RuleHeader[] {
  void container;
  throw new Error("L-Ed6a: ruleHeaders not implemented");
}

/**
 * The effective rule of the pair (`from`, `to`) of `container`: `matchInContainer(container, from, to)` read into a
 * cell. A `*` header resolves as the id `"*"` (it matches only wildcard rules). L-Ed6a.
 */
export function effectiveRule(container: MusicContainerNode, from: string, to: string): RuleCell {
  void container; void from; void to;
  throw new Error("L-Ed6a: effectiveRule not implemented");
}

/** The full grid of `container`: every row by every column, plus `effective` from `analyzeTransitionRules`. L-Ed6a. */
export function buildRulesGrid(container: MusicContainerNode): RulesGrid {
  void container;
  throw new Error("L-Ed6a: buildRulesGrid not implemented");
}

/** The readout of the pair (`from`, `to`): tier text, rule text, the rule, and the rules it beat. L-Ed6a. */
export function explainPair(container: MusicContainerNode, from: string, to: string): RuleReadout {
  void container; void from; void to;
  throw new Error("L-Ed6a: explainPair not implemented");
}

/**
 * Whether rule `index` of `container.transitions` matches the pair (`from`, `to`): its `from` is `*` or equals `from`,
 * and its `to` is `*` or equals `to`. Used for `beatenRules` and for marking a rule's row in the list. L-Ed6a.
 */
export function ruleMatchesPair(rule: Pick<TransitionRule, "from" | "to">, from: string, to: string): boolean {
  void rule; void from; void to;
  throw new Error("L-Ed6a: ruleMatchesPair not implemented");
}

export { RULE_WILDCARD };
