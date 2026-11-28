// The Events tab's model (ADR 0355 §7): the event list over every `*.dialogue.json`, the event edits (add, duplicate,
// rename with its `onInterrupted` references, delete, settings), the path table (one column per argument, weighted line
// chips, probability and weight), argument edits with the paths they affect shown before applying, the tree grouping
// (Wwise's view of the same table), and the inline lints: unknown labels and keys, and paths reached only as a
// fallback. Every edit is refused or next (0313) over the file's `DialogueAsset`. Pure.
import { DIALOGUE_LIMITS, emptyDialogueEvent, isEventName } from "../../../../engine/audio/dialogue/format";
import { compareBestMatch } from "../../../../engine/audio/dialogue/decide";
import {
  argumentName, WILDCARD, type DialogueArgument, type DialogueAsset, type DialogueEvent, type DialogueLine, type DialoguePath,
} from "../../../../engine/audio/dialogue/types";
import type { EditResult } from "../../../../editor/sdk/editResult";
import { UNDERSCORED, uniqueName, type Numbering } from "../../../../engine/core/uniqueName";

/** A dialogue file and where it is. */
export interface DialogueDoc {
  readonly path: string;
  readonly asset: DialogueAsset;
}

/** An event and the file it is in. */
export interface EventRef {
  readonly path: string;
  readonly event: DialogueEvent;
}

/** What the events need from the project: global labelled parameters' labels. */
export interface EventContext {
  /** A global labelled parameter's labels; null when it isn't one (deleted, or numeric). */
  parameterLabels(name: string): readonly string[] | null;
}

/** An argument's labels: its own, or its global parameter's (none when the global is gone). */
export const labelsOf = (a: DialogueArgument, ctx: EventContext): readonly string[] => (a.kind === "local" ? a.labels : ctx.parameterLabels(a.parameter) ?? []);

/** Every event of every file, file path order, then file order; with a search over names. */
export function eventList(docs: readonly DialogueDoc[], search = ""): EventRef[] {
  const q = search.trim().toLowerCase();
  return [...docs].sort((a, b) => (a.path < b.path ? -1 : 1)).flatMap((d) => d.asset.events.filter((e) => e.name.toLowerCase().includes(q)).map((event) => ({ path: d.path, event })));
}

/** Event names used anywhere in the project. */
export const usedEventNames = (docs: readonly DialogueDoc[]): Set<string> => new Set(docs.flatMap((d) => d.asset.events.map((e) => e.name)));

const refuse = (refused: string) => ({ refused });

function withEvent(a: DialogueAsset, name: string, change: (e: DialogueEvent) => EditResult<DialogueEvent>): EditResult<DialogueAsset> {
  const i = a.events.findIndex((e) => e.name === name);
  if (i < 0) return refuse(`there is no event "${name}" in this file`);
  const r = change(a.events[i]);
  if ("refused" in r) return r;
  if (r.next === a.events[i]) return { next: a };
  return { next: { ...a, events: a.events.map((e, j) => (j === i ? r.next : e)) } };
}

/** `base`, else `base_2`, `base_3`…, renumbering `name_2` rather than extending it. */
const EVENTS: Numbering = { ...UNDERSCORED, suffix: /_\d+$/ };
const freeName = (base: string, used: ReadonlySet<string>): string => uniqueName(base, used, EVENTS);

export function addEvent(a: DialogueAsset, used: ReadonlySet<string>): EditResult<DialogueAsset> {
  if (a.events.length >= DIALOGUE_LIMITS.events) return refuse(`a file holds at most ${DIALOGUE_LIMITS.events} events`);
  return { next: { ...a, events: [...a.events, emptyDialogueEvent(freeName("new_event", used))] } };
}

export function duplicateEvent(a: DialogueAsset, name: string, used: ReadonlySet<string>): EditResult<DialogueAsset> {
  const i = a.events.findIndex((e) => e.name === name);
  if (i < 0) return refuse(`there is no event "${name}" in this file`);
  if (a.events.length >= DIALOGUE_LIMITS.events) return refuse(`a file holds at most ${DIALOGUE_LIMITS.events} events`);
  const copy: DialogueEvent = structuredClone(a.events[i]);
  copy.name = freeName(`${name}_2`, used);
  const events = [...a.events];
  events.splice(i + 1, 0, copy);
  return { next: { ...a, events } };
}

/** Rename an event (valid, unique across the project); `onInterrupted` references in the file follow. */
export function renameEvent(a: DialogueAsset, name: string, to: string, used: ReadonlySet<string>): EditResult<DialogueAsset> {
  if (to === name) return { next: a };
  if (!isEventName(to)) return refuse(`"${to}" isn't an event name (letters, digits, _ . -, at most 64)`);
  if (used.has(to)) return refuse(`"${to}" is already an event in this project`);
  if (!a.events.some((e) => e.name === name)) return refuse(`there is no event "${name}" in this file`);
  return { next: { ...a, events: a.events.map((e) => ({ ...e, name: e.name === name ? to : e.name, onInterrupted: e.onInterrupted === name ? to : e.onInterrupted })) } };
}

/** A renamed line key rewritten in every path of a file (0354 §5: a key rename follows its references); null when none names it. */
export function renameLineInDialogue(a: DialogueAsset, from: string, to: string): DialogueAsset | null {
  if (!a.events.some((e) => e.paths.some((p) => p.lines.some((l) => l.key === from)))) return null;
  return { ...a, events: a.events.map((e) => ({ ...e, paths: e.paths.map((p) => ({ ...p, lines: p.lines.map((l) => (l.key === from ? { ...l, key: to } : l)) })) })) };
}

/** `onInterrupted` references to `from` rewritten in another file (one undo step of that file; null when none). */
export function renameEventReferences(a: DialogueAsset, from: string, to: string): DialogueAsset | null {
  if (!a.events.some((e) => e.onInterrupted === from)) return null;
  return { ...a, events: a.events.map((e) => (e.onInterrupted === from ? { ...e, onInterrupted: to } : e)) };
}

export function deleteEvent(a: DialogueAsset, name: string): EditResult<DialogueAsset> {
  if (!a.events.some((e) => e.name === name)) return refuse(`there is no event "${name}" in this file`);
  return { next: { ...a, events: a.events.filter((e) => e.name !== name).map((e) => (e.onInterrupted === name ? { ...e, onInterrupted: null } : e)) } };
}

export type EventSettings = Pick<DialogueEvent, "mode" | "priority" | "whenBusy" | "interrupt" | "maxWait" | "cooldown" | "chance" | "avoidRepeat" | "skipMissing" | "onInterrupted">;

/** Change event settings, within their limits. */
export function setEventSettings(a: DialogueAsset, name: string, patch: Partial<EventSettings>): EditResult<DialogueAsset> {
  return withEvent(a, name, (e) => {
    const n = { ...e, ...patch };
    if (n.priority !== null && !(n.priority >= 0 && n.priority <= 100)) return refuse("priority is 0 to 100");
    if (!(n.chance >= 0 && n.chance <= 1)) return refuse("chance is 0 to 1");
    if (!(n.maxWait >= 0 && n.maxWait <= DIALOGUE_LIMITS.seconds) || !(n.cooldown >= 0 && n.cooldown <= DIALOGUE_LIMITS.seconds)) return refuse(`times are 0 to ${DIALOGUE_LIMITS.seconds} seconds`);
    if (!(Number.isInteger(n.avoidRepeat) && n.avoidRepeat >= 0 && n.avoidRepeat <= DIALOGUE_LIMITS.avoidRepeat)) return refuse(`avoid repeat is 0 to ${DIALOGUE_LIMITS.avoidRepeat}`);
    if (n.onInterrupted === e.name) return refuse("an event can't follow its own interruption");
    return { next: n };
  });
}

// --- paths ---------------------------------------------------------------------------------------------------------------

const samePath = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((x, i) => x === b[i]);

function withPaths(a: DialogueAsset, name: string, change: (e: DialogueEvent) => EditResult<DialoguePath[]>): EditResult<DialogueAsset> {
  return withEvent(a, name, (e) => {
    const r = change(e);
    return "refused" in r ? r : { next: { ...e, paths: r.next } };
  });
}

/** A new path (all `*` unless given), refused when the table already has it. */
export function addPath(a: DialogueAsset, name: string, path?: readonly string[]): EditResult<DialogueAsset> {
  return withPaths(a, name, (e) => {
    const p = path ? [...path] : e.arguments.map(() => WILDCARD);
    if (p.length !== e.arguments.length) return refuse("a path has one entry per argument");
    if (e.paths.length >= DIALOGUE_LIMITS.paths) return refuse(`an event has at most ${DIALOGUE_LIMITS.paths} paths`);
    if (e.paths.some((x) => samePath(x.path, p))) return refuse(`the path ${p.join(" · ")} is already in the table`);
    return { next: [...e.paths, { path: p, lines: [], probability: 1, weight: 1 }] };
  });
}

export function removePath(a: DialogueAsset, name: string, index: number): EditResult<DialogueAsset> {
  return withPaths(a, name, (e) => (e.paths[index] ? { next: e.paths.filter((_, i) => i !== index) } : refuse("that path is gone")));
}

/** One cell of a path: a label or `*`; refused when it makes the path equal another. */
export function setPathEntry(a: DialogueAsset, name: string, index: number, arg: number, value: string): EditResult<DialogueAsset> {
  return withPaths(a, name, (e) => {
    const p = e.paths[index];
    if (!p) return refuse("that path is gone");
    if (arg < 0 || arg >= p.path.length) return refuse("no such argument");
    const path = p.path.map((x, i) => (i === arg ? value : x));
    if (e.paths.some((x, i) => i !== index && samePath(x.path, path))) return refuse(`the path ${path.join(" · ")} is already in the table`);
    return { next: e.paths.map((x, i) => (i === index ? { ...x, path } : x)) };
  });
}

/** A path's weighted lines (the chips); keys appear once. */
export function setPathLines(a: DialogueAsset, name: string, index: number, lines: readonly DialogueLine[]): EditResult<DialogueAsset> {
  return withPaths(a, name, (e) => {
    const p = e.paths[index];
    if (!p) return refuse("that path is gone");
    if (lines.length > DIALOGUE_LIMITS.linesPerPath) return refuse(`a path has at most ${DIALOGUE_LIMITS.linesPerPath} lines`);
    if (new Set(lines.map((l) => l.key)).size !== lines.length) return refuse("a line is on the path twice");
    if (lines.some((l) => !(l.weight >= 0 && l.weight <= 100))) return refuse("a weight is 0 to 100");
    return { next: e.paths.map((x, i) => (i === index ? { ...x, lines: lines.map((l) => ({ ...l })) } : x)) };
  });
}

export function setPathNumbers(a: DialogueAsset, name: string, index: number, patch: { probability?: number; weight?: number }): EditResult<DialogueAsset> {
  return withPaths(a, name, (e) => {
    const p = e.paths[index];
    if (!p) return refuse("that path is gone");
    const n = { ...p, ...patch };
    if (!(n.probability >= 0 && n.probability <= 1)) return refuse("probability is 0 to 1");
    if (!(n.weight >= 0 && n.weight <= 100)) return refuse("weight is 0 to 100");
    return { next: e.paths.map((x, i) => (i === index ? n : x)) };
  });
}

// --- arguments, with their impact ------------------------------------------------------------------------------------------

/** What an argument change does to the paths, shown before it is applied. */
export interface ArgumentImpact {
  /** Paths whose entries change (index into the current table, with the new path). */
  readonly rewritten: readonly { readonly index: number; readonly to: readonly string[] }[];
  /** Paths removed (they named a removed label), or merged into an equal earlier path. */
  readonly removed: readonly { readonly index: number; readonly why: string }[];
}

export type ArgumentChange =
  | { readonly kind: "add"; readonly name: string; readonly labels: readonly string[] }
  | { readonly kind: "link"; readonly parameter: string }
  | { readonly kind: "remove"; readonly arg: number }
  | { readonly kind: "move"; readonly arg: number; readonly to: number }
  | { readonly kind: "labels"; readonly arg: number; readonly labels: readonly string[]; readonly renamed?: Readonly<Record<string, string>> }
  | { readonly kind: "unlink"; readonly arg: number }
  | { readonly kind: "default"; readonly arg: number; readonly label: string };

/** The event after `change` and its impact on the paths, or why it can't be made. */
export function changeArgument(e: DialogueEvent, change: ArgumentChange, ctx: EventContext): EditResult<{ event: DialogueEvent; impact: ArgumentImpact }> {
  const args = e.arguments;
  const names = args.map(argumentName);
  const rewrite = (args2: DialogueArgument[], map: (p: readonly string[]) => { to: string[] } | { drop: string }): EditResult<{ event: DialogueEvent; impact: ArgumentImpact }> => {
    const rewritten: { index: number; to: string[] }[] = [];
    const removed: { index: number; why: string }[] = [];
    const paths: DialoguePath[] = [];
    e.paths.forEach((p, index) => {
      const m = map(p.path);
      if ("drop" in m) return void removed.push({ index, why: m.drop });
      if (paths.some((q) => samePath(q.path, m.to))) return void removed.push({ index, why: `becomes ${m.to.join(" · ")}, already in the table` });
      if (!samePath(m.to, p.path)) rewritten.push({ index, to: m.to });
      paths.push({ ...p, path: m.to });
    });
    return { next: { event: { ...e, arguments: args2, paths }, impact: { rewritten, removed } } };
  };
  const at = (i: number) => (i >= 0 && i < args.length ? args[i] : null);
  switch (change.kind) {
    case "add":
    case "link": {
      const name = change.kind === "add" ? change.name.trim() : change.parameter;
      if (args.length >= DIALOGUE_LIMITS.arguments) return refuse(`an event has at most ${DIALOGUE_LIMITS.arguments} arguments`);
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) return refuse(`"${name}" isn't an argument name`);
      if (names.includes(name)) return refuse(`the event already has an argument "${name}"`);
      let arg: DialogueArgument;
      if (change.kind === "add") {
        const labels = cleanLabels(change.labels);
        if ("refused" in labels) return labels;
        if (labels.next.length === 0) return refuse("an argument needs at least one label");
        arg = { kind: "local", name, labels: labels.next, default: labels.next[0] };
      } else {
        if (ctx.parameterLabels(change.parameter) === null) return refuse(`"${change.parameter}" isn't a global labelled parameter`);
        arg = { kind: "parameter", parameter: change.parameter };
      }
      return rewrite([...args, arg], (p) => ({ to: [...p, WILDCARD] }));
    }
    case "remove": {
      if (!at(change.arg)) return refuse("no such argument");
      return rewrite(args.filter((_, i) => i !== change.arg), (p) => ({ to: p.filter((_, i) => i !== change.arg) }));
    }
    case "move": {
      if (!at(change.arg) || change.to < 0 || change.to >= args.length) return refuse("no such argument");
      const order = args.map((_, i) => i);
      order.splice(change.to, 0, ...order.splice(change.arg, 1));
      return rewrite(order.map((i) => args[i]), (p) => ({ to: order.map((i) => p[i]) }));
    }
    case "labels": {
      const a = at(change.arg);
      if (!a || a.kind !== "local") return refuse("only an argument with its own labels has labels to edit");
      const labels = cleanLabels(change.labels);
      if ("refused" in labels) return labels;
      if (labels.next.length === 0) return refuse("an argument needs at least one label");
      const renamed = change.renamed ?? {};
      const def = renamed[a.default] ?? a.default;
      const next: DialogueArgument = { ...a, labels: labels.next, default: labels.next.includes(def) ? def : labels.next[0] };
      return rewrite(args.map((x, i) => (i === change.arg ? next : x)), (p) => {
        const v = p[change.arg];
        if (v === WILDCARD) return { to: [...p] };
        const to = renamed[v] ?? v;
        if (!labels.next.includes(to)) return { drop: `names "${v}", which is removed` };
        return { to: p.map((x, i) => (i === change.arg ? to : x)) };
      });
    }
    case "unlink": {
      const a = at(change.arg);
      if (!a || a.kind !== "parameter") return refuse("that argument isn't linked to a global parameter");
      const labels = [...(ctx.parameterLabels(a.parameter) ?? [])];
      if (labels.length === 0) return refuse(`"${a.parameter}" has no labels to copy`);
      return rewrite(args.map((x, i) => (i === change.arg ? { kind: "local", name: a.parameter, labels, default: labels[0] } : x)), (p) => ({ to: [...p] }));
    }
    case "default": {
      const a = at(change.arg);
      if (!a || a.kind !== "local") return refuse("only an argument with its own labels has a default");
      if (!a.labels.includes(change.label)) return refuse(`"${change.label}" isn't one of its labels`);
      return rewrite(args.map((x, i) => (i === change.arg ? { ...a, default: change.label } : x)), (p) => ({ to: [...p] }));
    }
  }
}

/** Typed labels as a labels change: comma or space separated, a rename written `Old=New` ("Clear, Rain=Storm, Fog"). */
export function labelsChange(arg: number, text: string): ArgumentChange {
  const renamed: Record<string, string> = {};
  const labels = text.replace(/\s*=\s*/g, "=").split(/[\s,]+/).filter(Boolean).map((x) => {
    const [from, to] = x.split("=");
    if (to === undefined || to === "") return from;
    renamed[from] = to;
    return to;
  });
  return { kind: "labels", arg, labels, renamed };
}

function cleanLabels(raw: readonly string[]): EditResult<string[]> {
  const out = [...new Set(raw.map((l) => l.trim()).filter(Boolean))];
  if (out.includes(WILDCARD)) return refuse("* is the wildcard, not a label");
  if (out.length > DIALOGUE_LIMITS.labels) return refuse(`an argument has at most ${DIALOGUE_LIMITS.labels} labels`);
  return { next: out };
}

/** Apply an argument change to the file's event. */
export function applyArgumentChange(a: DialogueAsset, name: string, change: ArgumentChange, ctx: EventContext): EditResult<DialogueAsset> {
  return withEvent(a, name, (e) => {
    const r = changeArgument(e, change, ctx);
    return "refused" in r ? r : { next: r.next.event };
  });
}

// --- tree grouping -------------------------------------------------------------------------------------------------------

/** A node of the tree view: an argument value, the paths under it, and its children (by the next argument). */
export interface PathNode {
  readonly label: string;
  readonly depth: number;
  /** Path indices whose entries up to here match this branch exactly. */
  readonly paths: readonly number[];
  readonly children: readonly PathNode[];
}

/** The path table as a tree (Wwise's view): grouped by each argument's entry in turn, labels in their order, `*` last. */
export function pathTree(e: DialogueEvent, ctx: EventContext): PathNode[] {
  const build = (indices: number[], depth: number): PathNode[] => {
    if (depth >= e.arguments.length) return [];
    const labels = [...labelsOf(e.arguments[depth], ctx)];
    const seen = new Set(indices.map((i) => e.paths[i].path[depth]));
    const order = [...labels.filter((l) => seen.has(l)), ...[...seen].filter((l) => l !== WILDCARD && !labels.includes(l)), ...(seen.has(WILDCARD) ? [WILDCARD] : [])];
    return order.map((label) => {
      const under = indices.filter((i) => e.paths[i].path[depth] === label);
      return { label, depth, paths: under, children: build(under, depth + 1) };
    });
  };
  return build(e.paths.map((_, i) => i), 0);
}

// --- lints ---------------------------------------------------------------------------------------------------------------

export interface PathLint {
  readonly index: number;
  readonly message: string;
}

/** The most combinations a path's fallback-only check enumerates. */
const LINT_COMBINATIONS = 4096;

/** Lints per path: unknown labels, unknown line keys, and paths reached only as a fallback. */
export function pathLints(e: DialogueEvent, ctx: EventContext, lineKeys: ReadonlySet<string>): PathLint[] {
  const out: PathLint[] = [];
  const labels = e.arguments.map((a) => labelsOf(a, ctx));
  for (const a of e.arguments) {
    if (a.kind === "parameter" && ctx.parameterLabels(a.parameter) === null) out.push({ index: -1, message: `"${a.parameter}" isn't a global labelled parameter: this argument matches only *` });
  }
  e.paths.forEach((p, index) => {
    p.path.forEach((v, i) => {
      if (v !== WILDCARD && !labels[i].includes(v)) out.push({ index, message: `"${v}" isn't a label of ${argumentName(e.arguments[i])}` });
    });
    for (const l of p.lines) if (!lineKeys.has(l.key)) out.push({ index, message: `no line "${l.key}"` });
  });
  // Reached only as a fallback: in every combination it matches, a more specific path comes first.
  e.paths.forEach((p, index) => {
    if (!p.path.includes(WILDCARD)) return;
    const choices = p.path.map((v, i) => (v === WILDCARD ? labels[i] : [v]));
    const total = choices.reduce((n, c) => n * c.length, 1);
    if (total === 0 || total > LINT_COMBINATIONS) return;
    const combo: string[] = [];
    let first = false;
    const visit = (i: number): void => {
      if (first) return;
      if (i === choices.length) {
        const winner = bestCandidate(e, combo);
        if (winner === index) first = true;
        return;
      }
      for (const c of choices[i]) { combo[i] = c; visit(i + 1); }
    };
    visit(0);
    if (!first) out.push({ index, message: "reached only as a fallback: every label under its * is taken by a more specific path" });
  });
  return out;
}

/** The path best match tries first for these values (no draws), or -1. */
export function bestCandidate(e: DialogueEvent, values: readonly (string | null)[]): number {
  let best = -1;
  e.paths.forEach((p, i) => {
    if (!p.path.every((v, j) => v === WILDCARD || v === values[j])) return;
    if (best < 0 || compareBestMatch(p.path, e.paths[best].path) < 0) best = i;
  });
  return best;
}
