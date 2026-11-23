// The Events tab's coverage report (ADR 0355 §7): the argument combinations an event has no line for, as compact
// patterns rather than an enumerated product. Walk the arguments in order; at each level split by label (a `*` path
// belongs to every branch; when every candidate has `*` there, the level stays one `*` branch); a prefix with no
// candidates is a gap (`Captain · * · *`); a branch whose first candidate is an explicit silence is intended silence.
// Per language: the covered combinations whose every candidate line is missing in that language (they'd play
// subtitle-only or nothing). Also lines no event names, events no script names (best effort over string literals), and
// the report as CSV. Pure; the walk stops at `COVERAGE_NODES` branches and says so.
import { compareBestMatch } from "../../../../engine/audio/dialogue/decide";
import { WILDCARD, type DialogueEvent } from "../../../../engine/audio/dialogue/types";
import { formatCsv } from "../csv";
import { labelsOf, type DialogueDoc, type EventContext } from "./eventsModel";

/** The most branches one event's walk visits. */
export const COVERAGE_NODES = 20_000;

export interface EventCoverage {
  readonly event: string;
  /** Combinations with no matching path. */
  readonly gaps: readonly string[];
  /** Combinations whose first candidate is an explicit silence. */
  readonly silences: readonly string[];
  /** Language → combinations whose candidate lines are all missing in it. */
  readonly languages: Readonly<Record<string, readonly string[]>>;
  /** The walk stopped at `COVERAGE_NODES`. */
  readonly truncated: boolean;
}

/** Shown between pattern entries. */
export const SEP = " · ";

/** One event's coverage; `recorded(key, code)` says whether a line has a file in the language's chain. */
export function eventCoverage(e: DialogueEvent, ctx: EventContext, languages: readonly string[], recorded: (key: string, code: string) => boolean): EventCoverage {
  const gaps: string[] = [];
  const silences: string[] = [];
  const byLanguage: Record<string, string[]> = Object.fromEntries(languages.map((c) => [c, []]));
  const n = e.arguments.length;
  const labels = e.arguments.map((a) => labelsOf(a, ctx));
  let nodes = 0;
  let truncated = false;
  const pattern = (prefix: readonly string[]) => [...prefix, ...Array(n - prefix.length).fill(WILDCARD)].join(SEP);
  const walk = (depth: number, prefix: string[], candidates: number[]): void => {
    if (++nodes > COVERAGE_NODES) return void (truncated = true);
    if (candidates.length === 0) return void gaps.push(pattern(prefix));
    const ordered = [...candidates].sort((a, b) => compareBestMatch(e.paths[a].path, e.paths[b].path) || a - b);
    const first = e.paths[ordered[0]];
    // Every candidate silent, or a certain silence first: nothing deeper changes that.
    if (candidates.every((i) => e.paths[i].lines.length === 0) || (depth === n && first.lines.length === 0 && first.probability >= 1)) return void silences.push(pattern(prefix));
    if (depth === n) {
      // Silences first in order end the decision; lines up to the first certain silence can be said.
      const keys: string[] = [];
      for (const i of ordered) {
        const p = e.paths[i];
        if (p.lines.length === 0 && p.probability >= 1) break;
        for (const l of p.lines) if (l.weight > 0) keys.push(l.key);
      }
      for (const c of languages) if (!keys.some((k) => recorded(k, c))) byLanguage[c].push(pattern(prefix));
      return;
    }
    if (candidates.every((i) => e.paths[i].path[depth] === WILDCARD)) return walk(depth + 1, [...prefix, WILDCARD], candidates);
    for (const label of labels[depth]) {
      walk(depth + 1, [...prefix, label], candidates.filter((i) => e.paths[i].path[depth] === WILDCARD || e.paths[i].path[depth] === label));
      if (truncated) return;
    }
  };
  walk(0, [], e.paths.map((_, i) => i));
  return { event: e.name, gaps: compact(gaps, labels), silences: compact(silences, labels), languages: Object.fromEntries(Object.entries(byLanguage).map(([c, list]) => [c, compact(list, labels)])), truncated };
}

/**
 * Merge per-language patterns that differ in one position and together cover every label there into a `*` there
 * (`Guard · Rain · Near` and `Guard · Rain · Far` → `Guard · Rain · *`), repeatedly.
 */
export function compact(patterns: readonly string[], labels: readonly (readonly string[])[]): string[] {
  let list = [...new Set(patterns)].map((p) => p.split(SEP));
  for (let changed = true; changed;) {
    changed = false;
    for (let pos = labels.length - 1; pos >= 0 && !changed; pos--) {
      const groups = new Map<string, string[][]>();
      for (const p of list) {
        const k = p.map((v, i) => (i === pos ? "\u0000" : v)).join(SEP);
        groups.set(k, [...(groups.get(k) ?? []), p]);
      }
      for (const [, g] of groups) {
        const values = new Set(g.map((p) => p[pos]));
        if (values.has(WILDCARD) || labels[pos].length < 2 || !labels[pos].every((l) => values.has(l))) continue;
        const merged = g[0].map((v, i) => (i === pos ? WILDCARD : v));
        list = [...list.filter((p) => !g.includes(p)), merged];
        changed = true;
        break;
      }
    }
  }
  return list.map((p) => p.join(SEP)).sort();
}

/** Line keys no event of any file names. */
export function unusedLines(lineKeys: readonly string[], docs: readonly DialogueDoc[]): string[] {
  const named = new Set(docs.flatMap((d) => d.asset.events.flatMap((e) => e.paths.flatMap((p) => p.lines.map((l) => l.key)))));
  return lineKeys.filter((k) => !named.has(k));
}

/** Events no script names in a string literal and no other event follows when interrupted (best effort). */
export function unnamedEvents(docs: readonly DialogueDoc[], scripts: ReadonlyMap<string, string>): string[] {
  const texts = [...scripts.values()];
  const followed = new Set(docs.flatMap((d) => d.asset.events.map((e) => e.onInterrupted).filter((x): x is string => x !== null)));
  return docs.flatMap((d) => d.asset.events.map((e) => e.name)).filter((name) => {
    if (followed.has(name)) return false;
    const lit = new RegExp(`["'\`]${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}["'\`]`);
    return !texts.some((t) => lit.test(t));
  });
}

/** The coverage report as CSV: one row per finding. */
export function coverageCsv(events: readonly EventCoverage[], unused: readonly string[], unnamed: readonly string[]): string {
  const rows: string[][] = [["event", "kind", "language", "pattern"]];
  for (const c of events) {
    for (const g of c.gaps) rows.push([c.event, "no line", "", g]);
    for (const s of c.silences) rows.push([c.event, "silence", "", s]);
    for (const [code, list] of Object.entries(c.languages)) for (const p of list) rows.push([c.event, "missing in language", code, p]);
    if (c.truncated) rows.push([c.event, "truncated", "", `stopped after ${COVERAGE_NODES} branches`]);
  }
  for (const k of unused) rows.push(["", "unused line", "", k]);
  for (const e of unnamed) rows.push([e, "not named by a script", "", ""]);
  return formatCsv(rows);
}
