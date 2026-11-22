// The Events tab's test bench (ADR 0341 §7, §2): argument values (or "from global"), the language from the header
// chip; it shows which path best match takes and the fallbacks after it in order, each with its reason, plus the paths
// that don't match and why; Say decides once and Roll ×50 shows the pick distribution. Decisions are `decide.ts`'s, over
// a seeded generator, so a seed and the same data give the same line. Pure.
import { argumentValues, candidateOrder, decide, rememberLine, type DecideContext, type DecideResult } from "../../../../engine/audio/dialogue/decide";
import { argumentName, WILDCARD, type DialogueEvent } from "../../../../engine/audio/dialogue/types";
import { seededRandom } from "../../../../engine/render/particles/random";

/** The value the bench gives an argument: a label, or "from global" (a parameter argument reads the global's label). */
export const FROM_GLOBAL = "";

export type BenchRole = "picked" | "silence" | "passed" | "fallback" | "unmatched";

export interface BenchRow {
  readonly pathIndex: number;
  readonly role: BenchRole;
  /** Its place in the candidate order (1-based), or null when it doesn't match. */
  readonly rank: number | null;
  readonly reason: string;
}

export interface BenchView {
  readonly values: Readonly<Record<string, string | null>>;
  readonly result: DecideResult;
  /** One row per path, in table order. */
  readonly rows: readonly BenchRow[];
  readonly summary: string;
}

export interface BenchContext extends Omit<DecideContext, "rng"> {
  readonly seed: number;
}

/** The arguments the bench passes: chosen labels, leaving "from global" ones out. */
export const benchArgs = (picked: Readonly<Record<string, string>>): Record<string, string> => Object.fromEntries(Object.entries(picked).filter(([, v]) => v !== FROM_GLOBAL));

const describeNone: Record<"silence" | "noMatch" | "unavailable", string> = {
  silence: "an explicit silence: nothing is said",
  noMatch: "no path matches: nothing is said",
  unavailable: "paths match, but none has a line available: nothing is said",
};

/** One decision with every path's part in it. */
export function bench(e: DialogueEvent, picked: Readonly<Record<string, string>>, ctx: BenchContext): BenchView {
  const args = benchArgs(picked);
  const result = decide(e, args, { ...ctx, rng: seededRandom(ctx.seed) });
  const { values, order, tried } = result.trace;
  const vals = e.arguments.map((a) => values[argumentName(a)] ?? null);
  const triedAt = new Map(tried.map((t) => [t.pathIndex, t.outcome]));
  const usable = (key: string) => (ctx.available?.(key) ?? true) && (!e.skipMissing || (ctx.recorded?.(key) ?? true));
  const rows = e.paths.map((p, i): BenchRow => {
    const pos = order.indexOf(i);
    if (pos < 0) {
      const j = p.path.findIndex((v, k) => v !== WILDCARD && v !== vals[k]);
      const name = argumentName(e.arguments[j]);
      return { pathIndex: i, role: "unmatched", rank: null, reason: vals[j] === null ? `${name} matches only *` : `${p.path[j]} isn't ${name} = ${vals[j]}` };
    }
    const rank = pos + 1;
    const outcome = triedAt.get(i);
    if (outcome === "picked") return { pathIndex: i, role: "picked", rank, reason: "key" in result ? `says ${result.key}` : "" };
    if (outcome === "silence") return { pathIndex: i, role: "silence", rank, reason: "explicit silence: the decision ends here" };
    if (outcome === "probability") return { pathIndex: i, role: "passed", rank, reason: `passed over by its probability (${Math.round(p.probability * 100)}%)` };
    if (outcome === "unavailable") {
      const why = p.lines.map((l) => (l.weight === 0 ? `${l.key} weight 0` : !(ctx.available?.(l.key) ?? true) ? `${l.key} cooling down or said once` : !usable(l.key) ? `${l.key} not recorded` : `${l.key} just said`));
      return { pathIndex: i, role: "passed", rank, reason: `no line available (${why.join(", ")})` };
    }
    // Not tried: a fallback in order behind the result.
    if ("none" in result) return { pathIndex: i, role: "fallback", rank, reason: `fallback ${rank}, not reached: the silence ends the decision` };
    return { pathIndex: i, role: "fallback", rank, reason: `fallback ${rank}${p.lines.length === 0 ? " (silence)" : ""}: tried when the paths before it have no line to say` };
  });
  const summary = "key" in result ? `Says ${result.key} (path ${result.path.join(" · ")})` : describeNone[result.none];
  return { values, result, rows, summary };
}

/** The candidates in the order best match (or weighted mode's draw) tries them, for highlighting. */
export function candidateRanks(e: DialogueEvent, picked: Readonly<Record<string, string>>, ctx: BenchContext): number[] {
  const values = argumentValues(e, benchArgs(picked), ctx);
  return candidateOrder(e, values, seededRandom(ctx.seed));
}

export interface RollBar {
  /** A line key, or a reason for nothing (`silence`, `noMatch`, `unavailable`). */
  readonly outcome: string;
  readonly count: number;
  readonly share: number;
  readonly said: boolean;
}

/**
 * Roll ×n: n decisions from one generator seeded `seed`, the event's history growing with each line said (as the
 * runtime's memory would, avoid-repeat included). Bars by count, most first, then by name.
 */
export function roll(e: DialogueEvent, picked: Readonly<Record<string, string>>, ctx: BenchContext, n = 50): RollBar[] {
  const rng = seededRandom(ctx.seed);
  const args = benchArgs(picked);
  let history = [...(ctx.history ?? [])];
  const counts = new Map<string, { count: number; said: boolean }>();
  for (let i = 0; i < n; i++) {
    const r = decide(e, args, { ...ctx, rng, history, warn: undefined });
    const outcome = "key" in r ? r.key : r.none;
    if ("key" in r) history = rememberLine(history, r.key);
    const c = counts.get(outcome) ?? { count: 0, said: "key" in r };
    c.count++;
    counts.set(outcome, c);
  }
  return [...counts].map(([outcome, c]) => ({ outcome, count: c.count, share: c.count / n, said: c.said })).sort((a, b) => b.count - a.count || (a.outcome < b.outcome ? -1 : 1));
}
