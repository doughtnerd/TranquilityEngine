// Ed7 (api-and-models §7, §2.4): the lint of a container's transition rules. Pure: no DOM, no clock, never throws.
// The duplicate and shadow rows come from `analyzeTransitionRules` (the same answer the parser warns with and R1
// resolves with); the rest read the rule against the container's children and library. Clip lengths are optional
// facts (`LintContext.lengthOf`): a row that needs a length stays quiet until it is known.
import { analyzeTransitionRules, ruleKey, RULE_WILDCARD, type TransitionFade } from "../../../../engine/audio/musicRules";
import { isMusicContainer, type MusicContainerNode, type MusicNode, type SegmentNode } from "../../../../engine/audio/musicFormat";
import { buildRulesGrid } from "./rulesModel";

export type RuleLintCode =
  | "duplicate" | "shadowed" | "unreachable" | "wildcardOnly"
  | "missingFrom" | "missingTo" | "missingBridge" | "missingCue" | "noCues"
  | "bridgeEmpty" | "bridgeMetre" | "bridgeTempo" | "bridgeLength"
  | "fadeTooLong" | "exitIgnored";

export interface RuleLintIssue {
  readonly code: RuleLintCode;
  /** `error`: the parser drops the rule, or it cannot play. `warn`: it plays, probably not as meant. `info`: a fact. */
  readonly severity: "error" | "warn" | "info";
  /** Index into the container's `transitions`. */
  readonly rule: number;
  /** The field the row is about (`from`, `to`, `exit`, `enter`, `fadeOut`, `fadeIn`, `bridge`), when it is one. */
  readonly field?: string;
  readonly message: string;
}

export interface LintContext {
  /** The audio length in seconds of a segment (any of its stems' decoded length), or undefined while unknown. */
  readonly lengthOf?: (segmentId: string) => number | undefined;
}

/** Every segment under `node` (itself when it is one), in tree order. */
export function leafSegments(node: MusicNode): SegmentNode[] {
  if (node.type === "segment") return [node];
  return isMusicContainer(node) ? node.children.flatMap(leafSegments) : [];
}

/** The segments an end of a rule (`from` or `to`) can mean: the named child's, or every direct child's for `*`. */
export function endSegments(container: MusicContainerNode, id: string): SegmentNode[] {
  if (id === RULE_WILDCARD) return container.children.flatMap(leafSegments);
  const child = container.children.find((c) => c.id === id);
  return child ? leafSegments(child) : [];
}

/** Seconds of a fade on `segment`: beats at its first marker's tempo (a beat is `60 / bpm` seconds). */
export function fadeSeconds(fade: TransitionFade, segment: SegmentNode): number {
  if (fade.unit === "seconds") return fade.amount;
  const bpm = segment.tempo[0]?.bpm;
  return bpm && bpm > 0 ? (fade.amount * 60) / bpm : NaN;
}

const fmt = (n: number): string => (Math.round(n * 100) / 100).toString();

/** The rows for every rule of `container`, by rule index then code. */
export function lintTransitionRules(container: MusicContainerNode, context: LintContext = {}): RuleLintIssue[] {
  const out: RuleLintIssue[] = [];
  const rules = container.transitions;
  const childIds = container.children.map((c) => c.id);
  const known = new Set(childIds);
  const library = new Map(container.library.map((s) => [s.id, s]));
  const add = (rule: number, code: RuleLintCode, severity: RuleLintIssue["severity"], message: string, field?: string): void => {
    out.push(field === undefined ? { code, severity, rule, message } : { code, severity, rule, field, message });
  };
  const lengthOf = context.lengthOf ?? (() => undefined);

  const analysis = analyzeTransitionRules(rules, childIds);
  for (const d of analysis.duplicates) add(d.index, "duplicate", "warn", `Repeats rule ${d.of} (same from and to, ${ruleKey(rules[d.index])}); the first one wins, this never applies.`);
  const grid = buildRulesGrid(container);
  const winsCell = new Set(grid.cells.flat().map((c) => c.rule));
  // The analysis calls a rule shadowed when it wins no pair of two children; one that still wins a `*` cell applies to
  // children added later, which is a note and not a warning (the rules table says the same).
  const wildcardOnly = new Set(analysis.shadowed.filter((s) => winsCell.has(s.index)).map((s) => s.index));
  for (const s of analysis.shadowed) {
    if (wildcardOnly.has(s.index)) continue;
    add(s.index, "shadowed", "warn", `Shadowed by ${s.by < 0 ? "the default rule" : `rule ${s.by}`}: it wins no pair of children, so it never applies.`);
  }
  const effective = new Set(analysis.effective);
  const flagged = new Set([...analysis.duplicates.map((d) => d.index), ...analysis.shadowed.filter((s) => !wildcardOnly.has(s.index)).map((s) => s.index)]);

  const playlist = container.type === "playlist";
  rules.forEach((r, i) => {
    // Missing targets (the parser drops these; the editor shows them while a hand-edited file still has them).
    let dangling = false;
    for (const key of ["from", "to"] as const) {
      if (r[key] !== RULE_WILDCARD && !known.has(r[key])) {
        dangling = true;
        add(i, key === "from" ? "missingFrom" : "missingTo", "error", `“${r[key]}” is not a direct child of this container.`, key);
      }
    }
    if (r.bridge && !library.has(r.bridge.segment)) add(i, "missingBridge", "error", `Bridge “${r.bridge.segment}” is not in this container's library.`, "bridge");

    // Reachability.
    if (!dangling && !flagged.has(i)) {
      const to = r.to === RULE_WILDCARD ? null : container.children.find((c) => c.id === r.to);
      if (container.type === "musicSwitch" && to && to.value === undefined) {
        add(i, "unreachable", "warn", `“${r.to}” has no value, so the switch's parameter can never pick it: nothing changes to it.`, "to");
      } else if (!effective.has(i) && winsCell.has(i)) {
        add(i, "wildcardOnly", "info", "Wins no pair of two children; only * cells, so it applies to children added later.");
      } else if (!effective.has(i) && !winsCell.has(i) && childIds.length === 0) {
        add(i, "unreachable", "warn", "The container has no children, so no change reaches this rule.");
      }
    }

    // Enter and exit cues.
    if (typeof r.enter === "object") {
      const cue = r.enter.cue;
      const targets = endSegments(container, r.to);
      if (r.to !== RULE_WILDCARD && targets.length > 0 && !targets.some((s) => s.cues.some((c) => c.name === cue))) {
        add(i, "missingCue", "error", `${r.to} has no cue named “${cue}”.`, "enter");
      } else if (r.to === RULE_WILDCARD && targets.length > 0 && !targets.some((s) => s.cues.some((c) => c.name === cue))) {
        add(i, "missingCue", "warn", `No child has a cue named “${cue}”.`, "enter");
      }
    }
    if (r.exit === "nextCue") {
      const from = endSegments(container, r.from);
      if (from.length > 0 && from.every((s) => s.cues.length === 0)) add(i, "noCues", "warn", `Exit is nextCue but ${r.from === RULE_WILDCARD ? "no child" : r.from} has no cues.`, "exit");
    }
    if (playlist && !dangling && r.exit !== "bar") add(i, "exitIgnored", "info", "A playlist advances at the exit cue, so this rule's exit is ignored there; its enter, fades and bridge apply.", "exit");

    // Fades longer than the audio they run over.
    const checkFade = (fade: TransitionFade, name: "fadeOut" | "fadeIn", segs: SegmentNode[]): void => {
      let shortest: { id: string; len: number } | null = null;
      for (const s of segs) {
        const len = lengthOf(s.id);
        if (len === undefined || !(len > 0)) continue;
        if (shortest === null || len < shortest.len) shortest = { id: s.id, len };
      }
      if (!shortest) return;
      const seg = segs.find((s) => s.id === shortest!.id)!;
      const secs = fadeSeconds(fade, seg);
      if (secs > shortest.len) add(i, "fadeTooLong", "warn", `${name} is ${fmt(secs)} s but ${shortest.id} is ${fmt(shortest.len)} s long.`, name);
    };
    checkFade(r.fadeOut, "fadeOut", endSegments(container, r.from));
    checkFade(r.fadeIn, "fadeIn", endSegments(container, r.to));

    // The bridge.
    const bridge = r.bridge ? library.get(r.bridge.segment) : undefined;
    if (r.bridge && bridge) {
      if (bridge.tracks.length === 0) add(i, "bridgeEmpty", "warn", `Bridge “${bridge.id}” has no stems, so it plays nothing.`, "bridge");
      const first = bridge.tempo[0];
      const target = endSegments(container, r.to)[0];
      const t = target?.tempo[0];
      if (first && t) {
        if (first.beatsPerBar !== t.beatsPerBar || first.beatUnit !== t.beatUnit) {
          add(i, "bridgeMetre", "warn", `Bridge is in ${first.beatsPerBar}/${first.beatUnit} but ${target!.id} is in ${t.beatsPerBar}/${t.beatUnit}: the bars won't line up.`, "bridge");
        } else if (Math.abs(first.bpm - t.bpm) > 0.5) {
          add(i, "bridgeTempo", "warn", `Bridge is at ${fmt(first.bpm)} bpm but ${target!.id} is at ${fmt(t.bpm)}: the target starts on a different pulse.`, "bridge");
        }
      }
      const len = lengthOf(bridge.id);
      if (first && len !== undefined && len > 0) {
        const bar = (60 / first.bpm) * first.beatsPerBar * (4 / first.beatUnit);
        const bars = (len - bridge.gridOffset) / bar;
        if (bar > 0 && Math.abs(bars - Math.round(bars)) * bar > 0.01) {
          add(i, "bridgeLength", "warn", `Bridge is ${fmt(bars)} bars long; it should be a whole number of bars so ${r.to === RULE_WILDCARD ? "the target" : r.to} lands on a bar line.`, "bridge");
        }
        for (const [name, fade] of [["fadeOut", r.bridge.fadeOut], ["fadeIn", r.bridge.fadeIn]] as const) {
          if (!fade) continue;
          const secs = fadeSeconds(fade, bridge);
          if (secs > len) add(i, "fadeTooLong", "warn", `Bridge ${name} is ${fmt(secs)} s but the bridge is ${fmt(len)} s long.`, "bridge");
        }
      }
    }
  });
  const order: Record<RuleLintIssue["severity"], number> = { error: 0, warn: 1, info: 2 };
  return out.sort((a, b) => a.rule - b.rule || order[a.severity] - order[b.severity] || a.code.localeCompare(b.code));
}

/** The rows of one rule. */
export const issuesOfRule = (issues: readonly RuleLintIssue[], index: number): RuleLintIssue[] => issues.filter((x) => x.rule === index);

/** The worst severity among `issues`, or null. */
export function worstSeverity(issues: readonly RuleLintIssue[]): RuleLintIssue["severity"] | null {
  if (issues.some((x) => x.severity === "error")) return "error";
  if (issues.some((x) => x.severity === "warn")) return "warn";
  return issues.length > 0 ? "info" : null;
}
