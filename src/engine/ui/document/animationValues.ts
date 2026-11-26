/**
 * Animation values of UI stylesheets (ADR 0418 wave 4): `transition` and `animation` with their longhands, times and
 * timing functions, parsed from CSS text into plain data the cascade (`cascade.ts`) orders and the UI animator
 * (`ui/animation/`) runs. Pure: a value that can't be read comes back as a message saying why.
 *
 * These are cascade declarations, not component fields: each longhand is a comma-separated list, and the list lengths
 * follow CSS (the property or name list sets the count; shorter lists repeat).
 */
import { splitTopLevel, type PaintParse } from "./paintValues";

/**
 * A CSS timing function: `linear`, a cubic Bézier (the keywords are ones), `steps()`, or (ADR 0428) the `linear()`
 * function: its points `[input, output]` after CSS's normalisation (inputs filled in and never decreasing).
 */
export type UITimingFunction =
  | { readonly kind: "linear" }
  | { readonly kind: "bezier"; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number }
  | { readonly kind: "steps"; readonly steps: number; readonly position: "jump-start" | "jump-end" | "jump-none" | "jump-both" }
  | { readonly kind: "points"; readonly points: readonly (readonly [number, number])[] };

/** ADR 0428: `transition-behavior`: `allow-discrete` lets values that don't interpolate transition (they flip part-way). */
export type UITransitionBehavior = "normal" | "allow-discrete";

export type UIAnimationDirection = "normal" | "reverse" | "alternate" | "alternate-reverse";
export type UIAnimationFillMode = "none" | "forwards" | "backwards" | "both";
export type UIAnimationPlayState = "running" | "paused";

/** One transition: the property it covers (kebab-case, or `all`), its times in seconds and its timing function. */
export interface UITransitionSpec {
  readonly property: string;
  readonly duration: number;
  readonly delay: number;
  readonly timing: UITimingFunction;
  /** ADR 0428: `transition-behavior: allow-discrete`; absent for `normal`. */
  readonly allowDiscrete?: true;
}

/** One animation of `animation-name`, with its settings (times in seconds; `iterations` may be `Infinity`). */
export interface UIAnimationSpec {
  readonly name: string;
  readonly duration: number;
  readonly delay: number;
  readonly timing: UITimingFunction;
  readonly iterations: number;
  readonly direction: UIAnimationDirection;
  readonly fill: UIAnimationFillMode;
  readonly playState: UIAnimationPlayState;
}

const ok = <T>(value: T): PaintParse<T> => ({ ok: true, value });
const fail = <T>(problem: string): PaintParse<T> => ({ ok: false, problem });

const NUMBER = "[-+]?(?:\\d+\\.?\\d*|\\.\\d+)(?:e[-+]?\\d+)?";
const TIME = new RegExp(`^(${NUMBER})(s|ms)?$`, "i");
const TIME_WITH_UNIT = new RegExp(`^${NUMBER}(s|ms)$`, "i");
const PLAIN_NUMBER = new RegExp(`^${NUMBER}$`);

export const LINEAR: UITimingFunction = { kind: "linear" };
export const EASE: UITimingFunction = { kind: "bezier", x1: 0.25, y1: 0.1, x2: 0.25, y2: 1 };

const KEYWORD_TIMING: Readonly<Record<string, UITimingFunction>> = {
  linear: LINEAR,
  ease: EASE,
  "ease-in": { kind: "bezier", x1: 0.42, y1: 0, x2: 1, y2: 1 },
  "ease-out": { kind: "bezier", x1: 0, y1: 0, x2: 0.58, y2: 1 },
  "ease-in-out": { kind: "bezier", x1: 0.42, y1: 0, x2: 0.58, y2: 1 },
  "step-start": { kind: "steps", steps: 1, position: "jump-start" },
  "step-end": { kind: "steps", steps: 1, position: "jump-end" },
};

const STEP_POSITIONS: Readonly<Record<string, "jump-start" | "jump-end" | "jump-none" | "jump-both">> = {
  "jump-start": "jump-start",
  start: "jump-start",
  "jump-end": "jump-end",
  end: "jump-end",
  "jump-none": "jump-none",
  "jump-both": "jump-both",
};

/** A time: `0.3s`, `300ms` (a bare `0` too). Undefined for anything else. */
export function parseTime(raw: string): number | undefined {
  const m = TIME.exec(raw.trim());
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!m[2]) return n === 0 ? 0 : undefined;
  return m[2].toLowerCase() === "ms" ? n / 1000 : n;
}

/** True when `raw` looks like a time, valid or not (`1s`, `-2ms`), so a shorthand can tell it from a name. */
const looksLikeTime = (raw: string) => TIME_WITH_UNIT.test(raw.trim());

/**
 * ADR 0428: `linear()`'s arguments: stops of an output number with up to two input percentages, normalised as CSS
 * Easing 2 does (the first input defaults to 0%, the last to 100%, an input below an earlier one rises to it, and stops
 * without inputs are spread evenly between their neighbours).
 */
function parseLinearPoints(args: readonly string[]): PaintParse<UITimingFunction> {
  const stops: { y: number; x: number | null }[] = [];
  for (const arg of args) {
    const tokens = arg.split(/\s+/).filter(Boolean);
    const numbers = tokens.filter((t) => PLAIN_NUMBER.test(t));
    const inputs = tokens.filter((t) => /%$/.test(t));
    if (numbers.length !== 1 || inputs.length > 2 || numbers.length + inputs.length !== tokens.length) return fail(`"${arg}" isn't a linear() stop (an output number and up to two input percentages).`);
    const xs = inputs.map((t) => (PLAIN_NUMBER.test(t.slice(0, -1)) ? parseFloat(t) / 100 : NaN));
    if (xs.some((x) => !Number.isFinite(x))) return fail(`"${arg}" has an input that isn't a percentage.`);
    const y = parseFloat(numbers[0]);
    if (xs.length === 0) stops.push({ y, x: null });
    else for (const x of xs) stops.push({ y, x });
  }
  if (stops.length < 2) return fail("linear() needs at least two stops.");
  if (stops[0].x === null) stops[0].x = 0;
  if (stops[stops.length - 1].x === null) stops[stops.length - 1].x = 1;
  let max = -Infinity;
  for (const s of stops) if (s.x !== null) s.x = max = Math.max(max, s.x);
  for (let i = 1; i < stops.length; i++) {
    if (stops[i].x !== null) continue;
    let j = i;
    while (stops[j].x === null) j++;
    const from = stops[i - 1].x!, to = stops[j].x!;
    for (let k = i; k < j; k++) stops[k].x = from + ((to - from) * (k - i + 1)) / (j - i + 1);
    i = j;
  }
  return ok({ kind: "points", points: stops.map((s) => [s.x!, s.y] as const) });
}

/** A timing function: the keywords, `cubic-bezier(x1, y1, x2, y2)` (x in 0–1), `steps(n[, position])` or `linear(…)` (ADR 0428). */
export function parseTimingFunction(raw: string): PaintParse<UITimingFunction> {
  const v = raw.trim().toLowerCase();
  const keyword = KEYWORD_TIMING[v];
  if (keyword) return ok(keyword);
  const fn = /^([a-z-]+)\((.*)\)$/s.exec(v);
  if (!fn) return fail(`"${raw.trim()}" isn't a timing function (linear, ease, ease-in, ease-out, ease-in-out, cubic-bezier(), steps(), linear()).`);
  const args = splitTopLevel(fn[2], ",").map((a) => a.trim());
  if (fn[1] === "cubic-bezier") {
    const n = args.map((a) => (PLAIN_NUMBER.test(a) ? parseFloat(a) : NaN));
    if (n.length !== 4 || n.some((x) => !Number.isFinite(x))) return fail("cubic-bezier() takes four numbers.");
    if (n[0] < 0 || n[0] > 1 || n[2] < 0 || n[2] > 1) return fail("cubic-bezier()'s x values must be between 0 and 1.");
    return ok({ kind: "bezier", x1: n[0], y1: n[1], x2: n[2], y2: n[3] });
  }
  if (fn[1] === "steps") {
    if (args.length < 1 || args.length > 2 || !/^\d+$/.test(args[0])) return fail("steps() takes a whole number of steps and an optional position.");
    const steps = parseInt(args[0], 10);
    const position = args.length === 2 ? STEP_POSITIONS[args[1]] : "jump-end";
    if (!position) return fail(`"${args[1]}" isn't a steps() position (jump-start, jump-end, jump-none, jump-both, start, end).`);
    if (steps < 1 || (position === "jump-none" && steps < 2)) return fail(position === "jump-none" ? "steps(n, jump-none) needs at least 2 steps." : "steps() needs at least 1 step.");
    return ok({ kind: "steps", steps, position });
  }
  if (fn[1] === "linear") return parseLinearPoints(args);
  return fail(`${fn[1]}() isn't a supported timing function (cubic-bezier(), steps(), linear()).`);
}

/** True for a token that starts a timing function (so a shorthand reads it as one). */
const isTimingToken = (token: string) => KEYWORD_TIMING[token.toLowerCase()] !== undefined || /^(cubic-bezier|steps|linear)\(/i.test(token);

/** A comma-separated list, each item read by `item`; the first failure is the result. */
function list<T>(raw: string, item: (part: string) => PaintParse<T>): PaintParse<T[]> {
  const out: T[] = [];
  for (const part of splitTopLevel(raw, ",")) {
    const r = item(part.trim());
    if (!r.ok) return r;
    out.push(r.value);
  }
  return out.length ? ok(out) : fail("is empty.");
}

const timeItem = (allowNegative: boolean) => (part: string): PaintParse<number> => {
  const t = parseTime(part);
  if (t === undefined) return fail(`"${part}" isn't a time (such as 0.3s or 300ms).`);
  if (!allowNegative && t < 0) return fail(`"${part}": a duration can't be negative.`);
  return ok(t);
};

const IDENT = /^-?[_a-zA-Z][-_a-zA-Z0-9]*$/;

// --- Transitions ----------------------------------------------------------------------------------

/** The transition longhands a declaration sets (lists as written; `transition` sets all four). */
export interface UITransitionLonghands {
  property?: readonly string[];
  duration?: readonly number[];
  timing?: readonly UITimingFunction[];
  delay?: readonly number[];
  /** ADR 0428: `transition-behavior`. */
  behavior?: readonly UITransitionBehavior[];
}

/** `transition-property`: `none`, `all`, or property names. */
export function parseTransitionProperty(raw: string): PaintParse<string[]> {
  return list(raw, (p) => {
    const name = p.toLowerCase();
    if (!IDENT.test(name)) return fail(`"${p}" isn't a property name.`);
    return ok(name);
  });
}

/**
 * `transition`: comma-separated single transitions, each `[property] [duration] [timing] [delay] [behavior]` in any
 * order (the first time is the duration, the second the delay; `allow-discrete` or `normal`, ADR 0428). `none` alone
 * is no transition. `behavior` is set only when one is written, so shorthands without it read as before.
 */
export function parseTransition(raw: string): PaintParse<Required<Omit<UITransitionLonghands, "behavior">> & Pick<UITransitionLonghands, "behavior">> {
  const property: string[] = [], duration: number[] = [], timing: UITimingFunction[] = [], delay: number[] = [], behavior: UITransitionBehavior[] = [];
  let anyBehavior = false;
  const parts = splitTopLevel(raw, ",");
  for (const single of parts) {
    let prop: string | null = null, dur: number | null = null, del: number | null = null, tf: UITimingFunction | null = null, be: UITransitionBehavior | null = null;
    for (const token of splitTopLevel(single.trim(), " ")) {
      if (looksLikeTime(token) || token === "0") {
        const t = parseTime(token);
        if (t === undefined) return fail(`"${token}" isn't a time.`);
        if (dur === null) {
          if (t < 0) return fail(`"${token}": a duration can't be negative.`);
          dur = t;
        } else if (del === null) del = t;
        else return fail(`"${single.trim()}" has more than two times.`);
      } else if (isTimingToken(token)) {
        if (tf) return fail(`"${single.trim()}" has two timing functions.`);
        const r = parseTimingFunction(token);
        if (!r.ok) return r;
        tf = r.value;
      } else if ((token.toLowerCase() === "allow-discrete" || token.toLowerCase() === "normal") && be === null) {
        be = token.toLowerCase() as UITransitionBehavior;
        anyBehavior = true;
      } else if (IDENT.test(token) && prop === null) prop = token.toLowerCase();
      else return fail(`"${token}" isn't a property, time, timing function or transition behavior.`);
    }
    if (prop === "none" && parts.length > 1) return fail("none can only be the whole transition.");
    property.push(prop ?? "all");
    duration.push(dur ?? 0);
    delay.push(del ?? 0);
    timing.push(tf ?? EASE);
    behavior.push(be ?? "normal");
  }
  // The shorthand resets `transition-behavior` too; it's left out when no item names one (all `normal`, the initial value).
  return ok(anyBehavior ? { property, duration, timing, delay, behavior } : { property, duration, timing, delay });
}

/** Reads one transition longhand (`transition-duration`…) into `into`; a problem, or null. */
export function parseTransitionLonghand(name: string, raw: string, into: UITransitionLonghands): string | null {
  switch (name) {
    case "transition": {
      const r = parseTransition(raw);
      if (!r.ok) return r.problem;
      // The shorthand resets `transition-behavior` too (to `normal` where an item doesn't name one).
      Object.assign(into, r.value, { behavior: r.value.behavior ?? r.value.property.map((): UITransitionBehavior => "normal") });
      return null;
    }
    case "transition-behavior": {
      const r = list(raw, keywordItem<UITransitionBehavior>(BEHAVIORS, "a transition behavior (normal, allow-discrete)"));
      if (!r.ok) return r.problem;
      into.behavior = r.value;
      return null;
    }
    case "transition-property": {
      const r = parseTransitionProperty(raw);
      if (!r.ok) return r.problem;
      into.property = r.value;
      return null;
    }
    case "transition-duration": {
      const r = list(raw, timeItem(false));
      if (!r.ok) return r.problem;
      into.duration = r.value;
      return null;
    }
    case "transition-delay": {
      const r = list(raw, timeItem(true));
      if (!r.ok) return r.problem;
      into.delay = r.value;
      return null;
    }
    case "transition-timing-function": {
      const r = list(raw, parseTimingFunction);
      if (!r.ok) return r.problem;
      into.timing = r.value;
      return null;
    }
  }
  return `${name} isn't a transition property.`;
}

const at = <T>(xs: readonly T[] | undefined, i: number, fallback: T): T => (xs && xs.length ? xs[i % xs.length] : fallback);

/** The transitions longhands describe: one per property (`none` gives none); shorter lists repeat, as in CSS. */
export function transitionSpecs(l: UITransitionLonghands): UITransitionSpec[] {
  const props = l.property ?? ["all"];
  if (props.length === 1 && props[0] === "none") return [];
  return props
    .map((property, i): UITransitionSpec => ({
      property,
      duration: at(l.duration, i, 0),
      delay: at(l.delay, i, 0),
      timing: at(l.timing, i, EASE),
      ...(at(l.behavior, i, "normal" as UITransitionBehavior) === "allow-discrete" ? { allowDiscrete: true as const } : {}),
    }))
    .filter((t) => t.property !== "none");
}

// --- Animations -----------------------------------------------------------------------------------

/** The animation longhands a declaration sets (lists as written; `animation` sets all eight). */
export interface UIAnimationLonghands {
  name?: readonly string[];
  duration?: readonly number[];
  timing?: readonly UITimingFunction[];
  delay?: readonly number[];
  iterations?: readonly number[];
  direction?: readonly UIAnimationDirection[];
  fill?: readonly UIAnimationFillMode[];
  playState?: readonly UIAnimationPlayState[];
}

const DIRECTIONS: ReadonlySet<string> = new Set(["normal", "reverse", "alternate", "alternate-reverse"]);
const BEHAVIORS: ReadonlySet<string> = new Set(["normal", "allow-discrete"]);
const FILLS: ReadonlySet<string> = new Set(["none", "forwards", "backwards", "both"]);
const PLAY_STATES: ReadonlySet<string> = new Set(["running", "paused"]);

function iterationItem(part: string): PaintParse<number> {
  if (part.toLowerCase() === "infinite") return ok(Infinity);
  if (!PLAIN_NUMBER.test(part)) return fail(`"${part}" isn't an iteration count (a number or infinite).`);
  const n = parseFloat(part);
  return n >= 0 ? ok(n) : fail(`"${part}": an iteration count can't be negative.`);
}

const keywordItem = <T extends string>(set: ReadonlySet<string>, what: string) => (part: string): PaintParse<T> => {
  const k = part.toLowerCase();
  return set.has(k) ? ok(k as T) : fail(`"${part}" isn't ${what}.`);
};

function nameItem(part: string): PaintParse<string> {
  const p = part.trim();
  if ((p.startsWith('"') && p.endsWith('"')) || (p.startsWith("'") && p.endsWith("'"))) return ok(p.slice(1, -1));
  return IDENT.test(p) ? ok(p) : fail(`"${p}" isn't an animation name.`);
}

/**
 * `animation`: comma-separated single animations, each `[name] [duration] [timing] [delay] [iterations] [direction]
 * [fill] [play state]` in any order (the first time is the duration, the second the delay; a keyword goes to the first
 * longhand that takes it and hasn't one yet, so a name can't be a keyword already used).
 */
export function parseAnimation(raw: string): PaintParse<Required<UIAnimationLonghands>> {
  const out = { name: [] as string[], duration: [] as number[], timing: [] as UITimingFunction[], delay: [] as number[], iterations: [] as number[], direction: [] as UIAnimationDirection[], fill: [] as UIAnimationFillMode[], playState: [] as UIAnimationPlayState[] };
  for (const single of splitTopLevel(raw, ",")) {
    let name: string | null = null, dur: number | null = null, del: number | null = null, tf: UITimingFunction | null = null, it: number | null = null;
    let dir: UIAnimationDirection | null = null, fill: UIAnimationFillMode | null = null, play: UIAnimationPlayState | null = null;
    for (const token of splitTopLevel(single.trim(), " ")) {
      const k = token.toLowerCase();
      if (looksLikeTime(token)) {
        const t = parseTime(token);
        if (t === undefined) return fail(`"${token}" isn't a time.`);
        if (dur === null) {
          if (t < 0) return fail(`"${token}": a duration can't be negative.`);
          dur = t;
        } else if (del === null) del = t;
        else return fail(`"${single.trim()}" has more than two times.`);
      } else if (isTimingToken(token) && tf === null) {
        const r = parseTimingFunction(token);
        if (!r.ok) return r;
        tf = r.value;
      } else if ((k === "infinite" || PLAIN_NUMBER.test(k)) && it === null) {
        const r = iterationItem(token);
        if (!r.ok) return r;
        it = r.value;
      } else if (DIRECTIONS.has(k) && dir === null) dir = k as UIAnimationDirection;
      else if (FILLS.has(k) && k !== "none" && fill === null) fill = k as UIAnimationFillMode;
      else if (PLAY_STATES.has(k) && play === null) play = k as UIAnimationPlayState;
      else if (k === "none" && fill === null && name !== null) fill = "none";
      else if (name === null) {
        const r = nameItem(token);
        if (!r.ok) return r;
        name = r.value;
      } else return fail(`"${token}" isn't a time, timing function, iteration count, direction, fill mode or play state.`);
    }
    out.name.push(name ?? "none");
    out.duration.push(dur ?? 0);
    out.delay.push(del ?? 0);
    out.timing.push(tf ?? EASE);
    out.iterations.push(it ?? 1);
    out.direction.push(dir ?? "normal");
    out.fill.push(fill ?? "none");
    out.playState.push(play ?? "running");
  }
  return ok(out);
}

/** Reads one animation longhand (`animation-duration`…) into `into`; a problem, or null. */
export function parseAnimationLonghand(name: string, raw: string, into: UIAnimationLonghands): string | null {
  const set = <K extends keyof UIAnimationLonghands>(key: K, r: PaintParse<NonNullable<UIAnimationLonghands[K]>>) => {
    if (!r.ok) return r.problem;
    into[key] = r.value;
    return null;
  };
  switch (name) {
    case "animation": {
      const r = parseAnimation(raw);
      if (!r.ok) return r.problem;
      Object.assign(into, r.value);
      return null;
    }
    case "animation-name":
      return set("name", list(raw, nameItem));
    case "animation-duration":
      return set("duration", list(raw, timeItem(false)));
    case "animation-delay":
      return set("delay", list(raw, timeItem(true)));
    case "animation-timing-function":
      return set("timing", list(raw, parseTimingFunction));
    case "animation-iteration-count":
      return set("iterations", list(raw, iterationItem));
    case "animation-direction":
      return set("direction", list(raw, keywordItem<UIAnimationDirection>(DIRECTIONS, "a direction (normal, reverse, alternate, alternate-reverse)")));
    case "animation-fill-mode":
      return set("fill", list(raw, keywordItem<UIAnimationFillMode>(FILLS, "a fill mode (none, forwards, backwards, both)")));
    case "animation-play-state":
      return set("playState", list(raw, keywordItem<UIAnimationPlayState>(PLAY_STATES, "a play state (running, paused)")));
  }
  return `${name} isn't an animation property.`;
}

/** The animations longhands describe: one per name (`none` names none); shorter lists repeat, as in CSS. */
export function animationSpecs(l: UIAnimationLonghands): UIAnimationSpec[] {
  return (l.name ?? [])
    .map((name, i) => ({
      name,
      duration: at(l.duration, i, 0),
      delay: at(l.delay, i, 0),
      timing: at(l.timing, i, EASE),
      iterations: at(l.iterations, i, 1),
      direction: at(l.direction, i, "normal" as UIAnimationDirection),
      fill: at(l.fill, i, "none" as UIAnimationFillMode),
      playState: at(l.playState, i, "running" as UIAnimationPlayState),
    }))
    .filter((a) => a.name !== "none");
}

/** The transition and animation properties (kebab-case), which are cascade data, not fields. */
export const ANIMATION_PROPERTIES: ReadonlySet<string> = new Set([
  "transition", "transition-property", "transition-duration", "transition-timing-function", "transition-delay", "transition-behavior",
  "animation", "animation-name", "animation-duration", "animation-timing-function", "animation-delay",
  "animation-iteration-count", "animation-direction", "animation-fill-mode", "animation-play-state",
]);
