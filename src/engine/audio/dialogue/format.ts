/**
 * Dialogue events (ADR 0355 §1): parse and write `*.dialogue.json` (`myco.dialogue@1`). The shapes are the contract in
 * `types.ts`.
 *
 * The parse is lenient (bad values fall back to defaults with one problem line; it never throws) and canonical:
 * - event names are valid and unique in the file; argument names unique in their event;
 * - a local argument's labels are unique, non-empty and not `*`, and its default is one of them (else the first);
 * - every path has one entry per argument (padded with `*` or cut, with a problem); a label a local argument doesn't
 *   have is kept and reported (it matches nothing until the label exists); a path equal to an earlier one is dropped;
 * - limits, declared once in `DIALOGUE_LIMITS` (0306): over a limit, the rest is dropped with a problem.
 *
 * `dialogueToJson` writes the canonical form in a stable key order, leaving out defaults, so
 * `parseDialogue(dialogueToJson(x)).dialogue` deep-equals `x`.
 *
 * Pure; no plugin, no DOM.
 */
import { isLineKey } from "../localisation/lines/format";
import { isRecord, LenientReader, type JsonRecord } from "../lenientRead";
import { PICK_HISTORY } from "../playlist/picks";
import {
  argumentName, DIALOGUE_FORMAT, DIALOGUE_SUFFIX, WILDCARD, type DialogueArgument, type DialogueAsset, type DialogueEvent, type DialogueLine,
  type DialogueParse, type DialoguePath, type InterruptRule, type WhenBusy,
} from "./types";

/** Limits of a dialogue file, declared once (ADR 0306, 0355 §1). */
export const DIALOGUE_LIMITS = Object.freeze({
  events: 512,
  arguments: 8,
  labels: 64,
  paths: 4096,
  linesPerPath: 64,
  /** The avoid-repeat reach: the Queue pick history (`picks.ts`). */
  avoidRepeat: PICK_HISTORY,
  /** Seconds of `maxWait` and `cooldown`. */
  seconds: 3600,
});

const NAME = /^[A-Za-z0-9_.-]{1,64}$/;
const WHEN_BUSY: readonly WhenBusy[] = ["queue", "interrupt", "drop"];
const INTERRUPT: readonly InterruptRule[] = ["never", "lower", "always"];

/** True for a valid event name (`[A-Za-z0-9_.-]{1,64}`). */
export const isEventName = (name: unknown): name is string => typeof name === "string" && NAME.test(name);

/** True for a dialogue asset path. */
export const isDialoguePath = (path: string): boolean => path.toLowerCase().endsWith(DIALOGUE_SUFFIX);

/** An event with no arguments or paths and every setting at its default. */
export const emptyDialogueEvent = (name: string): DialogueEvent => ({
  name, arguments: [], mode: "bestMatch", paths: [], priority: null, whenBusy: "queue", interrupt: "lower", maxWait: 2, cooldown: 0, chance: 1,
  avoidRepeat: 1, skipMissing: true, onInterrupted: null,
});

export const emptyDialogue = (): DialogueAsset => ({ format: DIALOGUE_FORMAT, events: [] });

class DialogueReader {
  readonly r: LenientReader;
  constructor(problems: string[]) {
    this.r = new LenientReader(problems);
  }

  argument(raw: unknown, where: string, names: Set<string>): DialogueArgument | null {
    const r = this.r;
    if (!isRecord(raw)) return void r.problem(where, "an argument must be an object; dropped."), null;
    if (raw.parameter !== undefined) {
      if (typeof raw.parameter !== "string" || raw.parameter.trim() === "") return void r.problem(`${where}.parameter`, "must name a global labelled parameter; dropped."), null;
      if (raw.name !== undefined || raw.labels !== undefined) r.problem(where, "a parameter argument takes its name and labels from the parameter; the others are ignored.");
      if (names.has(raw.parameter)) return void r.problem(`${where}.parameter`, `"${raw.parameter}" is already an argument of this event; dropped.`), null;
      names.add(raw.parameter);
      return { kind: "parameter", parameter: raw.parameter };
    }
    if (typeof raw.name !== "string" || raw.name.trim() === "") return void r.problem(`${where}.name`, "an argument needs a name or a parameter; dropped."), null;
    if (names.has(raw.name)) return void r.problem(`${where}.name`, `"${raw.name}" is already an argument of this event; dropped.`), null;
    const labels: string[] = [];
    r.list(raw.labels, `${where}.labels`).forEach((l, i) => {
      const w = `${where}.labels[${i}]`;
      if (typeof l !== "string" || l.trim() === "" || l === WILDCARD) return void r.problem(w, "must be a label (not empty, not *); dropped.");
      if (labels.includes(l)) return void r.problem(w, `"${l}" is listed twice; dropped.`);
      if (labels.length >= DIALOGUE_LIMITS.labels) return void r.problem(w, `at most ${DIALOGUE_LIMITS.labels} labels; dropped.`);
      labels.push(l);
    });
    if (labels.length === 0) return void r.problem(`${where}.labels`, "a local argument needs at least one label; dropped."), null;
    names.add(raw.name);
    let def = labels[0];
    if (raw.default !== undefined) {
      if (typeof raw.default === "string" && labels.includes(raw.default)) def = raw.default;
      else r.problem(`${where}.default`, `${JSON.stringify(raw.default)} isn't one of its labels; using "${labels[0]}".`);
    }
    return { kind: "local", name: raw.name, labels, default: def };
  }

  path(raw: unknown, where: string, args: readonly DialogueArgument[]): DialoguePath | null {
    const r = this.r;
    if (!isRecord(raw)) return void r.problem(where, "a path must be an object; dropped."), null;
    if (!Array.isArray(raw.path)) return void r.problem(`${where}.path`, "must be a list of labels or *; dropped."), null;
    const entries = raw.path.slice(0, args.length).map((v, i) => {
      if (typeof v === "string" && v !== "") return v;
      r.problem(`${where}.path[${i}]`, "must be a label or *; using *.");
      return WILDCARD;
    });
    if (raw.path.length > args.length) r.problem(`${where}.path`, `has ${raw.path.length} entries for ${args.length} arguments; the rest are dropped.`);
    if (entries.length < args.length) {
      r.problem(`${where}.path`, `has ${entries.length} entries for ${args.length} arguments; filled with *.`);
      while (entries.length < args.length) entries.push(WILDCARD);
    }
    entries.forEach((v, i) => {
      const a = args[i];
      if (v !== WILDCARD && a.kind === "local" && !a.labels.includes(v)) r.problem(`${where}.path[${i}]`, `"${v}" isn't a label of "${a.name}"; it matches nothing.`);
    });
    const lines: DialogueLine[] = [];
    r.list(raw.lines, `${where}.lines`).forEach((l, i) => {
      const w = `${where}.lines[${i}]`;
      const o = typeof l === "string" ? { key: l } : l;
      if (!isRecord(o) || !isLineKey(o.key)) return void r.problem(w, "must be { key, weight } with a line key; dropped.");
      if (lines.length >= DIALOGUE_LIMITS.linesPerPath) return void r.problem(w, `at most ${DIALOGUE_LIMITS.linesPerPath} lines per path; dropped.`);
      lines.push({ key: o.key, weight: r.num(o.weight, `${w}.weight`, 1, 0, 100) });
    });
    if (raw.lines === undefined) r.problem(`${where}.lines`, "missing; read as [] (an explicit silence).");
    // A path's weight is kept in best-match mode too (switching the mode back and forth loses nothing).
    return { path: entries, lines, probability: r.num(raw.probability, `${where}.probability`, 1, 0, 1), weight: r.num(raw.weight, `${where}.weight`, 1, 0, 100) };
  }

  event(raw: unknown, where: string): DialogueEvent | null {
    const r = this.r;
    if (!isRecord(raw)) return void r.problem(where, "an event must be an object; dropped."), null;
    if (!isEventName(raw.name)) return void r.problem(`${where}.name`, `${JSON.stringify(raw.name)} isn't an event name (letters, digits, _ . -, at most 64); dropped.`), null;
    const out = emptyDialogueEvent(raw.name);
    const names = new Set<string>();
    r.list(raw.arguments, `${where}.arguments`).forEach((a, i) => {
      const w = `${where}.arguments[${i}]`;
      if (out.arguments.length >= DIALOGUE_LIMITS.arguments) return void r.problem(w, `at most ${DIALOGUE_LIMITS.arguments} arguments; dropped.`);
      const arg = this.argument(a, w, names);
      if (arg) out.arguments.push(arg);
    });
    out.mode = r.pick(raw.mode, `${where}.mode`, ["bestMatch", "weighted"] as const, "bestMatch");
    const seen = new Set<string>();
    r.list(raw.paths, `${where}.paths`).forEach((p, i) => {
      const w = `${where}.paths[${i}]`;
      if (out.paths.length >= DIALOGUE_LIMITS.paths) return void r.problem(w, `at most ${DIALOGUE_LIMITS.paths} paths; dropped.`);
      const path = this.path(p, w, out.arguments);
      if (!path) return;
      const id = JSON.stringify(path.path);
      if (seen.has(id)) return void r.problem(w, `[${path.path.join(", ")}] is already a path of this event; dropped.`);
      seen.add(id);
      out.paths.push(path);
    });
    out.priority = raw.priority === undefined || raw.priority === null ? null : r.int(raw.priority, `${where}.priority`, 50, 0, 100);
    out.whenBusy = r.pick(raw.whenBusy, `${where}.whenBusy`, WHEN_BUSY, "queue");
    out.interrupt = r.pick(raw.interrupt, `${where}.interrupt`, INTERRUPT, "lower");
    out.maxWait = r.num(raw.maxWait, `${where}.maxWait`, 2, 0, DIALOGUE_LIMITS.seconds);
    out.cooldown = r.num(raw.cooldown, `${where}.cooldown`, 0, 0, DIALOGUE_LIMITS.seconds);
    out.chance = r.num(raw.chance, `${where}.chance`, 1, 0, 1);
    out.avoidRepeat = r.int(raw.avoidRepeat, `${where}.avoidRepeat`, 1, 0, DIALOGUE_LIMITS.avoidRepeat);
    out.skipMissing = r.bool(raw.skipMissing, `${where}.skipMissing`, true);
    const on = r.strOrNull(raw.onInterrupted, `${where}.onInterrupted`, null);
    if (on !== null) {
      if (!isEventName(on)) r.problem(`${where}.onInterrupted`, `"${on}" isn't an event name; using null.`);
      else if (on === out.name) r.problem(`${where}.onInterrupted`, "an event can't follow its own interruption; using null.");
      else out.onInterrupted = on;
    }
    return out;
  }
}

/** A dialogue file, leniently (never throws). */
export function parseDialogue(raw: unknown, path = "dialogue"): DialogueParse {
  const problems: string[] = [];
  const reader = new DialogueReader(problems);
  const r = reader.r;
  const dialogue = emptyDialogue();
  if (!isRecord(raw)) {
    r.problem(path, "a dialogue file must be an object; using an empty one.");
    return { dialogue, problems };
  }
  if (raw.format !== DIALOGUE_FORMAT) r.problem(`${path}.format`, `expected "${DIALOGUE_FORMAT}", found ${JSON.stringify(raw.format)}; read as ${DIALOGUE_FORMAT}.`);
  const names = new Set<string>();
  r.list(raw.events, `${path}.events`).forEach((e, i) => {
    const w = `${path}.events[${i}]`;
    if (dialogue.events.length >= DIALOGUE_LIMITS.events) return void r.problem(w, `at most ${DIALOGUE_LIMITS.events} events; dropped.`);
    const event = reader.event(e, w);
    if (!event) return;
    if (names.has(event.name)) return void r.problem(`${w}.name`, `"${event.name}" is used twice; dropped.`);
    names.add(event.name);
    dialogue.events.push(event);
  });
  return { dialogue, problems };
}

function eventToJson(e: DialogueEvent): JsonRecord {
  const d = emptyDialogueEvent(e.name);
  const out: JsonRecord = { name: e.name };
  out.arguments = e.arguments.map((a) => (a.kind === "parameter" ? { parameter: a.parameter } : { name: a.name, labels: [...a.labels], ...(a.default !== a.labels[0] ? { default: a.default } : {}) }));
  if (e.mode !== d.mode) out.mode = e.mode;
  out.paths = e.paths.map((p) => {
    const json: JsonRecord = { path: [...p.path], lines: p.lines.map((l) => (l.weight === 1 ? { key: l.key } : { key: l.key, weight: l.weight })) };
    if (p.probability !== 1) json.probability = p.probability;
    if (p.weight !== 1) json.weight = p.weight;
    return json;
  });
  if (e.priority !== null) out.priority = e.priority;
  for (const k of ["whenBusy", "interrupt", "maxWait", "cooldown", "chance", "avoidRepeat", "skipMissing", "onInterrupted"] as const) {
    if (e[k] !== d[k]) out[k] = e[k];
  }
  return out;
}

/** A dialogue file as JSON: `format` first, stable key order, defaults left out. */
export const dialogueToJson = (a: DialogueAsset): JsonRecord => ({ format: DIALOGUE_FORMAT, events: a.events.map(eventToJson) });

/** The file's text: two-space JSON and a final newline. */
export const formatDialogue = (a: DialogueAsset): string => `${JSON.stringify(dialogueToJson(a), null, 2)}\n`;

/** The event's argument names in order (`args` keys). */
export const argumentNames = (e: DialogueEvent): string[] => e.arguments.map(argumentName);
