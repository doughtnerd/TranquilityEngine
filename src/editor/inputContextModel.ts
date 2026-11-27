// Input context assets in the editor (ADR 0336): the `*.input.json` format, the edits the context editor makes
// (each a new value, so one asset-document step), the tables its form is drawn from (composites and their parts,
// modifiers and triggers with their parameters), the controls it offers grouped by device, and its problems, which are
// the evaluator's own (`inputContextProblems` in the editor SDK), so the editor says what Play would log.
import type { InputContextSpec, MappingSpec, ModifierSpec, TriggerSpec, TriggerType } from "../engine/input/contextTypes";
import type { ActionKind } from "../engine/input/actions";
import { inputControlInfo, inputControlPaths, type InputActionSetInfo } from "../engine/editor";
import type { AssetFormat, AssetProblem } from "./sdk/contributions";

// --- the format ----------------------------------------------------------------------------------

/** A new context's value. */
export const emptyInputContext = (): InputContextSpec => ({ name: "New Input Context", mappings: [] });

/**
 * A file's JSON to a context. A file that isn't an object with a `mappings` list is read as an empty context with a
 * problem; mappings that aren't objects are dropped, and a mapping's `action` is made a string, as the evaluator needs.
 */
export function parseInputContext(raw: unknown, path: string): { value: InputContextSpec; problems: AssetProblem[] } {
  if (raw === undefined) return { value: emptyInputContext(), problems: [] };
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return { value: { name: "", mappings: [] }, problems: [{ message: `${path} isn't an input context: it should be an object with "name" and "mappings".` }] };
  const r = raw as Record<string, unknown>;
  const problems: AssetProblem[] = [];
  if (!Array.isArray(r.mappings)) problems.push({ message: `${path} has no "mappings" list.` });
  const list = Array.isArray(r.mappings) ? r.mappings : [];
  const mappings = list.filter((m): m is Record<string, unknown> => !!m && typeof m === "object" && !Array.isArray(m)).map((m) => ({ ...m, action: typeof m.action === "string" ? m.action : "" }) as MappingSpec);
  if (mappings.length < list.length) problems.push({ message: `${list.length - mappings.length} of ${path}'s mappings aren't objects and were left out.` });
  return { value: { ...(r as object), name: typeof r.name === "string" ? r.name : "", mappings }, problems };
}

export const formatInputContext = (spec: InputContextSpec): string => `${JSON.stringify(spec, null, 2)}\n`;

export const inputContextFormat: AssetFormat<InputContextSpec> = {
  parse: parseInputContext,
  format: formatInputContext,
  empty: emptyInputContext,
  writeDelay: 300,
};

// --- composites ----------------------------------------------------------------------------------

export type CompositeKind = "single" | "dpad" | "axis" | "modifier";

/** Each composite's label and the parts it reads, in the order the form shows them. */
export const COMPOSITES: Record<CompositeKind, { readonly label: string; readonly parts: readonly string[] }> = {
  single: { label: "Single control", parts: ["control"] },
  dpad: { label: "D-pad (four buttons to a vec2)", parts: ["up", "down", "left", "right"] },
  axis: { label: "Axis (two buttons to an axis)", parts: ["negative", "positive"] },
  modifier: { label: "Chord (held modifier + control)", parts: ["modifier", "control"] },
};

const PART_FIELDS = ["control", "up", "down", "left", "right", "negative", "positive", "modifier"] as const;

export const compositeOf = (m: MappingSpec): CompositeKind => m.composite ?? "single";

/** The mapping as `kind`: the parts it no longer reads go; the main control is kept for single and chord. */
export function setComposite(m: MappingSpec, kind: CompositeKind): MappingSpec {
  if (kind === compositeOf(m)) return m;
  const out: Record<string, unknown> = { ...m };
  for (const f of PART_FIELDS) delete out[f];
  delete out.composite;
  if (kind !== "single") out.composite = kind;
  for (const part of COMPOSITES[kind].parts) out[part] = part === "control" ? (m.control ?? "") : "";
  return out as unknown as MappingSpec;
}

/** A part's control path ("" when unset). A chord's `modifier` may list several; the form edits them joined by "+". */
export function partValue(m: MappingSpec, part: string): string {
  const v = (m as unknown as Record<string, unknown>)[part];
  if (Array.isArray(v)) return v.join(" + ");
  return typeof v === "string" ? v : "";
}

/** Set a part's control path. A chord's modifier given as "a + b" is stored as a list. */
export function setPart(m: MappingSpec, part: string, path: string): MappingSpec {
  const trimmed = path.trim();
  if (part === "modifier") {
    const list = trimmed.split(/\s*\+\s*(?=<)/).filter(Boolean);
    return { ...m, modifier: list.length > 1 ? list : (list[0] ?? "") };
  }
  return { ...m, [part]: trimmed } as MappingSpec;
}

// --- modifiers and triggers ----------------------------------------------------------------------

/** One parameter of a modifier or trigger: a number, a yes/no, a choice, a string or an action of the same set. */
export type ParamSpec =
  | { readonly key: string; readonly label: string; readonly type: "number"; readonly default?: number; readonly min?: number; readonly step?: number; readonly optional?: boolean }
  | { readonly key: string; readonly label: string; readonly type: "bool" }
  | { readonly key: string; readonly label: string; readonly type: "choice"; readonly options: readonly string[] }
  | { readonly key: string; readonly label: string; readonly type: "text"; readonly placeholder?: string }
  | { readonly key: string; readonly label: string; readonly type: "action" };

/** A modifier's or trigger's form: its label and parameters. `flag` ones are written as `{ name: true }`. */
export interface StepSpec {
  readonly label: string;
  readonly params: readonly ParamSpec[];
  readonly flag?: boolean;
  /** Its value is the one parameter itself (`{ swizzle: "yx" }`), not an object of parameters. */
  readonly scalar?: boolean;
  /** Its parameters are per component, x, y and z (negate, scale): written as one value when all three agree. */
  readonly perComponent?: "bool" | "number";
}

export const MODIFIERS = {
  deadzone: {
    label: "Dead zone",
    params: [
      { key: "min", label: "Min", type: "number", default: 0.15, min: 0, step: 0.01 },
      { key: "max", label: "Max", type: "number", default: 1, min: 0, step: 0.01 },
      { key: "shape", label: "Shape", type: "choice", options: ["", "axial", "radial"] },
    ],
  },
  negate: { label: "Negate", perComponent: "bool", params: [] },
  swizzle: { label: "Swizzle", scalar: true, params: [{ key: "swizzle", label: "Order", type: "text", placeholder: "yx" }] },
  scale: { label: "Scale", perComponent: "number", params: [] },
  curve: { label: "Response curve", params: [{ key: "exponent", label: "Exponent", type: "number", default: 2, min: 0, step: 0.1 }] },
  smooth: { label: "Smooth", params: [{ key: "rate", label: "Rate", type: "number", default: 10, min: 0, step: 0.5 }] },
} as const satisfies Record<string, StepSpec>;

export const TRIGGERS = {
  down: { label: "Down", flag: true, params: [] },
  pressed: { label: "Pressed", flag: true, params: [] },
  released: { label: "Released", flag: true, params: [] },
  hold: {
    label: "Hold",
    params: [
      { key: "min", label: "Seconds", type: "number", default: 0.4, min: 0, step: 0.05 },
      { key: "oneShot", label: "One shot", type: "bool" },
    ],
  },
  holdAndRelease: { label: "Hold and release", params: [{ key: "min", label: "Seconds", type: "number", default: 0.4, min: 0, step: 0.05 }] },
  tap: { label: "Tap", params: [{ key: "max", label: "Max seconds", type: "number", default: 0.2, min: 0, step: 0.05 }] },
  multiTap: {
    label: "Multi-tap",
    params: [
      { key: "count", label: "Taps", type: "number", default: 2, min: 1, step: 1 },
      { key: "spacing", label: "Spacing", type: "number", default: 0.3, min: 0, step: 0.05 },
      { key: "max", label: "Max per tap", type: "number", optional: true, min: 0, step: 0.05 },
    ],
  },
  pulse: {
    label: "Pulse",
    params: [
      { key: "interval", label: "Interval", type: "number", default: 0.25, min: 0, step: 0.05 },
      { key: "delay", label: "Delay", type: "number", optional: true, min: 0, step: 0.05 },
      { key: "limit", label: "Limit", type: "number", optional: true, min: 0, step: 1 },
    ],
  },
  chord: { label: "Chord (another action)", params: [{ key: "action", label: "Action", type: "action" }] },
  combo: { label: "Combo (sequence)", params: [] },
} as const satisfies Record<string, StepSpec>;

export type ModifierName = keyof typeof MODIFIERS;
export type TriggerName = keyof typeof TRIGGERS;

export const TRIGGER_TYPES: readonly TriggerType[] = ["explicit", "implicit", "blocker"];

/** The name of a modifier or trigger (its one key besides `type`). */
export const stepName = (step: ModifierSpec | TriggerSpec): string => Object.keys(step).find((k) => k !== "type") ?? "";

/** A step's parameters as an object (a flag's are none; a scalar's is `{ [name]: value }`). */
export function stepParams(step: ModifierSpec | TriggerSpec): Record<string, unknown> {
  const name = stepName(step);
  const v = (step as Record<string, unknown>)[name];
  if (v && typeof v === "object" && !Array.isArray(v)) return v as Record<string, unknown>;
  if (name === "negate" && v === true) return { x: true, y: true, z: true };
  if (name === "scale" && typeof v === "number") return { x: v, y: v, z: v };
  if (name === "swizzle") return { swizzle: v };
  return {};
}

const spec = (name: string): StepSpec | undefined => (MODIFIERS as Record<string, StepSpec>)[name] ?? (TRIGGERS as Record<string, StepSpec>)[name];

/** A new step `name` with its default parameters. */
export function newStep(name: ModifierName): ModifierSpec;
export function newStep(name: TriggerName, firstAction?: string): TriggerSpec;
export function newStep(name: string, firstAction = ""): ModifierSpec | TriggerSpec {
  const s = spec(name)!;
  if (s.flag) return { [name]: true } as unknown as TriggerSpec;
  if (s.perComponent === "bool") return { negate: { y: true } };
  if (s.perComponent === "number") return { scale: 1 };
  if (s.scalar) return { swizzle: "yx" };
  if (name === "combo") return { combo: { steps: [{ action: firstAction, within: 0.5 }] } };
  const params: Record<string, unknown> = {};
  for (const p of s.params) {
    if (p.type === "number" && !p.optional && p.default !== undefined) params[p.key] = p.default;
    if (p.type === "action") params[p.key] = firstAction;
  }
  return { [name]: params } as unknown as ModifierSpec;
}

/**
 * Set one parameter of a step. `undefined` removes an optional one. Per-component steps are written as one value when
 * x, y and z agree (`{ negate: true }`, `{ scale: 2 }`), as people write them.
 */
export function setStepParam<S extends ModifierSpec | TriggerSpec>(step: S, key: string, value: unknown): S {
  const name = stepName(step);
  const s = spec(name);
  const type = (step as { type?: TriggerType }).type;
  const withType = (o: Record<string, unknown>) => (type ? { ...o, type } : o) as unknown as S;
  if (s?.scalar) return withType({ [name]: value });
  const params = { ...stepParams(step) };
  if (value === undefined) delete params[key];
  else params[key] = value;
  if (s?.perComponent === "bool") {
    const all = ["x", "y", "z"].every((k) => params[k] === true);
    const flips = Object.fromEntries(["x", "y", "z"].filter((k) => params[k] === true).map((k) => [k, true]));
    return withType({ [name]: all ? true : flips });
  }
  if (s?.perComponent === "number") {
    const [x, y, z] = ["x", "y", "z"].map((k) => (typeof params[k] === "number" ? (params[k] as number) : 1));
    return withType({ [name]: x === y && y === z ? x : { x, y, z } });
  }
  return withType({ [name]: params });
}

/** A trigger with its type (explicit, implicit, blocker); the default for its kind drops the key. */
export function setTriggerType(t: TriggerSpec, type: TriggerType | ""): TriggerSpec {
  const out: Record<string, unknown> = { ...t };
  if (type) out.type = type;
  else delete out.type;
  return out as unknown as TriggerSpec;
}

// --- list edits ----------------------------------------------------------------------------------

/** `list` with item `i` replaced. */
export const replaceAt = <T>(list: readonly T[], i: number, item: T): T[] => list.map((x, j) => (j === i ? item : x));
/** `list` without item `i`. */
export const removeAt = <T>(list: readonly T[], i: number): T[] => list.filter((_, j) => j !== i);
/** `list` with item `i` moved by `by` places (clamped). */
export function moveItem<T>(list: readonly T[], i: number, by: number): T[] {
  const to = Math.max(0, Math.min(list.length - 1, i + by));
  if (to === i) return [...list];
  const out = [...list];
  const [item] = out.splice(i, 1);
  out.splice(to, 0, item);
  return out;
}

/** A mapping's modifiers or triggers replaced; an empty list drops the key, as hand-written files leave it out. */
export function withSteps(m: MappingSpec, key: "modifiers" | "triggers", steps: readonly (ModifierSpec | TriggerSpec)[]): MappingSpec {
  const out: Record<string, unknown> = { ...m };
  if (steps.length) out[key] = steps;
  else delete out[key];
  return out as unknown as MappingSpec;
}

/** A mapping's `consume`: "" follows the action's setting. */
export function setConsume(m: MappingSpec, consume: "" | "true" | "false"): MappingSpec {
  const out: Record<string, unknown> = { ...m };
  if (consume === "") delete out.consume;
  else out.consume = consume === "true";
  return out as unknown as MappingSpec;
}

// --- actions -------------------------------------------------------------------------------------

/** An action a mapping may name: the name written (bare when no other set has an action of that name) and a label. */
export interface ActionChoice {
  readonly value: string;
  readonly label: string;
  readonly kind: string;
}

/** Every defined action, as a mapping names it. */
export function actionChoices(sets: readonly InputActionSetInfo[]): ActionChoice[] {
  const count = new Map<string, number>();
  for (const s of sets) for (const a of s.actions) count.set(a.name, (count.get(a.name) ?? 0) + 1);
  return sets.flatMap((s) =>
    s.actions.map((a) => ({ value: count.get(a.name) === 1 ? a.name : `${s.id}:${a.name}`, label: `${a.name} (${a.kind}) · ${s.id}`, kind: a.kind })),
  );
}

/** Whether any action set is the project's own, not the engine's (`engine.UIActions`, always defined). */
export function hasProjectActionSets(sets: readonly InputActionSetInfo[]): boolean {
  return sets.some((s) => !s.id.startsWith("engine."));
}

// --- action references (ADR 0417) ---------------------------------------------------------------

/** An action a mapping names, resolved: its set and name. */
export interface ActionRef {
  readonly set: string;
  readonly name: string;
}

/**
 * The action `ref` names (`"jump"`, or `"game.PlayerActions:jump"` when two sets have one): the first set, in
 * definition order, with an action of that name, as the evaluator resolves a bare name. Null when none has it.
 */
export function resolveActionRef(ref: string, sets: readonly InputActionSetInfo[]): ActionRef | null {
  const colon = ref.lastIndexOf(":");
  if (colon > 0) {
    const set = ref.slice(0, colon), name = ref.slice(colon + 1);
    return sets.some((s) => s.id === set && s.actions.some((a) => a.name === name)) ? { set, name } : null;
  }
  const set = sets.find((s) => s.actions.some((a) => a.name === ref));
  return set ? { set: set.id, name: ref } : null;
}

/** How a mapping names `set`'s `name`: bare when no other set has an action of that name. */
export function actionRefFor(set: string, name: string, sets: readonly InputActionSetInfo[]): string {
  const shared = sets.some((s) => s.id !== set && s.actions.some((a) => a.name === name));
  return shared ? `${set}:${name}` : name;
}

/** Whether `ref` names `target` (bare or qualified). */
export const refersTo = (ref: string, target: ActionRef, sets: readonly InputActionSetInfo[]): boolean => {
  const r = resolveActionRef(ref, sets);
  return !!r && r.set === target.set && r.name === target.name;
};

/** A mapping with the action `target` renamed to `to` wherever it names it (bare stays bare, qualified stays qualified). */
export function renameMappingAction(m: MappingSpec, target: ActionRef, to: string, sets: readonly InputActionSetInfo[]): MappingSpec {
  return mapMappingRefs(m, (ref) => (refersTo(ref, target, sets) ? (ref.includes(":") ? `${target.set}:${to}` : to) : ref));
}

/** A mapping with every action it names (its own, and its chord and combo triggers') passed through `rename`; the same object when none changed. */
export function mapMappingRefs(m: MappingSpec, rename: (ref: string) => string): MappingSpec {
  let changed = false;
  const action = rename(m.action);
  if (action !== m.action) changed = true;
  const triggers = m.triggers?.map((t) => {
    const r = t as Record<string, unknown>;
    if (r.chord && typeof (r.chord as { action?: unknown }).action === "string") {
      const a = rename((r.chord as { action: string }).action);
      if (a === (r.chord as { action: string }).action) return t;
      changed = true;
      return { ...r, chord: { ...(r.chord as object), action: a } } as TriggerSpec;
    }
    if (r.combo && Array.isArray((r.combo as { steps?: unknown }).steps)) {
      const stepsIn = (r.combo as { steps: { action: string; within?: number }[] }).steps;
      const stepsOut = stepsIn.map((s) => (typeof s.action === "string" ? { ...s, action: rename(s.action) } : s));
      if (stepsOut.every((s, i) => s.action === stepsIn[i].action)) return t;
      changed = true;
      return { ...r, combo: { ...(r.combo as object), steps: stepsOut } } as TriggerSpec;
    }
    return t;
  });
  if (!changed) return m;
  return { ...m, action, ...(triggers ? { triggers } : {}) };
}

// --- controls and action types (ADR 0417) --------------------------------------------------------

/** A mapping's control paths, in its composite's part order, without the empty ones. */
export function mappingControls(m: MappingSpec): string[] {
  return COMPOSITES[compositeOf(m)].parts.map((p) => partValue(m, p)).filter(Boolean);
}

/** The type an action made for a control should have: a stick or delta is a vec2, gyro a vec3, a stick's X an axis, anything else a button. */
export function typeForControl(path: string): ActionKind {
  const info = path ? inputControlInfo(path) : null;
  if (!info) return "button";
  if (info.dimensions === 3) return "vec3";
  if (info.dimensions === 2) return "vec2";
  return info.axis ? "axis" : "button";
}

/** The type an action mapped by `m` should have: a D-pad makes a vec2, Axis an axis, a chord a button, a single control its own. */
export function typeForMapping(m: MappingSpec): ActionKind {
  switch (compositeOf(m)) {
    case "dpad":
      return "vec2";
    case "axis":
      return "axis";
    case "modifier":
      return "button";
    default:
      return typeForControl(m.control ?? "");
  }
}

const COMPONENTS: Record<ActionKind, number> = { button: 1, axis: 1, vec2: 2, vec3: 3 };

/**
 * Why `m`'s controls don't suit an action of `kind`, one message per thing that doesn't (empty when they do). The
 * rules: a D-pad gives two axes, so it suits vec2 and vec3 only; Axis gives one, so not a vec2 or vec3 (it fills X
 * alone); a single control should give as many components as the action reads, except that a one-axis control on a
 * button reads as pressed past the press point, and a stick on a vec3 fills X and Y. Unknown paths are left to the
 * evaluator's problems.
 */
export function unsuitedControls(m: MappingSpec, kind: ActionKind): string[] {
  const out: string[] = [];
  const want = COMPONENTS[kind];
  const composite = compositeOf(m);
  if (composite === "dpad" && want < 2) out.push(`A D-pad gives a vec2, but this is ${kind === "axis" ? "an axis: use Axis (two buttons)" : "a button: use a single control"}.`);
  if (composite === "axis" && want > 1) out.push(`Axis (two buttons) gives one axis, so this ${kind} gets only X. Use a D-pad.`);
  if (composite === "single" || composite === "modifier") {
    const info = m.control ? inputControlInfo(m.control) : null;
    if (info && info.dimensions > want) out.push(`${m.control} gives ${info.dimensions} axes, but this is ${kind === "axis" ? "an axis" : "a button"}: it reads only X.`);
    if (info && info.dimensions === 1 && want >= 2) out.push(`${m.control} gives one value, so this ${kind} gets only X. Use a D-pad, or a stick.`);
  }
  return out;
}

const named = (m: MappingSpec, part: string) => `${part} (${partValue(m, part) || "empty"})`;

/**
 * `m` converted for an action that changed from `from` to `to`, and what changed, in words (null when nothing
 * did). The rules are simple, and keep what still means something:
 *
 * - to a button: a D-pad keeps its up control, Axis its positive, as a single control;
 * - to an axis: a D-pad keeps left and right as Axis's negative and positive;
 * - to a vec2 or vec3: Axis becomes a D-pad with its negative and positive as left and right (up and down empty);
 * - anything else stays as it is (a single control or a chord), and any warning `unsuitedControls` gives says so.
 */
export function convertMapping(m: MappingSpec, from: ActionKind, to: ActionKind): { mapping: MappingSpec; note: string | null } {
  if (from === to) return { mapping: m, note: null };
  const composite = compositeOf(m);
  const without = (mapping: MappingSpec): Record<string, unknown> => {
    const out: Record<string, unknown> = { ...mapping };
    for (const f of PART_FIELDS) delete out[f];
    delete out.composite;
    return out;
  };
  if (to === "button" && (composite === "dpad" || composite === "axis")) {
    const keep = composite === "dpad" ? "up" : "positive";
    const dropped = COMPOSITES[composite].parts.filter((p) => p !== keep);
    return {
      mapping: { ...without(m), control: partValue(m, keep) } as unknown as MappingSpec,
      note: `${COMPOSITES[composite].label.split(" (")[0]} to a single control: kept ${named(m, keep)}, dropped ${dropped.map((p) => named(m, p)).join(", ")}.`,
    };
  }
  if (to === "axis" && composite === "dpad") {
    return {
      mapping: { ...without(m), composite: "axis", negative: partValue(m, "left"), positive: partValue(m, "right") } as unknown as MappingSpec,
      note: `D-pad to Axis: left and right became negative and positive; dropped ${named(m, "up")}, ${named(m, "down")}.`,
    };
  }
  if ((to === "vec2" || to === "vec3") && composite === "axis") {
    return {
      mapping: { ...without(m), composite: "dpad", up: "", down: "", left: partValue(m, "negative"), right: partValue(m, "positive") } as unknown as MappingSpec,
      note: "Axis to D-pad: negative and positive became left and right; up and down are empty.",
    };
  }
  return { mapping: m, note: null };
}

// --- controls ------------------------------------------------------------------------------------

/** Keys offered by name (any `KeyboardEvent.key`, lower-case, is a key; these are the common ones). */
const KEYS = [
  ..."abcdefghijklmnopqrstuvwxyz",
  ..."0123456789",
  "space", "enter", "escape", "tab", "backspace", "shift", "control", "alt", "meta",
  "arrowup", "arrowdown", "arrowleft", "arrowright",
  "f1", "f2", "f3", "f4", "f5", "f6", "f7", "f8", "f9", "f10", "f11", "f12",
  "home", "end", "pageup", "pagedown", "insert", "delete",
];

/** The controls the form offers, by device: common keys, then every named control the engine parses (`inputControlPaths`). */
export const CONTROL_GROUPS: readonly { readonly device: string; readonly controls: readonly string[] }[] = [{ device: "Keyboard", controls: KEYS.map((k) => `<Keyboard>/${k}`) }, ...inputControlPaths()];

// --- problems ------------------------------------------------------------------------------------

/** Problems by mapping index, from the evaluator's list (`inputContextProblems`). */
export function problemsByMapping(problems: readonly { mapping: number; message: string }[]): Map<number, string[]> {
  const out = new Map<number, string[]>();
  for (const p of problems) {
    let list = out.get(p.mapping);
    if (!list) out.set(p.mapping, (list = []));
    list.push(p.message);
  }
  return out;
}

/** Problems with the context as a whole: no name (it then takes its path), or no mappings. */
export function contextNotes(spec: InputContextSpec): string[] {
  const out: string[] = [];
  if (!spec.name.trim()) out.push("The context has no name, so it goes by its file's path.");
  return out;
}
