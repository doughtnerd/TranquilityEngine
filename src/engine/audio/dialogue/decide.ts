/**
 * Deciding a dialogue event's line (ADR 0341 §2), pure:
 *
 * 1. **Values.** Each argument's value is `args[name]`; else, for a parameter argument, the global's current label;
 *    else the argument's default. A value that isn't one of its labels warns and matches only `*`.
 * 2. **Candidates.** The paths whose every entry equals the value or is `*`.
 * 3. **Order.** `bestMatch` (Wwise): argument by argument from the first, at the first argument where two candidates
 *    differ an exact label beats `*`. `weighted`: one candidate drawn by path weight, the rest after it in best-match
 *    order (for fallback).
 * 4. **Take the first candidate** that passes its probability draw. A path with no lines is an explicit silence (the
 *    decision ends: `silence`). Otherwise a line is drawn by weight among its available lines, the event's last
 *    `min(avoidRepeat, n − 1)` lines excluded (the Queue pick of `picks.ts`); no available line: fall back to the next
 *    candidate. None left: `noMatch`, or `unavailable` when there were candidates.
 * 5. The result carries the pick path (values, candidates tried and why each was passed over) for the profiler.
 *
 * Every random draw (the weighted path, each probability below 1, the line) comes from `ctx.rng` in that order, so a
 * seed and the same data give the same line. `decide` reads the memory it is given and doesn't change it: the caller
 * records the spoken line (`rememberLine`).
 *
 * Pure; no plugin, no DOM.
 */
import { PICK_HISTORY, pickRandom } from "../playlist/picks";
import { argumentName, WILDCARD, type DialogueEvent, type DialoguePath } from "./types";

/** What the decision needs from the game and the runtime. */
export interface DecideContext {
  /** Numbers in [0, 1): the World's seeded generator. */
  rng: () => number;
  /** The line exists and isn't held by a line cooldown or `once` (absent: every line is available). */
  available?: (key: string) => boolean;
  /** The line has a file in the current language's chain (absent: every line has); applied when `skipMissing`. */
  recorded?: (key: string) => boolean;
  /** A global labelled parameter's current label (absent or null: none). */
  parameter?: (name: string) => string | null | undefined;
  /** A global labelled parameter's labels, to check values against (absent or null: any value is taken). */
  parameterLabels?: (name: string) => readonly string[] | null | undefined;
  /** The event's last spoken lines, newest last. */
  history?: readonly string[];
  /** One warning per bad value. */
  warn?: (message: string) => void;
}

/** Why a candidate was passed over, or that it was taken. */
export type CandidateOutcome = "picked" | "probability" | "unavailable" | "silence";

/** The profiler's "Why it played" (0334): the values, then each candidate tried in order. */
export interface PickTrace {
  /** Argument name → the value matched (null: matches only `*`). */
  values: Record<string, string | null>;
  /** Candidate path indices in the order they were considered. */
  order: number[];
  tried: { pathIndex: number; outcome: CandidateOutcome }[];
}

export type DecideResult =
  | { key: string; path: readonly string[]; pathIndex: number; trace: PickTrace }
  | { none: "silence" | "noMatch" | "unavailable"; pathIndex: number | null; trace: PickTrace };

/** Each argument's value (step 1); null for a value that matches only `*`. */
export function argumentValues(event: DialogueEvent, args: Readonly<Record<string, string>> | undefined, ctx: Pick<DecideContext, "parameter" | "parameterLabels" | "warn">): Record<string, string | null> {
  const out: Record<string, string | null> = {};
  for (const a of event.arguments) {
    const name = argumentName(a);
    const given = args?.[name];
    let value: string | null | undefined = typeof given === "string" ? given : undefined;
    if (value === undefined && a.kind === "parameter") value = ctx.parameter?.(a.parameter) ?? undefined;
    if (value === undefined) value = a.kind === "local" ? a.default : null;
    const labels = a.kind === "local" ? a.labels : ctx.parameterLabels?.(a.parameter) ?? null;
    if (value !== null && labels !== null && !labels.includes(value)) {
      ctx.warn?.(`${event.name}: "${value}" isn't a label of "${name}"; it matches only *.`);
      value = null;
    }
    out[name] = value;
  }
  return out;
}

/** Whether a path matches the values (step 2). */
const matches = (p: DialoguePath, values: readonly (string | null)[]): boolean => p.path.every((entry, i) => entry === WILDCARD || entry === values[i]);

/** Best-match order of two paths: at the first argument where they differ, an exact label comes before `*`. */
export function compareBestMatch(a: readonly string[], b: readonly string[]): number {
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const wa = a[i] === WILDCARD;
    const wb = b[i] === WILDCARD;
    if (wa !== wb) return wa ? 1 : -1;
  }
  return 0;
}

/** The candidate path indices in the order they are tried (steps 2–3); draws the weighted path from `rng`. */
export function candidateOrder(event: DialogueEvent, values: Record<string, string | null>, rng: () => number): number[] {
  const vals = event.arguments.map((a) => values[argumentName(a)] ?? null);
  const candidates = event.paths.map((p, i) => ({ p, i })).filter(({ p }) => matches(p, vals));
  candidates.sort((x, y) => compareBestMatch(x.p.path, y.p.path) || x.i - y.i);
  const order = candidates.map((c) => c.i);
  if (event.mode === "weighted" && order.length > 1) {
    const first = pickRandom(candidates.map((c) => c.p.weight), [], 0, rng);
    if (first > 0) order.unshift(...order.splice(first, 1));
  }
  return order;
}

/** The event's line for these arguments, or why there is none. Never throws. */
export function decide(event: DialogueEvent, args: Readonly<Record<string, string>> | undefined, ctx: DecideContext): DecideResult {
  const values = argumentValues(event, args, ctx);
  const order = candidateOrder(event, values, ctx.rng);
  const trace: PickTrace = { values, order, tried: [] };
  const usable = (key: string) => (ctx.available?.(key) ?? true) && (!event.skipMissing || (ctx.recorded?.(key) ?? true));
  const history = ctx.history ?? [];
  for (const pathIndex of order) {
    const p = event.paths[pathIndex];
    if (p.probability < 1 && !(ctx.rng() < p.probability)) {
      trace.tried.push({ pathIndex, outcome: "probability" });
      continue;
    }
    if (p.lines.length === 0) {
      trace.tried.push({ pathIndex, outcome: "silence" });
      return { none: "silence", pathIndex, trace };
    }
    const weights = p.lines.map((l) => (usable(l.key) ? l.weight : 0));
    if (!weights.some((w) => w > 0)) {
      trace.tried.push({ pathIndex, outcome: "unavailable" });
      continue;
    }
    // Avoid-repeat over the event's history, by key: the last lines it spoke, as indices into this path's lines.
    const recent = history.slice(-Math.min(event.avoidRepeat, PICK_HISTORY)).map((k) => p.lines.findIndex((l) => l.key === k));
    const index = pickRandom(weights, event.avoidRepeat > 0 ? recent : [], event.avoidRepeat, ctx.rng);
    if (index < 0) {
      trace.tried.push({ pathIndex, outcome: "unavailable" });
      continue;
    }
    trace.tried.push({ pathIndex, outcome: "picked" });
    return { key: p.lines[index].key, path: p.path, pathIndex, trace };
  }
  return { none: order.length === 0 ? "noMatch" : "unavailable", pathIndex: null, trace };
}

/** The event's history after it spoke `key`: newest last, at most the Queue pick history (8). */
export const rememberLine = (history: readonly string[], key: string): string[] => [...history, key].slice(-PICK_HISTORY);
