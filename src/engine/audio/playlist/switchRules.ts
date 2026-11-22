/**
 * Switch change rules (ADR 0329 "Switch"; the prototype's PL:894): which rule applies when the label goes from one value
 * to another. Each rule scores per side: an exact label 2, `"*"` 0, anything else rules it out. The highest total wins
 * and the first listed breaks ties; with no match the Switch's `onChange` applies.
 *
 * Pure; no plugin, no DOM.
 */
import type { ChangeHow, ChangeRule, SwitchSettings } from "./types";

/** The score of one side of a rule, or -1 when it doesn't match. */
const side = (pattern: string, label: string): number => (pattern === "*" ? 0 : pattern === label ? 2 : -1);

/** The best rule for `from` → `to`, or null when none matches. */
export function matchChangeRule(rules: readonly ChangeRule[], from: string, to: string): ChangeRule | null {
  let best: ChangeRule | null = null;
  let bestScore = -1;
  for (const r of rules) {
    const a = side(r.from, from), b = side(r.to, to);
    if (a < 0 || b < 0) continue;
    if (a + b > bestScore) { best = r; bestScore = a + b; }
  }
  return best;
}

/** What happens for `from` → `to`: the best rule, else `onChange`. */
export function changeFor(s: Pick<SwitchSettings, "rules" | "onChange">, from: string, to: string): ChangeHow {
  return matchChangeRule(s.rules, from, to) ?? s.onChange;
}
