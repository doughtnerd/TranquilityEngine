// Ed7 (api-and-models §7, §2.4): the edits of a container's transition rules as pure functions of the container (the
// refused-or-next `EditResult`, ADR 0307: the next container or a one-line reason it was refused), validated against the
// same limits the parser clamps to, so what a form writes survives `formatAudioEvent` / `parseAudioEvent` unchanged.
// `RuleEditor.tsx` and `RulesTable.tsx` apply a result through the event's asset document (one undo step per edit, a
// refusal in the status bar).
import { DEFAULT_TRANSITION_RULE, FADE_CURVES, GRID_EVERY_MAX, GRID_EVERY_MIN, MAX_FADE_BEATS, MAX_FADE_SECONDS, RULE_WILDCARD, type TransitionEnter, type TransitionExit, type TransitionFade, type TransitionRule } from "../../../../engine/audio/musicRules";
import { MUSIC_LIMITS, type MusicContainerNode } from "../../../../engine/audio/musicFormat";
import type { GridSpec } from "../../../../engine/audio/musicTypes";
import { endSegments } from "./ruleLint";
import { accept, refuse, type EditResult } from "../editResult";

/** The next container, or why the edit was refused (nothing changes). */
type RuleEdit = EditResult<MusicContainerNode>;
const ok = (container: MusicContainerNode): RuleEdit => accept(container);
const fail = refuse;

const freshRule = (): TransitionRule => ({
  from: RULE_WILDCARD, to: RULE_WILDCARD, exit: DEFAULT_TRANSITION_RULE.exit, enter: DEFAULT_TRANSITION_RULE.enter,
  fadeOut: { ...DEFAULT_TRANSITION_RULE.fadeOut }, fadeIn: { ...DEFAULT_TRANSITION_RULE.fadeIn },
});

function withRule(container: MusicContainerNode, index: number, change: (r: TransitionRule) => TransitionRule | string): RuleEdit {
  const rule = container.transitions[index];
  if (!rule) return fail("that rule does not exist");
  const next = change(rule);
  if (typeof next === "string") return fail(next);
  const transitions = container.transitions.slice();
  transitions[index] = next;
  return ok({ ...container, transitions });
}

/** Append a default rule `*` to `*` (at the end of the list; a later rule never beats an earlier one in its tier). */
export function addRule(container: MusicContainerNode, init: Partial<Pick<TransitionRule, "from" | "to">> = {}): RuleEdit {
  if (container.transitions.length >= MUSIC_LIMITS.rules) return fail(`at most ${MUSIC_LIMITS.rules} rules`);
  const rule = { ...freshRule(), ...init };
  const bad = endProblem(container, rule.from, "from") ?? endProblem(container, rule.to, "to");
  if (bad) return fail(bad);
  return ok({ ...container, transitions: [...container.transitions, rule] });
}

/** Copy rule `index` right after itself (it then repeats the original, which the lint flags until its ends change). */
export function duplicateRule(container: MusicContainerNode, index: number): RuleEdit {
  const rule = container.transitions[index];
  if (!rule) return fail("that rule does not exist");
  if (container.transitions.length >= MUSIC_LIMITS.rules) return fail(`at most ${MUSIC_LIMITS.rules} rules`);
  const copy = structuredClone(rule);
  const transitions = container.transitions.slice();
  transitions.splice(index + 1, 0, copy);
  return ok({ ...container, transitions });
}

export function removeRule(container: MusicContainerNode, index: number): RuleEdit {
  if (!container.transitions[index]) return fail("that rule does not exist");
  return ok({ ...container, transitions: container.transitions.filter((_, i) => i !== index) });
}

/** Move rule `index` by `delta` places (list order breaks ties inside a tier). */
export function moveRule(container: MusicContainerNode, index: number, delta: number): RuleEdit {
  const to = index + delta;
  if (!container.transitions[index]) return fail("that rule does not exist");
  if (to < 0 || to >= container.transitions.length) return fail("the rule is already at that end of the list");
  const transitions = container.transitions.slice();
  const [rule] = transitions.splice(index, 1);
  transitions.splice(to, 0, rule);
  return ok({ ...container, transitions });
}

function endProblem(container: MusicContainerNode, id: string, key: "from" | "to"): string | null {
  if (id === RULE_WILDCARD || container.children.some((c) => c.id === id)) return null;
  return `${key} must be * or the id of a direct child of ${container.id}`;
}

export function setRuleEnds(container: MusicContainerNode, index: number, ends: { from?: string; to?: string }): RuleEdit {
  return withRule(container, index, (r) => {
    const next = { ...r, ...ends };
    const bad = (ends.from !== undefined ? endProblem(container, next.from, "from") : null) ?? (ends.to !== undefined ? endProblem(container, next.to, "to") : null);
    return bad ?? next;
  });
}

/** A grid exit `"beat"`, `"bar"` or `{ every, n }`, validated like the parser (n a whole number 2..64). */
export function gridSpec(every: "beat" | "bar", n: number | null): EditResult<GridSpec> {
  if (n === null || n === 1) return accept(every);
  if (!Number.isInteger(n) || n < GRID_EVERY_MIN || n > GRID_EVERY_MAX) return refuse(`every needs a whole number ${GRID_EVERY_MIN}..${GRID_EVERY_MAX} (or 1 for each ${every})`);
  return accept({ every, n });
}

export function setExit(container: MusicContainerNode, index: number, exit: TransitionExit): RuleEdit {
  if (typeof exit === "object") {
    if (exit.every !== "beat" && exit.every !== "bar") return fail("exit grid must count beats or bars");
    if (!Number.isInteger(exit.n) || exit.n < GRID_EVERY_MIN || exit.n > GRID_EVERY_MAX) return fail(`exit every needs a whole number ${GRID_EVERY_MIN}..${GRID_EVERY_MAX}`);
  }
  return withRule(container, index, (r) => ({ ...r, exit }));
}

export function setEnter(container: MusicContainerNode, index: number, enter: TransitionEnter): RuleEdit {
  if (typeof enter === "object" && enter.cue.trim() === "") return fail("a cue name is needed");
  return withRule(container, index, (r) => {
    if (typeof enter === "object" && r.to !== RULE_WILDCARD) {
      const targets = endSegments(container, r.to);
      if (targets.length > 0 && !targets.some((s) => s.cues.some((c) => c.name === enter.cue))) return `${r.to} has no cue named “${enter.cue}”`;
    }
    return { ...r, enter };
  });
}

export type FadeSlot = "fadeOut" | "fadeIn" | "bridgeFadeOut" | "bridgeFadeIn";

/** `fade` checked like the parser: amount 0..64 beats or 0..60 s, offset within the same bound either way, a known curve. */
export function checkFade(fade: TransitionFade): string | null {
  const max = fade.unit === "beats" ? MAX_FADE_BEATS : MAX_FADE_SECONDS;
  if (!Number.isFinite(fade.amount) || fade.amount < 0 || fade.amount > max) return `the fade must be 0..${max} ${fade.unit}`;
  if (!Number.isFinite(fade.offset) || fade.offset < -max || fade.offset > max) return `the offset must be -${max}..${max} ${fade.unit}`;
  if (!(FADE_CURVES as readonly string[]).includes(fade.curve)) return `the curve must be one of ${FADE_CURVES.join(", ")}`;
  return null;
}

/** Change part of a fade. Changing the unit keeps the amount and offset numbers (they are re-checked against the new bound). */
export function setFade(container: MusicContainerNode, index: number, slot: FadeSlot, patch: Partial<TransitionFade>): RuleEdit {
  return withRule(container, index, (r) => {
    const current: TransitionFade | undefined = slot === "fadeOut" ? r.fadeOut : slot === "fadeIn" ? r.fadeIn : slot === "bridgeFadeOut" ? r.bridge?.fadeOut : r.bridge?.fadeIn;
    if ((slot === "bridgeFadeOut" || slot === "bridgeFadeIn") && !r.bridge) return "the rule has no bridge";
    const base = current ?? (slot === "bridgeFadeIn" ? r.fadeIn : slot === "bridgeFadeOut" ? r.fadeOut : DEFAULT_TRANSITION_RULE.fadeOut);
    const fade: TransitionFade = { ...base, ...patch };
    const bad = checkFade(fade);
    if (bad) return bad;
    switch (slot) {
      case "fadeOut": return { ...r, fadeOut: fade };
      case "fadeIn": return { ...r, fadeIn: fade };
      case "bridgeFadeOut": return { ...r, bridge: { ...r.bridge!, fadeOut: fade } };
      case "bridgeFadeIn": return { ...r, bridge: { ...r.bridge!, fadeIn: fade } };
    }
  });
}

/** Give the bridge its own fade (copied from the rule's) or take it back to the rule's own. */
export function setBridgeOwnFade(container: MusicContainerNode, index: number, which: "fadeOut" | "fadeIn", own: boolean): RuleEdit {
  return withRule(container, index, (r) => {
    if (!r.bridge) return "the rule has no bridge";
    const bridge = { ...r.bridge };
    if (own) bridge[which] = { ...r[which] };
    else delete bridge[which];
    return { ...r, bridge };
  });
}

/** Set the bridge to a library segment, or remove it with null. */
export function setBridge(container: MusicContainerNode, index: number, segment: string | null): RuleEdit {
  return withRule(container, index, (r) => {
    if (segment === null) {
      const { bridge: _bridge, ...rest } = r;
      return rest;
    }
    if (!container.library.some((s) => s.id === segment)) return `“${segment}” is not in ${container.id}'s library`;
    return { ...r, bridge: { ...(r.bridge ?? {}), segment } };
  });
}
