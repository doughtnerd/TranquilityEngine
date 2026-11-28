/**
 * Input actions (ADR 0336): an action set is a data component declared in code, one row per player
 * (and per pawn, ADR 0337), stored in typed arrays like any other (ADR 0017).
 *
 * ```ts
 * export const PlayerActions = defineActions("game.PlayerActions", {
 *   move: vec2(dpad("<Keyboard>/w", "<Keyboard>/s", "<Keyboard>/a", "<Keyboard>/d"), "<Gamepad>/leftStick"),
 *   jump: button("<Keyboard>/space", "<Gamepad>/buttonSouth"),
 * });
 * ```
 *
 * Each action expands to fields: its value (`jump`, or `move$x`, `move$y`), its phase flags
 * (`jump$phase`, `ActionPhase` bits) and the time it has been actuated (`jump$time`, seconds). The
 * row's view reads them by action name: `actions.value("jump")`, `actions.performed("jump")`.
 *
 * The values are phase-correct: the input phase writes this frame's; each fixed step's first
 * system writes the tick's (edges since the last tick, pointer deltas summed), and the update
 * phase gets the frame's back (`evaluate.ts`). So `performed("jump")` read in `fixedUpdate` is
 * true in exactly one tick, and read in `update` in exactly one frame.
 */
import { Vector2, Vector3 } from "../core/math";
import { _onComponentUndefined, _redefineComponent, defineBuffer, defineComponent, f32, i32, type DataComponentDef, type DataView, type Schema } from "../core/data";
import type { GameObject } from "../scene/GameObject";
import type { ModifierSpec, TriggerSpec, MappingSpec } from "./contextTypes";

export type ActionKind = "button" | "axis" | "vec2" | "vec3";

/** Phase flags (`<action>$phase`). */
export const ActionPhase = {
  /** Actuated: a button past the press point, an axis or vector not zero. */
  held: 1,
  /** Became actuated this frame (tick). */
  pressed: 2,
  /** Stopped being actuated this frame (tick). */
  released: 4,
  /** Its triggers started (None → Ongoing or Triggered). */
  started: 8,
  /** Its triggers are part-way (a hold not long enough yet, a combo half done). */
  ongoing: 16,
  /** Its triggers are satisfied (level). */
  triggered: 32,
  /** It became triggered this frame (tick), or a pulse fired. */
  performed: 64,
  /** It stopped being triggered. */
  completed: 128,
  /** It stopped while ongoing, without triggering. */
  canceled: 256,
} as const;

export type ActionPhaseName = keyof typeof ActionPhase;

/** Edge flags: they last one frame (or one tick) and add up between ticks. */
export const EDGE_FLAGS = ActionPhase.pressed | ActionPhase.released | ActionPhase.started | ActionPhase.performed | ActionPhase.completed | ActionPhase.canceled;

/** A default mapping given inline: a control path, or a mapping without its action. */
export type BindingSpec = string | Omit<MappingSpec, "action">;

/** Action-level options: modifiers and triggers applied after every mapping's, and consumption. */
export interface ActionOptions {
  readonly modifiers?: readonly ModifierSpec[];
  readonly triggers?: readonly TriggerSpec[];
  /** A performing mapping hides its controls from lower-priority contexts (default true). */
  readonly consume?: boolean;
}

export interface ActionType<K extends ActionKind = ActionKind> {
  readonly kind: K;
  /** Default controls: they form the project's default context (ADR 0336). */
  readonly defaults: readonly BindingSpec[];
  readonly options: ActionOptions;
}

export type ActionFactory<K extends ActionKind> = ActionType<K> & ((...defaults: (BindingSpec | ActionOptions)[]) => ActionType<K>);

function factory<K extends ActionKind>(kind: K): ActionFactory<K> {
  const make = (...args: (BindingSpec | ActionOptions)[]): ActionType<K> => {
    const defaults: BindingSpec[] = [];
    let options: ActionOptions = {};
    for (const a of args) {
      if (typeof a === "string" || "control" in a || "composite" in a) defaults.push(a as BindingSpec);
      else options = { ...options, ...(a as ActionOptions) };
    }
    return { kind, defaults, options };
  };
  return Object.assign(make, { kind, defaults: [] as readonly BindingSpec[], options: {} as ActionOptions }) as ActionFactory<K>;
}

/** A button action: value 0..1, actuated past the press point (0.5). `button("<Keyboard>/space", "<Gamepad>/buttonSouth")`. */
export const button = factory("button");
/** A one-dimensional action: value -1..1 (`axis(axisOf("<Keyboard>/a", "<Keyboard>/d"), "<Gamepad>/leftStickX")`). */
export const axis = factory("axis");
/** A two-dimensional action (+Y up): sticks, the d-pad, WASD, pointer delta. */
export const vec2 = factory("vec2");
/** A three-dimensional action: gyro, accelerometer, or three axes. */
export const vec3 = factory("vec3");

/** Composite: four buttons to a `vec2` (+Y up). */
export function dpad(up: string, down: string, left: string, right: string, rest: Omit<MappingSpec, "action" | "composite"> = {}): Omit<MappingSpec, "action"> {
  return { ...rest, composite: "dpad", up, down, left, right };
}

/** Composite: two buttons to an `axis` (negative, positive). */
export function axisOf(negative: string, positive: string, rest: Omit<MappingSpec, "action" | "composite"> = {}): Omit<MappingSpec, "action"> {
  return { ...rest, composite: "axis", negative, positive };
}

/** Composite: a control that counts only while `modifier` (or every one of several) is held: Shift+B. */
export function chordOf(modifier: string | readonly string[], control: string, rest: Omit<MappingSpec, "action" | "composite"> = {}): Omit<MappingSpec, "action"> {
  return { ...rest, composite: "modifier", modifier, control };
}

export type ActionSpec = Record<string, ActionType>;

/** The fields an action set's component has. */
type FieldsOf<Spec extends ActionSpec> = {
  [K in keyof Spec & string as Spec[K]["kind"] extends "vec2" | "vec3" ? never : K]: typeof f32;
} & {
  [K in keyof Spec & string as Spec[K]["kind"] extends "vec2" | "vec3" ? `${K}$x` | `${K}$y` : never]: typeof f32;
} & {
  [K in keyof Spec & string as Spec[K]["kind"] extends "vec3" ? `${K}$z` : never]: typeof f32;
} & {
  [K in keyof Spec & string as `${K}$phase`]: typeof i32;
} & {
  [K in keyof Spec & string as `${K}$time`]: typeof f32;
};

/** Reading an action set's row by action name. */
export interface ActionReader<Name extends string = string> {
  /** A button's or axis's value; a vector's length. */
  value(action: Name): number;
  /** A `vec2` action's value (+Y up). `out` is filled and returned when given. */
  vector2(action: Name, out?: Vector2): Vector2;
  vector3(action: Name, out?: Vector3): Vector3;
  /** The phase flags (`ActionPhase` bits). */
  phase(action: Name): number;
  /** Seconds the action has been actuated (hold progress, charge). */
  elapsed(action: Name): number;
  held(action: Name): boolean;
  pressed(action: Name): boolean;
  released(action: Name): boolean;
  started(action: Name): boolean;
  ongoing(action: Name): boolean;
  triggered(action: Name): boolean;
  performed(action: Name): boolean;
  completed(action: Name): boolean;
  canceled(action: Name): boolean;
}

export type ActionSetView<Spec extends ActionSpec> = DataView<FieldsOf<Spec>> & ActionReader<keyof Spec & string>;

/** One action of a set, as the evaluator sees it. */
export interface ActionInfo {
  readonly name: string;
  readonly kind: ActionKind;
  readonly index: number;
  /** Its value fields: 1 (button, axis), 2 or 3. */
  readonly valueFields: readonly string[];
  readonly phaseField: string;
  readonly timeField: string;
  readonly type: ActionType;
}

export interface ActionSetOptions {
  /**
   * Networked (ADR 0337): the set is also an input stream (`defineInput`) with the same id and
   * fields, so a server reads each client's actions in the same component on its pawn.
   */
  readonly networked?: boolean;
  /** Networked sets: per-action wire encoding, e.g. `{ move: { quantize: 1 / 127 } }` (applied at the source). */
  readonly encoding?: Partial<Record<string, { readonly quantize?: number }>>;
  /** Networked sets: past ticks resent with each packet (`defineInput`'s `redundancy`). */
  readonly redundancy?: number;
  /** The property name in system rows; default the id's last part, camel-cased (`game.PlayerActions` → `playerActions`). */
  readonly key?: string;
}

export interface ActionSetDef<Spec extends ActionSpec = ActionSpec> extends DataComponentDef<FieldsOf<Spec> & Schema> {
  readonly actions: readonly ActionInfo[];
  readonly options: ActionSetOptions;
  /** @internal */ readonly _actionSet: true;
}

const sets = new Map<string, ActionSetDef>();
/** Where each set came from: `defineActions` in code, or an `*.actions.json` asset (ADR 0433). */
export type ActionSetSource = "code" | "asset";
const sources = new Map<string, ActionSetSource>();
/** Ids both code and an asset defined (ADR 0433): the editor shows the clash on both entries. */
const clashes = new Set<string>();
/** Bumped whenever an action set is (re)defined, so compiled tables rebuild. */
let setsVersion = 0;

/** @internal Every defined action set, in definition order. */
export function actionSets(): readonly ActionSetDef[] {
  return [...sets.values()];
}

/** @internal */
export function actionSetsVersion(): number {
  return setsVersion;
}

// A script's set goes with its data component (the editor unregisters a deleted script's, or the
// old project's, ADR 0030), so a leftover set can't keep winning bare action names.
_onComponentUndefined((id, restored) => {
  if (!sets.has(id)) return;
  if (restored && isActionSet(restored)) {
    sets.set(id, restored);
    sources.set(id, "code");
  } else {
    sets.delete(id);
    sources.delete(id);
  }
  setsVersion++;
});

/** Listeners told when a networked set is defined (the net bridge defines its stream). */
const definedListeners: ((def: ActionSetDef) => void)[] = [];

/** @internal The set `id` and where it came from, or undefined. */
export function actionSetSource(id: string): { readonly def: ActionSetDef; readonly source: ActionSetSource } | undefined {
  const def = sets.get(id);
  return def ? { def, source: sources.get(id) ?? "code" } : undefined;
}

/** @internal The ids both a script and an asset defined this session (ADR 0433); the asset's set is the one used. */
export function actionSetClashes(): ReadonlySet<string> {
  return clashes;
}

/** @internal */
export function onActionSetDefined(listener: (def: ActionSetDef) => void): void {
  definedListeners.push(listener);
  for (const def of sets.values()) listener(def);
}

const NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Declare an action set: a data component with one value, phase and time per action (ADR 0336).
 * Players get every defined set; pawns get their player's (ADR 0337).
 */
export function defineActions<Spec extends ActionSpec>(id: string, spec: Spec, options: ActionSetOptions = {}): ActionSetDef<Spec> {
  return _defineActionSet(id, spec, options, "code");
}

/**
 * @internal `defineActions`, saying where the set comes from. An id an asset and code both define is the asset's
 * (ADR 0433: it's what the editor shows): code defining it gets the asset's set back, with a warning; an asset
 * defining a code set's id replaces it, with a warning. An asset defining its own id again replaces it (its file changed).
 */
export function _defineActionSet<Spec extends ActionSpec>(id: string, spec: Spec, options: ActionSetOptions, source: ActionSetSource): ActionSetDef<Spec> {
  const before = sources.get(id);
  if (before === "asset" && source === "code") {
    clashes.add(id);
    console.warn(`[myco] defineActions("${id}"): an action set asset defines "${id}" too; the asset's set is used. Delete one of them.`);
    return sets.get(id) as unknown as ActionSetDef<Spec>;
  }
  if (before === "code" && source === "asset") clashes.add(id);
  if (before === "code" && source === "asset") console.warn(`[myco] An action set asset defines "${id}", which a script defines with defineActions too; the asset's set is used. Delete one of them.`);
  const schema: Schema = {};
  const actions: ActionInfo[] = [];
  for (const [name, type] of Object.entries(spec)) {
    if (!NAME.test(name)) throw new Error(`defineActions("${id}"): action "${name}" needs a name of letters, digits and underscores.`);
    if (!type || !["button", "axis", "vec2", "vec3"].includes(type.kind)) throw new Error(`defineActions("${id}"): action "${name}" must be button, axis, vec2 or vec3 (got ${JSON.stringify(type)}).`);
    const valueFields = type.kind === "vec2" ? [`${name}$x`, `${name}$y`] : type.kind === "vec3" ? [`${name}$x`, `${name}$y`, `${name}$z`] : [name];
    for (const f of valueFields) schema[f] = f32;
    schema[`${name}$phase`] = i32;
    schema[`${name}$time`] = f32;
    actions.push({ name, kind: type.kind, index: actions.length, valueFields, phaseField: `${name}$phase`, timeField: `${name}$time`, type });
  }
  const keyed = options.key ? { key: options.key } : {};
  const base = before !== undefined && source === "asset" ? _redefineComponent(id, schema, keyed) : defineComponent(id, schema, keyed);
  const byName = new Map(actions.map((a) => [a.name, a]));
  const info = (action: string): ActionInfo => {
    const a = byName.get(action);
    if (!a) throw new Error(`${id}: there's no action "${action}" (actions: ${[...byName.keys()].join(", ")}).`);
    return a;
  };
  const proto = base.viewProto as Record<string, unknown>;
  type V = Record<string, number>;
  const flag = (bit: number) =>
    function (this: V, action: string): boolean {
      return (this[info(action).phaseField] & bit) !== 0;
    };
  Object.assign(proto, {
    value(this: V, action: string) {
      const a = info(action);
      if (a.valueFields.length === 1) return this[a.valueFields[0]];
      let sum = 0;
      for (const f of a.valueFields) sum += this[f] * this[f];
      return Math.sqrt(sum);
    },
    vector2(this: V, action: string, out = new Vector2()) {
      const a = info(action);
      return out.set(this[a.valueFields[0]], this[a.valueFields[1]] ?? 0);
    },
    vector3(this: V, action: string, out = new Vector3()) {
      const a = info(action);
      return out.set(this[a.valueFields[0]], this[a.valueFields[1]] ?? 0, this[a.valueFields[2]] ?? 0);
    },
    phase(this: V, action: string) {
      return this[info(action).phaseField];
    },
    elapsed(this: V, action: string) {
      return this[info(action).timeField];
    },
    held: flag(ActionPhase.held),
    pressed: flag(ActionPhase.pressed),
    released: flag(ActionPhase.released),
    started: flag(ActionPhase.started),
    ongoing: flag(ActionPhase.ongoing),
    triggered: flag(ActionPhase.triggered),
    performed: flag(ActionPhase.performed),
    completed: flag(ActionPhase.completed),
    canceled: flag(ActionPhase.canceled),
  });
  // The methods aren't data: keep them out of `Object.keys(view)` (inspectors list the fields).
  for (const m of ["value", "vector2", "vector3", "phase", "elapsed", ...Object.keys(ActionPhase)]) Object.defineProperty(proto, m, { enumerable: false });
  const def = Object.assign(base, { actions, options, _actionSet: true as const }) as unknown as ActionSetDef<Spec>;
  sets.set(id, def as unknown as ActionSetDef);
  sources.set(id, source);
  setsVersion++;
  for (const listener of definedListeners) listener(def as unknown as ActionSetDef);
  return def;
}

/** @internal True for an action set's component definition. */
export function isActionSet(def: DataComponentDef): def is ActionSetDef {
  return (def as Partial<ActionSetDef>)._actionSet === true;
}

/** The phases `on` can listen for, and `ActionEvents` records. */
export type ActionEventPhase = "started" | "performed" | "completed" | "canceled";

/**
 * One action phase change this frame (`ActionEvents`): a local player's, from the evaluator, or a
 * networked pawn's, derived from the tick's phase flags when a server writes a client's actions
 * onto it (ADR 0337).
 */
export interface ActionEvent {
  /** The local player's node; for a pawn a network server drives, the owning connection's node (`net.Connection`). */
  readonly player: GameObject;
  /** The node whose action set changed: the local player's node, or the server's pawn. */
  readonly node: GameObject;
  /** The local player's index (on a server, the index of the client's local player driving the pawn). */
  readonly index: number;
  readonly set: ActionSetDef;
  readonly action: string;
  readonly phase: ActionEventPhase;
  /** The action's value then (a vector's length; `x`, `y`, `z` hold its components). */
  readonly value: number;
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

/** This frame's action phase changes, appended by the input phase (cleared at end of frame). */
export const ActionEvents = defineBuffer<ActionEvent>("engine.ActionEvents");

/** @internal The action set's view on `node`, or null. */
export function actionView<Spec extends ActionSpec>(node: GameObject, def: ActionSetDef<Spec>): ActionSetView<Spec> | null {
  return node.getData(def as unknown as DataComponentDef) as ActionSetView<Spec> | null;
}
