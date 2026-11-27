/**
 * The input evaluator (ADR 0336, 0337): built-in systems that turn a World's device data into its
 * players' action sets.
 *
 * - `engine.InputEvaluate` (input phase, after pairing): per player, compiles its active contexts
 *   (with the player's profile: removals, additions, overrides) into a table when they changed, then evaluates them from the highest
 *   priority down. A mapping whose triggers are active claims its controls, so lower-priority
 *   contexts don't see them; within a context a chord (Shift+B) claims its main control (B).
 *   Composites, then modifiers, then triggers give each mapping a value and a state; an action
 *   takes the largest value and the furthest state of its mappings. Phase flags and `ActionEvents`
 *   follow, and the frame's values are written to the player and its pawns (`ControlledBy`).
 * - **Dependency order.** Triggers that read other actions (`chord`, `combo`, custom triggers'
 *   `reads`) see them as they are this frame: the table orders actions in levels, an action after
 *   every action its mappings read, and each level runs the priority pass above, then settles its
 *   actions' flags. Controls claimed in a higher context stay hidden from lower contexts in later
 *   levels; a mapping can't hide controls from an action resolved in an earlier level (the action
 *   it reads, which it needs settled first). Actions that read each other in a cycle are reported
 *   once, and read the cycle's other actions as they were last frame.
 * - `engine.InputTick` (fixedUpdate, first): writes the tick's values: edges since the last tick
 *   (a press in a frame without a fixed step isn't lost), pointer deltas summed. Later ticks of the
 *   same frame see levels only.
 * - `engine.InputFrame` (update, first): writes the frame's values back for update and lateUpdate.
 */
import type { World } from "../core/World";
import { defineBuiltinSystem } from "../core/systems";
import type { DataComponentDef } from "../core/data";
import type { GameObject } from "../scene/GameObject";
import { ActionEvents, ActionPhase, EDGE_FLAGS, actionSets, type ActionEventPhase, type ActionInfo, type ActionSetDef } from "./actions";
import type { InputContextSpec, MappingSpec, ModifierSpec } from "./contextTypes";
import { DEFAULT_CONTEXT, InputContext, activeContexts, bindingsVersion, registeredContexts, resolveContext, sourcedContexts } from "./contexts";
import { PRESS_POINT, controlById, requireControl, type Control } from "./controls";
import { DeviceKind, GamepadState, InputDevice, PenState, TouchState, deviceNodes, takesLocalInput } from "./deviceEntities";
import { devices, mouseKey } from "./devices";
import { compileModifier, deadzone, type Modifier } from "./modifiers";
import { ControlledBy, InputPlayer, playerNodes } from "./players";
import { profileMappings, profileOf, type InputAccessibility, type PlayerProfile } from "./profiles";
import { combineTriggers, compileTrigger, type CompiledTrigger, type TriggerWorld } from "./triggers";

/** The stick dead zone mappings that read a stick get when they have none of their own. */
export const DEFAULT_STICK_DEADZONE = 0.15;

// --- compiled tables ---------------------------------------------------------------------------

type Source =
  | { readonly kind: "single"; readonly control: Control }
  | { readonly kind: "dpad"; readonly up: Control; readonly down: Control; readonly left: Control; readonly right: Control }
  | { readonly kind: "axis"; readonly negative: Control; readonly positive: Control }
  | { readonly kind: "modifier"; readonly modifiers: readonly Control[]; readonly control: Control };

/** One mapping, compiled for one player. */
export interface CompiledMapping {
  readonly context: string;
  /** Its index in the context's `mappings`, or, for a mapping the player's profile added, the context's mapping count plus its position among the additions. */
  readonly index: number;
  /** Its position among the profile's additions to the context, or -1 for one of the context's own. */
  readonly addition: number;
  /** The mapping as compiled: its spec with the profile's controls. */
  readonly spec: MappingSpec;
  readonly set: ActionSetDef;
  readonly action: ActionInfo;
  readonly source: Source;
  /** Every control it reads, and the ones a chord claims within its context (its main control). */
  readonly controls: readonly number[];
  readonly chordClaims: readonly number[];
  readonly modifiers: readonly Modifier[];
  readonly triggers: readonly CompiledTrigger[];
  readonly consume: boolean;
  /** It reads a delta control (pointer delta, scroll): values add up between ticks. */
  readonly additive: boolean;
}

export interface CompiledContext {
  readonly name: string;
  readonly priority: number;
  /** How many mappings the context itself has (the profile's additions are indexed after them). */
  readonly own: number;
  /** Chords first, so they claim their main control before plain mappings of it run. */
  readonly mappings: readonly CompiledMapping[];
}

/** A player's compiled bindings (prompts and rebinding read them too). */
export interface PlayerTable {
  readonly signature: string;
  /** Highest priority first. */
  readonly contexts: readonly CompiledContext[];
  /** Action-level modifiers, by `set.id:action`. */
  readonly actionModifiers: ReadonlyMap<string, readonly Modifier[]>;
  readonly problems: readonly string[];
  /** Evaluation level by `set.id:action` (absent: 0): an action comes after the actions its triggers read. */
  readonly levelOf: ReadonlyMap<string, number>;
  /** How many levels there are (at least 1). */
  readonly levels: number;
}

const actionKey = (set: ActionSetDef, a: ActionInfo) => `${set.id}:${a.name}`;

/** Find the action a mapping names: `"set.Id:action"`, or a bare name in the first set that has it. */
export function resolveAction(name: string): { set: ActionSetDef; action: ActionInfo } | null {
  const colon = name.lastIndexOf(":");
  if (colon > 0) {
    const set = actionSets().find((s) => s.id === name.slice(0, colon));
    const action = set?.actions.find((a) => a.name === name.slice(colon + 1));
    return set && action ? { set, action } : null;
  }
  for (const set of actionSets()) {
    const action = set.actions.find((a) => a.name === name);
    if (action) return { set, action };
  }
  return null;
}

/** Whether two action names (bare or `"set.Id:action"`) name the same action; names that resolve to none compare as text. */
function sameAction(a: string, b: string): boolean {
  if (a === b) return true;
  const x = resolveAction(a);
  const y = resolveAction(b);
  return !!x && !!y && x.set === y.set && x.action === y.action;
}

const isStickControl = (c: Control) => c.source.device === "gamepad" && (c.source.read === "stick" || c.source.read === "axis");

function compileMapping(spec: MappingSpec, context: string, index: number, addition: number, a11y: InputAccessibility, problems: string[]): CompiledMapping | null {
  const where = addition >= 0 ? `Input context "${context}", added mapping ${addition + 1}` : `Input context "${context}", mapping ${index + 1}`;
  const target = resolveAction(spec.action);
  if (!target) {
    problems.push(`${where}: there's no action "${spec.action}".`);
    return null;
  }
  const ctl = (part: string, path: string | undefined): Control => {
    if (!path) throw new Error(`${where}: "${part}" is missing.`);
    return requireControl(path, where);
  };
  try {
    let source: Source;
    if (spec.composite === "dpad") source = { kind: "dpad", up: ctl("up", spec.up), down: ctl("down", spec.down), left: ctl("left", spec.left), right: ctl("right", spec.right) };
    else if (spec.composite === "axis") source = { kind: "axis", negative: ctl("negative", spec.negative), positive: ctl("positive", spec.positive) };
    else if (spec.composite === "modifier") {
      const mods = typeof spec.modifier === "string" ? [spec.modifier] : [...(spec.modifier ?? [])];
      if (!mods.length) throw new Error(`${where}: a modifier composite needs a modifier.`);
      source = { kind: "modifier", modifiers: mods.map((m, i) => ctl(`modifier${i}`, m)), control: ctl("control", spec.control) };
    } else if (spec.composite !== undefined) throw new Error(`${where}: composite "${spec.composite}" isn't dpad, axis or modifier.`);
    else source = { kind: "single", control: ctl("control", spec.control) };
    const all: Control[] = source.kind === "single" ? [source.control] : source.kind === "dpad" ? [source.up, source.down, source.left, source.right] : source.kind === "axis" ? [source.negative, source.positive] : [...source.modifiers, source.control];
    const options = target.action.type.options;
    const specs: ModifierSpec[] = (spec.modifiers ?? []).filter((m) => !m.off); // a turned-off modifier is as if absent
    const stick = all.some(isStickControl);
    const override = a11y.deadzone;
    const hasDeadzone = specs.some((m) => "deadzone" in m);
    // The player's dead zone is kept inside the mapping's range, so a large one reads nearly digital
    // instead of making the mapping invalid (and dropping it).
    const within = (max: number | undefined) => Math.max(0, Math.min(override!, (max ?? 1) * 0.999));
    if (stick && !hasDeadzone) specs.unshift({ deadzone: { min: override === undefined ? DEFAULT_STICK_DEADZONE : within(1) } });
    else if (stick && override !== undefined)
      for (let i = 0; i < specs.length; i++) {
        const m = specs[i];
        if ("deadzone" in m) specs[i] = { deadzone: { ...m.deadzone, min: within(m.deadzone.max) } };
      }
    const triggerSpecs = [...(spec.triggers ?? []), ...(options.triggers ?? [])];
    return {
      context,
      index,
      addition,
      spec,
      set: target.set,
      action: target.action,
      source,
      controls: all.map((c) => c.id),
      chordClaims: source.kind === "modifier" ? [source.control.id] : [],
      modifiers: specs.map(compileModifier),
      triggers: triggerSpecs.map(compileTrigger),
      consume: spec.consume ?? options.consume ?? true,
      additive: all.some((c) => c.additive),
    };
  } catch (err) {
    problems.push(err instanceof Error ? err.message : String(err));
    return null;
  }
}

function compileContext(spec: InputContextSpec, priority: number, profile: PlayerProfile, problems: string[]): CompiledContext {
  const mappings: CompiledMapping[] = [];
  for (const m of profileMappings(spec, profile, sameAction)) {
    const c = compileMapping(m.spec, spec.name, m.index, m.addition, profile.accessibility, problems);
    if (c) mappings.push(c);
  }
  mappings.sort((a, b) => Number(b.source.kind === "modifier") - Number(a.source.kind === "modifier"));
  return { name: spec.name, priority, own: spec.mappings.length, mappings };
}

/** The contexts active for player `index`: the default one, every active InputContext that names this player, and those engine sources switch on (the UI's `ui`, ADR 0340). */
function contextsFor(world: World, index: number): { ref: string; priority: number; order: number }[] {
  const out = [{ ref: DEFAULT_CONTEXT, priority: 0, order: -1 }];
  let order = 0;
  for (const c of activeContexts(world)) {
    order++;
    if (!c.context) continue;
    if (playerOfContext(c) !== index) continue;
    out.push({ ref: c.context, priority: c.priority, order });
  }
  for (const s of sourcedContexts(world, index)) out.push({ ref: s.context, priority: s.priority, order: ++order });
  return out.sort((a, b) => b.priority - a.priority || a.order - b.order);
}

/** The player an InputContext is for: its `player`, else the player controlling its node, else 0. */
function playerOfContext(c: InputContext): number {
  if (c.player >= 0) return c.player;
  for (let n: GameObject | null = c.owner; n; n = n.parent) {
    const by = n.getData(ControlledBy);
    if (by) return by.player;
  }
  return 0;
}

const warned = new Set<string>();

function tableFor(world: World, index: number, previous: PlayerTable | undefined): PlayerTable {
  const profile = profileOf(world, index);
  const refs = contextsFor(world, index);
  const signature = `${bindingsVersion()}|${profile.version}|${refs.map((r) => `${r.ref}@${r.priority}`).join(",")}`;
  if (previous?.signature === signature) return previous;
  const problems: string[] = [];
  const contexts: CompiledContext[] = [];
  for (const r of refs) {
    const spec = resolveContext(r.ref);
    if (!spec) {
      problems.push(`Input context "${r.ref}" wasn't found: register it with defineInputContext, or name a *.input.json asset.`);
      continue;
    }
    contexts.push(compileContext(spec, r.priority, profile, problems));
  }
  const actionModifiers = new Map<string, Modifier[]>();
  for (const set of actionSets()) {
    for (const a of set.actions) {
      const specs = a.type.options.modifiers?.filter((m) => !m.off);
      if (!specs?.length) continue;
      try {
        actionModifiers.set(actionKey(set, a), specs.map(compileModifier));
      } catch (err) {
        problems.push(`${set.id}:${a.name}: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }
  const { levelOf, levels } = orderActions(contexts, problems);
  for (const p of problems) {
    if (warned.has(p)) continue;
    warned.add(p);
    console.warn(`[myco] ${p}`);
  }
  return { signature, contexts, actionModifiers, problems, levelOf, levels };
}

/**
 * Order actions so each comes after the actions its mappings' triggers read (chords, combos,
 * custom triggers). A cycle is reported, and its closing dependency is left out of the order.
 */
function orderActions(contexts: readonly CompiledContext[], problems: string[]): { levelOf: Map<string, number>; levels: number } {
  const deps = new Map<string, Set<string>>();
  for (const ctx of contexts) {
    for (const m of ctx.mappings) {
      const key = actionKey(m.set, m.action);
      for (const t of m.triggers) {
        for (const name of t.reads) {
          const target = resolveIn(m.set, name);
          if (!target) {
            problems.push(`Input context "${ctx.name}", mapping ${m.index + 1}: its ${m.action.name} trigger reads "${name}", which isn't an action.`);
            continue;
          }
          let set = deps.get(key);
          if (!set) deps.set(key, (set = new Set()));
          set.add(actionKey(target.set, target.action));
        }
      }
    }
  }
  const levelOf = new Map<string, number>();
  const visiting: string[] = [];
  const short = (key: string) => key.slice(key.lastIndexOf(":") + 1);
  const visit = (key: string): number => {
    const known = levelOf.get(key);
    if (known !== undefined) return known;
    visiting.push(key);
    let level = 0;
    for (const d of deps.get(key) ?? []) {
      const at = visiting.indexOf(d);
      if (at >= 0) {
        const cycle = [...visiting.slice(at), d].map(short).join(" → ");
        problems.push(`Input actions read each other in a cycle (${cycle}) through chord or combo triggers: "${short(key)}" reads "${short(d)}" as it was last frame.`);
        continue;
      }
      level = Math.max(level, visit(d) + 1);
    }
    visiting.pop();
    levelOf.set(key, level);
    return level;
  };
  let levels = 1;
  for (const key of deps.keys()) levels = Math.max(levels, visit(key) + 1);
  return { levelOf, levels };
}

/** @internal Every context player `index` could have active, compiled with its profile: the default context, those registered with `defineInputContext`, and those `InputContext` components in the World name for the player, active or not (rebinding checks conflicts against them). */
export function knownContexts(world: World, index: number): CompiledContext[] {
  const profile = profileOf(world, index);
  const refs = new Set<string>([DEFAULT_CONTEXT, ...registeredContexts()]);
  for (const c of world._componentsOfType(InputContext)) if (c.context && playerOfContext(c) === index) refs.add(c.context);
  const problems: string[] = [];
  const out: CompiledContext[] = [];
  for (const ref of refs) {
    const spec = resolveContext(ref);
    if (spec) out.push(compileContext(spec, 0, profile, problems));
  }
  return out;
}

// --- per-player state --------------------------------------------------------------------------

interface ActionState {
  readonly set: ActionSetDef;
  readonly action: ActionInfo;
  /** This frame's values and flags. */
  readonly frame: Float32Array;
  frameFlags: number;
  /** Edge flags since the last tick, and delta sums since the last tick. */
  pendingFlags: number;
  readonly pendingSum: Float32Array;
  additive: boolean;
  /** Last frame's trigger state (0 none, 1 ongoing, 2 triggered), whether actuated, the actuated time. */
  state: number;
  held: boolean;
  elapsed: number;
  /** It triggered since its triggers started (so stopping completes it rather than cancelling). */
  fired: boolean;
  /** holdToToggle: the latch, and whether the button was down last frame. */
  latched: boolean;
  wasDown: boolean;
  /** Repeat (accessibility): seconds since it became triggered, and when it performs next. */
  repeatTime: number;
  nextRepeat: number;
}

interface PlayerEval {
  table?: PlayerTable;
  readonly actions: Map<string, ActionState>;
  /** The last evaluation, for the editor's input debugger: the mapping that gave each action its value, and each consumed control's claiming context. */
  readonly sources: Map<ActionState, CompiledMapping>;
  readonly claims: Map<number, string>;
}

const perWorld = new WeakMap<World, Map<GameObject, PlayerEval>>();

function evalOf(world: World, player: GameObject): PlayerEval {
  let m = perWorld.get(world);
  if (!m) perWorld.set(world, (m = new Map()));
  for (const p of m.keys()) if (!p.isValid) m.delete(p);
  let e = m.get(player);
  if (!e) m.set(player, (e = { actions: new Map(), sources: new Map(), claims: new Map() }));
  return e;
}

/** @internal Player node's compiled table (for prompts and rebinding), compiled now if it's out of date. */
export function playerTable(world: World, player: GameObject): PlayerTable {
  const e = evalOf(world, player);
  return (e.table = tableFor(world, player.getData(InputPlayer)!.index, e.table));
}

/** What a player's last evaluation saw (`lastEvaluation`). */
export interface EvaluationTrace {
  /** By `set.id:action`: the mapping that gave the action its value (actions at zero have none). */
  readonly sources: ReadonlyMap<string, CompiledMapping>;
  /** Controls consumed (claimed by a performing mapping), by control path: the context that claimed each. */
  readonly consumed: ReadonlyMap<string, string>;
}

/** @internal A player node's last evaluation, for the editor's input debugger (ADR 0336); null before its first. */
export function lastEvaluation(world: World, player: GameObject): EvaluationTrace | null {
  const e = perWorld.get(world)?.get(player);
  if (!e) return null;
  return {
    sources: new Map([...e.sources].map(([s, m]) => [actionKey(s.set, s.action), m])),
    consumed: new Map([...e.claims].map(([id, ctx]) => [controlById(id).path, ctx])),
  };
}

/**
 * @internal The problems the evaluator reports for a context (unknown actions, control paths that name no control,
 * bad modifier and trigger parameters), each with its mapping's index, as the editor's context asset editor lists them.
 */
export function contextProblems(spec: InputContextSpec): { readonly mapping: number; readonly message: string }[] {
  const out: { mapping: number; message: string }[] = [];
  spec.mappings.forEach((m, i) => {
    const problems: string[] = [];
    compileMapping(m, spec.name, i, -1, {}, problems);
    for (const message of problems) out.push({ mapping: i, message });
  });
  return out;
}

function actionState(e: PlayerEval, set: ActionSetDef, action: ActionInfo): ActionState {
  const key = actionKey(set, action);
  let s = e.actions.get(key);
  if (!s) {
    s = { set, action, frame: new Float32Array(3), frameFlags: 0, pendingFlags: 0, pendingSum: new Float32Array(3), additive: false, state: 0, held: false, elapsed: 0, fired: false, latched: false, wasDown: false, repeatTime: 0, nextRepeat: 0 };
    e.actions.set(key, s);
  }
  return s;
}

// --- reading controls --------------------------------------------------------------------------

/** The devices paired with one player, by kind. */
interface Paired {
  keyboard: boolean;
  keyboardFamily: number;
  pointer: boolean;
  pointerFamily: number;
  /** The paired touchscreen's and pen's state (`TouchState`, `PenState`), or null. */
  touch: Record<string, number> | null;
  touchFamily: number;
  pen: Record<string, number> | null;
  penFamily: number;
  readonly pads: { view: Record<string, number>; family: number }[];
}

function pairedDevices(world: World, index: number, out: Paired): Paired {
  out.keyboard = out.pointer = false;
  out.touch = out.pen = null;
  out.pads.length = 0;
  for (const d of deviceNodes(world)) {
    if (!d.isValid) continue;
    const data = d.getData(InputDevice)!;
    if (data.player !== index || !data.connected) continue;
    if (data.kind === DeviceKind.keyboard) {
      out.keyboard = true;
      out.keyboardFamily = data.family;
    } else if (data.kind === DeviceKind.pointer) {
      out.pointer = true;
      out.pointerFamily = data.family;
    } else if (data.kind === DeviceKind.touch) {
      out.touch = d.getData(TouchState) as Record<string, number> | null;
      out.touchFamily = data.family;
    } else if (data.kind === DeviceKind.pen) {
      out.pen = d.getData(PenState) as Record<string, number> | null;
      out.penFamily = data.family;
    } else {
      const view = d.getData(GamepadState) as Record<string, number> | null;
      if (view) out.pads.push({ view, family: data.family });
    }
  }
  return out;
}

/** The family of the device the last `read` took its value from. */
let readFamily = 0;

/** Read `c` for a player into `out` (components; +Y up for sticks, the d-pad, deltas, scroll and pen tilt). */
function read(c: Control, paired: Paired, out: Float32Array): void {
  out[0] = out[1] = out[2] = 0;
  const s = c.source;
  if (s.device === "keyboard") {
    if (paired.keyboard && devices.isHeld(s.key)) {
      out[0] = 1;
      readFamily = paired.keyboardFamily;
    }
    return;
  }
  if (s.device === "pointer") {
    if (!paired.pointer) return;
    readFamily = paired.pointerFamily;
    if (s.read === "button") out[0] = devices.isHeld(mouseKey(s.button)) ? 1 : 0;
    else if (s.read === "delta") {
      out[0] = devices.movementX;
      out[1] = -devices.movementY;
    } else if (s.read === "scroll") {
      out[0] = devices.scrollX;
      out[1] = -devices.scrollY;
    } else {
      out[0] = devices.pointerX;
      out[1] = devices.pointerY;
    }
    return;
  }
  if (s.device === "touch") {
    const t = paired.touch;
    if (!t) return;
    switch (s.read) {
      case "press": {
        const bit = 1 << (s.slot < 0 ? 10 : s.slot);
        out[0] = (t.held | t.down) & bit ? 1 : 0;
        break;
      }
      case "position":
        out[0] = s.slot < 0 ? t.primaryX : t[`x${s.slot}`];
        out[1] = s.slot < 0 ? t.primaryY : t[`y${s.slot}`];
        break;
      case "delta":
        out[0] = t.primaryDeltaX;
        out[1] = 0 - t.primaryDeltaY; // never -0
        break;
      case "pinch":
        out[0] = t.pinch;
        break;
      case "swipe":
        out[0] = t.swipeX;
        out[1] = 0 - t.swipeY;
        break;
      case "count":
        out[0] = t.count;
        break;
    }
    readFamily = paired.touchFamily;
    return;
  }
  if (s.device === "pen") {
    const p = paired.pen;
    if (!p) return;
    switch (s.read) {
      case "button":
        out[0] = (p.held | p.down) & (1 << s.bit) ? 1 : 0;
        break;
      case "position":
        out[0] = p.x;
        out[1] = p.y;
        break;
      case "delta":
        out[0] = p.deltaX;
        out[1] = 0 - p.deltaY;
        break;
      case "tilt":
        out[0] = p.tiltX;
        out[1] = 0 - p.tiltY;
        break;
      case "pressure":
        out[0] = p.pressure;
        break;
      case "twist":
        out[0] = p.twist;
        break;
      case "inRange":
        out[0] = p.inRange;
        break;
    }
    readFamily = paired.penFamily;
    return;
  }
  // Gamepads: the paired pad with the largest reading.
  let best = -1;
  const tmp = scratchPad;
  for (const pad of paired.pads) {
    const v = pad.view;
    tmp[0] = tmp[1] = tmp[2] = 0;
    switch (s.read) {
      case "button":
        tmp[0] = padButton(v, s.index);
        break;
      case "axis":
        tmp[0] = s.index === 1 || s.index === 3 ? -v[`a${s.index}`] : v[`a${s.index}`];
        break;
      case "stick":
        tmp[0] = v[`a${s.x}`];
        tmp[1] = -v[`a${s.y}`];
        break;
      case "dpad":
        tmp[0] = padButton(v, 15) - padButton(v, 14);
        tmp[1] = padButton(v, 12) - padButton(v, 13);
        break;
      case "gyro":
        tmp[0] = v.gyroX;
        tmp[1] = v.gyroY;
        tmp[2] = v.gyroZ;
        break;
      case "accel":
        tmp[0] = v.accelX;
        tmp[1] = v.accelY;
        tmp[2] = v.accelZ;
        break;
      case "touchpad":
        tmp[0] = (v.tpHeld | v.tpDown) & (1 << s.finger) ? 1 : 0;
        break;
      case "touchpadPosition":
        // Where the finger is while it touches (and in the frame it lifts); 0, 0 otherwise, so a
        // finger that lifted doesn't keep an action actuated or outweigh another pad's.
        if ((v.tpHeld | v.tpDown | v.tpUp) & (1 << s.finger)) {
          tmp[0] = v[`tp${s.finger}X`];
          tmp[1] = v[`tp${s.finger}Y`];
        }
        break;
    }
    const m = tmp[0] * tmp[0] + tmp[1] * tmp[1] + tmp[2] * tmp[2];
    if (m > best) {
      best = m;
      out.set(tmp);
      if (m > 0) readFamily = pad.family;
    }
  }
}

/** A gamepad button's value; one pressed and released inside the frame reads fully pressed (it went down this frame, as a key tapped between frames reads held). */
function padButton(v: Record<string, number>, index: number): number {
  const bit = 1 << index;
  return v.down & bit && !(v.held & bit) ? 1 : v[`b${index}`];
}

const scratchPad = new Float32Array(3);
const part = new Float32Array(3);
const magnitude = (v: Float32Array, dims = 3) => Math.sqrt(v[0] * v[0] + (dims > 1 ? v[1] * v[1] : 0) + (dims > 2 ? v[2] * v[2] : 0));

function readSource(m: CompiledMapping, paired: Paired, consumed: ReadonlySet<number>, out: Float32Array): void {
  out[0] = out[1] = out[2] = 0;
  const one = (c: Control): number => {
    if (consumed.has(c.id)) return 0;
    read(c, paired, part);
    return c.dimensions === 1 ? part[0] : magnitude(part);
  };
  const src = m.source;
  if (src.kind === "single") {
    if (consumed.has(src.control.id)) return;
    read(src.control, paired, out);
  } else if (src.kind === "dpad") {
    out[0] = one(src.right) - one(src.left);
    out[1] = one(src.up) - one(src.down);
  } else if (src.kind === "axis") {
    out[0] = one(src.positive) - one(src.negative);
  } else {
    for (const mod of src.modifiers) if (one(mod) < PRESS_POINT) return;
    if (consumed.has(src.control.id)) return;
    read(src.control, paired, out);
  }
}

/** Shape a value to the action's kind: buttons take a vector's length, axes its X. */
function coerce(kind: ActionInfo["kind"], v: Float32Array, sourceDims: number): void {
  if (kind === "button") {
    const m = sourceDims > 1 ? magnitude(v) : Math.abs(v[0]);
    v[0] = Math.min(1, m);
    v[1] = v[2] = 0;
  } else if (kind === "axis") {
    v[1] = v[2] = 0;
  } else if (kind === "vec2") v[2] = 0;
}

function actuated(kind: ActionInfo["kind"], v: Float32Array): boolean {
  if (kind === "button") return v[0] >= PRESS_POINT;
  return magnitude(v) > 1e-4;
}

const sourceDims = (m: CompiledMapping): number => (m.source.kind === "dpad" ? 2 : m.source.kind === "axis" ? 1 : m.source.control.dimensions);

// --- evaluation --------------------------------------------------------------------------------

const PHASE_EVENTS: [number, ActionEventPhase][] = [
  [ActionPhase.started, "started"],
  [ActionPhase.performed, "performed"],
  [ActionPhase.completed, "completed"],
  [ActionPhase.canceled, "canceled"],
];

interface Accum {
  readonly value: Float32Array;
  mag: number;
  state: number;
  pulse: boolean;
  family: number;
}

const paired: Paired = { keyboard: false, keyboardFamily: 0, pointer: false, pointerFamily: 1, touch: null, touchFamily: 6, pen: null, penFamily: 7, pads: [] };
const value = new Float32Array(3);

function matches(list: readonly string[] | undefined, set: ActionSetDef, a: ActionInfo): boolean {
  return !!list?.some((n) => n === a.name || n === actionKey(set, a));
}

function evaluatePlayer(world: World, player: GameObject, dt: number): void {
  const info = player.getData(InputPlayer)!;
  const e = evalOf(world, player);
  const table = (e.table = tableFor(world, info.index, e.table));
  const profile = profileOf(world, info.index);
  pairedDevices(world, info.index, paired);

  // Other actions' flags: this frame's once their level has settled (last frame's inside a cycle).
  const others = (set: ActionSetDef): TriggerWorld => ({
    triggered: (name) => {
      const t = resolveIn(set, name);
      return !!t && (actionState(e, t.set, t.action).frameFlags & ActionPhase.triggered) !== 0;
    },
    performed: (name) => {
      const t = resolveIn(set, name);
      return !!t && (actionState(e, t.set, t.action).frameFlags & ActionPhase.performed) !== 0;
    },
  });

  const accums = new Map<ActionState, Accum>();
  const accumOf = (s: ActionState): Accum => {
    let a = accums.get(s);
    if (!a) accums.set(s, (a = { value: new Float32Array(3), mag: -1, state: 0, pulse: false, family: -1 }));
    return a;
  };
  for (const set of actionSets()) for (const a of set.actions) accumOf(actionState(e, set, a));
  const levelOf = (s: ActionState) => table.levelOf.get(actionKey(s.set, s.action)) ?? 0;

  // Controls claimed by each context (by its index in priority order), and chords' claims within it.
  const claimedAt = new Map<number, number>();
  e.sources.clear();
  e.claims.clear();
  const chordClaims = table.contexts.map(() => new Set<number>());
  for (let level = 0; level < table.levels; level++) {
    table.contexts.forEach((ctx, ci) => {
      const claimedHere: number[] = [];
      const visible = new Set(chordClaims[ci]);
      for (const [c, at] of claimedAt) if (at < ci) visible.add(c);
      for (const m of ctx.mappings) {
        const s = actionState(e, m.set, m.action);
        if (levelOf(s) !== level) continue;
        readFamily = -1;
        readSource(m, paired, visible, value);
        const family = readFamily;
        const dims = sourceDims(m);
        for (const mod of m.modifiers) mod(value, Math.max(dims, m.action.valueFields.length), dt);
        coerce(m.action.kind, value, dims);
        const act = actuated(m.action.kind, value);
        const { state, pulse } = combineTriggers(m.triggers, act, dt, others(m.set));
        const acc = accumOf(s);
        const mag = magnitude(value);
        if (mag > acc.mag) {
          acc.mag = mag;
          acc.value.set(value);
          if (mag > 0) {
            acc.family = family;
            e.sources.set(s, m);
          }
        }
        if (state > acc.state) acc.state = state;
        if (pulse) acc.pulse = true;
        if (m.additive) s.additive = true;
        if (state > 0 && m.consume) {
          for (const c of m.chordClaims) {
            visible.add(c);
            chordClaims[ci].add(c);
          }
          claimedHere.push(...m.controls);
        }
      }
      for (const c of claimedHere) {
        if (!(claimedAt.get(c)! <= ci)) claimedAt.set(c, ci);
        if (!e.claims.has(c)) e.claims.set(c, ctx.name);
      }
    });
    for (const [s, acc] of accums) if (levelOf(s) === level) settle(player, info, table, profile.accessibility, s, acc, dt);
  }
}

/** An action's frame: action modifiers and accessibility on its combined value, then its phase flags and events. */
function settle(player: GameObject, info: { lastFamily: number; index: number }, table: PlayerTable, a11y: InputAccessibility, s: ActionState, acc: Accum, dt: number): void {
  const { set, action } = s;
  const v = acc.value;
  if (acc.mag < 0) v.fill(0);
  const mods = table.actionModifiers.get(actionKey(set, action));
  if (mods) for (const mod of mods) mod(v, action.valueFields.length, dt);
  const sens = a11y.sensitivity?.[action.name] ?? a11y.sensitivity?.[actionKey(set, action)];
  if (sens !== undefined) for (let i = 0; i < 3; i++) v[i] *= sens;
  if (matches(a11y.invertY, set, action)) {
    if (action.valueFields.length > 1) v[1] = -v[1];
    else v[0] = -v[0];
  }
  let held = actuated(action.kind, v);
  let state = acc.state;
  if (action.kind === "button" && matches(a11y.holdToToggle, set, action)) {
    if (held && !s.wasDown) s.latched = !s.latched;
    s.wasDown = held;
    held = s.latched;
    v[0] = held ? 1 : 0;
    state = held ? 2 : 0;
  }
  // Repeat (accessibility): a button kept triggered performs again after `delay`, then every `interval`.
  let repeat = false;
  const rep = a11y.repeat;
  if (state === 2 && s.state !== 2) {
    s.repeatTime = 0;
    s.nextRepeat = Math.max(0, rep?.delay ?? 0);
  } else if (state === 2 && rep && action.kind === "button" && rep.interval > 0 && (!rep.actions || matches(rep.actions, set, action))) {
    s.repeatTime += dt;
    if (s.repeatTime + 1e-9 >= s.nextRepeat) {
      repeat = true;
      while (s.nextRepeat <= s.repeatTime + 1e-9) s.nextRepeat += rep.interval;
    }
  }
  let flags = 0;
  if (held) flags |= ActionPhase.held;
  if (held && !s.held) flags |= ActionPhase.pressed;
  if (!held && s.held) flags |= ActionPhase.released;
  if (s.state === 0 && state > 0) flags |= ActionPhase.started;
  if (state === 1) flags |= ActionPhase.ongoing;
  if (state === 2) flags |= ActionPhase.triggered;
  if ((state === 2 && s.state !== 2) || (state === 2 && (acc.pulse || repeat))) flags |= ActionPhase.performed;
  if (s.state > 0 && state === 0) flags |= s.fired ? ActionPhase.completed : ActionPhase.canceled;
  if (state === 2) s.fired = true;
  else if (state === 0) s.fired = false;
  s.elapsed = held ? s.elapsed + dt : 0;
  s.held = held;
  s.state = state;
  s.frame.set(v);
  s.frameFlags = flags;
  s.pendingFlags |= flags & EDGE_FLAGS;
  if (s.additive) for (let i = 0; i < 3; i++) s.pendingSum[i] += v[i];
  if ((flags & (ActionPhase.pressed | ActionPhase.performed)) !== 0 && acc.family >= 0) info.lastFamily = acc.family;
  for (const [bit, phase] of PHASE_EVENTS) {
    if (flags & bit) ActionEvents.push({ player, node: player, index: info.index, set, action: action.name, phase, value: magnitude(v, action.valueFields.length), x: v[0], y: v[1], z: v[2] });
  }
}

function resolveIn(set: ActionSetDef, name: string): { set: ActionSetDef; action: ActionInfo } | null {
  if (name.includes(":")) return resolveAction(name);
  const action = set.actions.find((a) => a.name === name);
  return action ? { set, action } : null;
}

// --- writing views -----------------------------------------------------------------------------

type Mode = "frame" | "tick";

/** Write each player's actions (frame or tick values) to the player's node and its pawns. */
function writeOut(world: World, mode: Mode): void {
  const players = playerNodes(world);
  if (!players.length) return;
  const pawnsByPlayer = new Map<number, GameObject[]>();
  for (const row of world._query([ControlledBy])) {
    const index = (row as unknown as { controlledBy: { player: number } }).controlledBy.player;
    let list = pawnsByPlayer.get(index);
    if (!list) pawnsByPlayer.set(index, (list = []));
    list.push(row.node);
  }
  for (const player of players) {
    const index = player.getData(InputPlayer)!.index;
    const e = evalOf(world, player);
    const targets = [player, ...(pawnsByPlayer.get(index) ?? [])];
    for (const s of e.actions.values()) {
      let flags = s.frameFlags;
      let v: Float32Array = s.frame;
      if (mode === "tick") {
        flags = (s.frameFlags & ~EDGE_FLAGS) | s.pendingFlags;
        s.pendingFlags = 0;
        if (s.additive) {
          tickValue.set(s.pendingSum);
          s.pendingSum.fill(0);
          v = tickValue;
        }
      }
      for (const node of targets) {
        if (!node.isValid) continue;
        let view = node.getData(s.set as unknown as DataComponentDef) as Record<string, number> | null;
        if (!view) view = node.addData(s.set as unknown as DataComponentDef) as Record<string, number>;
        const fields = s.action.valueFields;
        for (let i = 0; i < fields.length; i++) view[fields[i]] = v[i];
        view[s.action.phaseField] = flags;
        view[s.action.timeField] = s.elapsed;
      }
    }
  }
}

const tickValue = new Float32Array(3);

function evaluate(world: World, dt: number): void {
  if (!takesLocalInput(world)) return;
  for (const player of playerNodes(world)) evaluatePlayer(world, player, dt);
  writeOut(world, "frame");
}

defineBuiltinSystem({ name: "engine.InputEvaluate", phase: "input", after: ["engine.InputPairing"], run: (w, dt) => evaluate(w, dt) });
defineBuiltinSystem({
  name: "engine.InputTick",
  phase: "fixedUpdate",
  // Pinned on both sides so the order doesn't depend on which module registered first.
  after: ["engine.NetInputTick", "engine.PhysicsRestoreInterpolated", "engine.Physics3DRestoreInterpolated"],
  before: ["engine.PredictionTick", "engine.FixedUpdateScripts"],
  run: (w) => {
    if (takesLocalInput(w)) writeOut(w, "tick");
  },
});
defineBuiltinSystem({
  name: "engine.InputFrame",
  phase: "update",
  before: ["engine.UpdateScripts"],
  run: (w) => {
    if (takesLocalInput(w)) writeOut(w, "frame");
  },
});
