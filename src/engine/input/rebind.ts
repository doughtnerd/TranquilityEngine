/**
 * Rebinding (ADR 0337) as data: `player.rebind("jump")` adds a `RebindRequest` to the player's node;
 * `engine.InputRebind` (input phase, before evaluation) takes the player's next press from
 * `DeviceEvents`, writes it into the player's profile as an override of that mapping's control,
 * reports conflicts with other mappings that can be active with it (in every context the player
 * could have: the default one, those registered with `defineInputContext`, and those `InputContext`
 * components in the World name for the player, active or not), and appends to `RebindResults`.
 *
 * A chord rebind (`chord: true`, the default for a modifier composite's main control) waits for the
 * first release of a control pressed during the rebind: the chord is every control of the device
 * group then held (the shift, control, alt and meta keys held when it started too), the main control
 * the last one pressed (on the keyboard, the last that isn't one of those four), the rest its
 * modifiers. A chord whose modifier count differs from the mapping's replaces the mapping: the old
 * one is removed and the new chord added (ADR 0339).
 *
 * `add: true` makes the next press a new mapping instead (ADR 0339), and `unbindAction` removes
 * one: changes to the profile's additions and removals.
 */
import type { World } from "../core/World";
import { defineBuffer, defineComponent, i32 } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { PRESS_POINT, control, controlById, type DeviceFamily } from "./controls";
import { DeviceEvents, DeviceKind, InputDevice, deviceNodes } from "./deviceEntities";
import { devices } from "./devices";
import type { MappingSpec } from "./contextTypes";
import { DEFAULT_CONTEXT } from "./contexts";
import { knownContexts, playerTable, resolveAction, type CompiledContext, type CompiledMapping } from "./evaluate";
import { InputPlayer, familyName } from "./players";
import { modifierPart, partsOf } from "./mappingShape";
import { addMapping, profileOf, removeMapping, replaceAddition, setControls, type MappingRef } from "./profiles";
import { controlGroup, familyGroup, mappingFits, type DeviceGroup } from "./prompts";

/** A rebind waiting for a press. `token` names it (the request's details are kept beside it). */
export const RebindRequest = defineComponent("engine.RebindRequest", { token: i32 });

/**
 * Why a rebind was canceled: the player pressed the cancel control (`cancel`), it timed out
 * (`timeout`), or another rebind for the player replaced it (`replaced`).
 */
export type RebindCancelReason = "cancel" | "timeout" | "replaced";

export interface RebindResult {
  readonly player: GameObject;
  readonly action: string;
  /** The new control path (a chord's main control); null when canceled. */
  readonly control: string | null;
  readonly canceled: boolean;
  /** Why it was canceled; null when it bound. */
  readonly reason: RebindCancelReason | null;
  /** A chord rebind's controls, modifiers first (`modifier0`…) then the main control, as bound. Empty for other rebinds. */
  readonly chord: readonly string[];
  /** Other mappings now using the control, in any context the player could have active, as `"<context>: <action>"`. */
  readonly conflicts: readonly string[];
}

/** Rebinds finished this frame. */
export const RebindResults = defineBuffer<RebindResult>("engine.RebindResults");

export interface RebindOptions {
  /** A control that cancels instead of binding (default `<Keyboard>/escape`). */
  readonly cancel?: string;
  /** Which devices' mapping to rebind: `keyboard` (with the pointer), `gamepad`, `touch` or `pen`. Default: the group of the family the player last used. */
  readonly device?: DeviceGroup;
  /** For a composite: the part to rebind (`up`, `down`, `left`, `right`, `negative`, `positive`, `control`, `modifier0`…). */
  readonly part?: string;
  /**
   * Only this context's mapping (default: the first, by priority, that has the action for those
   * devices). With `add`, the context the new mapping goes into (default: the first, by priority,
   * that has a mapping of the action, else the default context).
   */
  readonly context?: string;
  /**
   * Add a mapping instead of replacing one: the next press becomes a new single-control mapping of
   * the action for the `device` group (with `chord`, the controls pressed together become a chord).
   */
  readonly add?: boolean;
  /** Give up after this many seconds (reported as canceled). Default: wait. */
  readonly timeout?: number;
  /**
   * Bind the controls pressed together: the main control and every control held with it become the
   * mapping's `control` and `modifier0`…. Default: true for a modifier composite's main control
   * (`part` unset or `control`), else false. Only for a single control or a modifier composite's
   * `control` part. A chord of a different size from the mapping's replaces the mapping (a lone key
   * for Shift+B, or Ctrl+Shift+B).
   */
  readonly chord?: boolean;
}

interface Pending {
  readonly action: string;
  readonly context: string;
  /** The mapping's index (when adding, the index the new mapping takes). */
  readonly mapping: number;
  /** The mapping replaced (null when adding), and the context's own mapping count. */
  readonly target: { readonly ref: MappingRef; readonly spec: MappingSpec } | null;
  readonly own: number;
  /** The action as an added mapping names it. */
  readonly actionName: string;
  readonly part: string;
  readonly cancel: string;
  readonly group: DeviceGroup;
  /** For a chord: the mapping's modifier count, the controls held in press order, and those pressed since it started. */
  readonly chord: { readonly modifiers: number; readonly held: string[]; readonly pressed: Set<string> } | null;
  remaining: number;
  readonly resolve: (r: RebindResult) => void;
}

const pending = new Map<number, Pending>();
let nextToken = 1;

/** The family a device group's mappings are checked against. */
const groupFamily = (group: DeviceGroup): DeviceFamily => (group === "keyboard" ? "keyboard" : group === "gamepad" ? "generic" : group);

/** A context of the player's by name: an active one, else one it could have. */
function contextNamed(world: World, player: GameObject, name: string): CompiledContext | null {
  return playerTable(world, player).contexts.find((c) => c.name === name) ?? knownContexts(world, player.getData(InputPlayer)!.index).find((c) => c.name === name) ?? null;
}

/** @internal Start a rebind for a player node; the promise resolves when it finishes. */
export function startRebind(world: World, player: GameObject, action: string, options: RebindOptions = {}): Promise<RebindResult> {
  const target = resolveAction(action);
  if (!target) throw new Error(`rebind: there's no action "${action}".`);
  const last = familyName(player.getData(InputPlayer)!.lastFamily);
  const group: DeviceGroup = options.device ?? familyGroup(last);
  const fam = groupFamily(group);
  if (options.cancel && !control(options.cancel)) throw new Error(`rebind: cancel "${options.cancel}" isn't a control path.`);
  const cancel = control(options.cancel ?? "<Keyboard>/escape")!.path;
  const index = player.getData(InputPlayer)!.index;
  const actionName = `${target.set.id}:${target.action.name}`;
  let fields: Pick<Pending, "context" | "mapping" | "target" | "own" | "part" | "chord">;
  if (options.add) {
    if (options.part !== undefined && options.part !== "control") throw new Error(`rebind: an added mapping is a single control (or a chord); there's no "${options.part}" part to add.`);
    const holder = playerTable(world, player).contexts.find((c) => c.mappings.some((m) => m.set === target.set && m.action === target.action));
    const name = options.context ?? holder?.name ?? DEFAULT_CONTEXT;
    const ctx = contextNamed(world, player, name);
    if (!ctx) throw new Error(`rebind: there's no input context "${name}" for player ${index} to add a mapping to.`);
    const mapping = ctx.own + (profileOf(world, index).additions[name]?.length ?? 0);
    const chord = options.chord ? { modifiers: 0, held: heldModifierKeys(world, index, group), pressed: new Set<string>() } : null;
    fields = { context: name, mapping, target: null, own: ctx.own, part: "control", chord };
  } else {
    let found: CompiledMapping | null = null;
    let own = 0;
    for (const ctx of playerTable(world, player).contexts) {
      if (options.context && ctx.name !== options.context) continue;
      found = ctx.mappings.find((m) => m.set === target.set && m.action === target.action && mappingFits(m, fam)) ?? null;
      own = ctx.own;
      if (found) break;
    }
    if (!found) throw new Error(`rebind: action "${action}" has no ${group} mapping${options.context ? ` in context "${options.context}"` : ""} to rebind; add one with { add: true }.`);
    const parts = partsOf(found.spec);
    const part = options.part ?? (parts.includes("control") ? "control" : "");
    if (!part) throw new Error(`rebind: action "${action}"'s mapping is a ${found.source.kind} composite; say which part to rebind (options.part).`);
    if (!parts.includes(part)) throw new Error(`rebind: action "${action}"'s ${found.source.kind} mapping has no "${part}" part; its parts are ${parts.join(", ")}.`);
    const source = found.source;
    const chordable = part === "control" && (source.kind === "single" || source.kind === "modifier");
    const chordWanted = options.chord ?? (source.kind === "modifier" && part === "control");
    if (chordWanted && !chordable) throw new Error(`rebind: a chord rebind is for a single control or a chord's main control; action "${action}"'s "${part}" part isn't one.`);
    const chord = chordWanted ? { modifiers: source.kind === "modifier" ? source.modifiers.length : 0, held: heldModifierKeys(world, index, group), pressed: new Set<string>() } : null;
    fields = { context: found.context, mapping: found.index, target: { ref: { index: found.index, addition: found.addition, action: found.spec.action }, spec: found.spec }, own, part, chord };
  }
  const token = nextToken++;
  const existing = player.getData(RebindRequest);
  if (existing) finish(player, existing.token, null, "replaced");
  player.addData(RebindRequest, { token });
  return new Promise((resolve) => {
    pending.set(token, { ...fields, action, actionName, cancel, group, remaining: options.timeout ?? Infinity, resolve });
  });
}

/** Options for `PlayerInput.unbind`. */
export interface UnbindOptions {
  /** Which devices' mapping to remove: `keyboard` (with the pointer), `gamepad`, `touch` or `pen`. */
  readonly device: DeviceGroup;
  /** Only this context's mapping (default: the first, by priority, that has the action for those devices). */
  readonly context?: string;
}

/**
 * @internal Remove a player's mapping of `action` for a device group: an added mapping is deleted,
 * one of the context's own recorded in the profile's removals. False when there's none.
 */
export function unbindAction(world: World, player: GameObject, action: string, options: UnbindOptions): boolean {
  const target = resolveAction(action);
  if (!target) throw new Error(`unbind: there's no action "${action}".`);
  if (!options?.device) throw new Error("unbind: say which devices' mapping to remove (options.device).");
  const fam = groupFamily(options.device);
  const index = player.getData(InputPlayer)!.index;
  const fits = (m: CompiledMapping) => m.set === target.set && m.action === target.action && mappingFits(m, fam);
  let found: CompiledMapping | undefined;
  for (const ctx of playerTable(world, player).contexts) {
    if (options.context && ctx.name !== options.context) continue;
    found = ctx.mappings.find(fits);
    if (found) break;
  }
  if (!found && options.context) found = knownContexts(world, index).find((c) => c.name === options.context)?.mappings.find(fits);
  if (!found) return false;
  removeMapping(profileOf(world, index), found.context, { index: found.index, addition: found.addition, action: found.spec.action });
  return true;
}

/** Keys that are only ever a chord's modifiers on their own: the main control is the last key pressed that isn't one. */
const MODIFIER_KEYS = ["shift", "control", "alt", "meta"];
const isModifierKey = (path: string) => MODIFIER_KEYS.some((k) => path === `<Keyboard>/${k}`);

/** The shift, control, alt and meta keys a player holds as a keyboard chord rebind starts (a modifier held before clicking counts). */
function heldModifierKeys(world: World, index: number, group: DeviceGroup): string[] {
  if (group !== "keyboard") return [];
  const paired = [...deviceNodes(world)].some((d) => d.isValid && d.getData(InputDevice)!.kind === DeviceKind.keyboard && d.getData(InputDevice)!.player === index);
  return paired ? MODIFIER_KEYS.filter((k) => devices.isHeld(k)).map((k) => `<Keyboard>/${k}`) : [];
}

/** A rebind in progress, as the editor's input debugger shows it. */
export interface PendingRebind {
  readonly action: string;
  /** The context and mapping index whose control it replaces (when adding, the index the new mapping takes), and the part (`control`, `up`, `modifier0`…). */
  readonly context: string;
  readonly mapping: number;
  readonly part: string;
  /** Whether it adds a mapping rather than replacing a control. */
  readonly add: boolean;
  /** Whether it waits for a chord (the controls pressed together). */
  readonly chord: boolean;
  /** The devices it listens to. */
  readonly device: DeviceGroup;
  /** The control that cancels it. */
  readonly cancel: string;
  /** Seconds before it gives up (Infinity: it waits). */
  readonly remaining: number;
}

/** @internal The rebind a player node is waiting on, or null (the editor's input debugger). */
export function pendingRebind(player: GameObject): PendingRebind | null {
  const token = player.isValid ? player.getData(RebindRequest)?.token : undefined;
  const p = token === undefined ? undefined : pending.get(token);
  return p ? { action: p.action, context: p.context, mapping: p.mapping, part: p.part, add: p.target === null, chord: p.chord !== null, device: p.group, cancel: p.cancel, remaining: p.remaining } : null;
}

function finish(player: GameObject, token: number, chosen: { control: string; conflicts: string[] } | null, reason: RebindCancelReason | null, chord: readonly string[] = []): void {
  const p = pending.get(token);
  pending.delete(token);
  if (player.isValid && player.getData(RebindRequest)?.token === token) player.removeData(RebindRequest);
  if (!p) return;
  const result: RebindResult = {
    player,
    action: p.action,
    control: chosen?.control ?? null,
    canceled: !chosen,
    reason: chosen ? null : reason,
    chord,
    conflicts: chosen?.conflicts ?? [],
  };
  RebindResults.push(result);
  p.resolve(result);
}

/** A new mapping of `action` for the controls, keeping the modifiers, triggers and consume setting of the mapping it replaces. */
function mappingOf(action: string, main: string, modifiers: readonly string[], base: MappingSpec | null): MappingSpec {
  return {
    action,
    ...(base?.modifiers && { modifiers: structuredClone(base.modifiers) }),
    ...(base?.triggers && { triggers: structuredClone(base.triggers) }),
    ...(base?.consume !== undefined && { consume: base.consume }),
    ...(modifiers.length ? { composite: "modifier" as const, modifier: [...modifiers] } : {}),
    control: main,
  };
}

/** Write the controls into the player's profile and finish with the conflicts they make. */
function bind(world: World, player: GameObject, token: number, p: Pending, index: number, main: string, modifiers: readonly string[]): void {
  const profile = profileOf(world, index);
  let mapping = p.mapping;
  if (!p.target) mapping = addMapping(profile, p.context, p.own, mappingOf(p.actionName, main, modifiers, null));
  else if (p.chord && modifiers.length !== p.chord.modifiers) {
    // A chord of another size changes the mapping's shape, so the mapping is replaced (an added one in place).
    const spec = mappingOf(p.target.spec.action, main, modifiers, p.target.spec);
    if (p.target.ref.addition >= 0) replaceAddition(profile, p.context, p.target.ref, spec);
    else {
      removeMapping(profile, p.context, p.target.ref);
      mapping = addMapping(profile, p.context, p.own, spec);
    }
  } else {
    const parts: Record<string, string> = { [p.part]: main };
    modifiers.forEach((m, i) => (parts[modifierPart(i)] = m));
    setControls(profile, p.context, p.target.ref, parts);
  }
  // Every context the player could have active, not only today's: a vehicle's context counts while on foot.
  // A chord with modifiers conflicts with a mapping of the same controls (not with a plain key's
  // mapping: the chord claims its key); a single control with any mapping that reads it.
  const mainControl = control(main)!;
  const chordIds = [...modifiers, main].map((path) => control(path)!.id).sort((a, b) => a - b);
  const conflicts: string[] = [];
  for (const ctx of knownContexts(world, index)) {
    for (const m of ctx.mappings) {
      if (m.context === p.context && m.index === mapping) continue;
      const conflict = `${ctx.name}: ${m.action.name}`;
      const clash = modifiers.length
        ? m.controls.length === chordIds.length && [...m.controls].sort((a, b) => a - b).every((id, i) => id === chordIds[i])
        : m.controls.some((id) => controlById(id) === mainControl);
      if (clash && !conflicts.includes(conflict)) conflicts.push(conflict);
    }
  }
  finish(player, token, { control: main, conflicts }, null, p.chord ? [...modifiers, main] : []);
}

/** A chord rebind's step for one device event: true when it finished. */
function chordEvent(world: World, player: GameObject, token: number, p: Pending, index: number, path: string, down: boolean): boolean {
  const chord = p.chord!;
  const at = chord.held.indexOf(path);
  if (down) {
    if (at >= 0) chord.held.splice(at, 1);
    chord.held.push(path);
    chord.pressed.add(path);
    return false;
  }
  // The first release of a control pressed during the rebind ends it (not of one already down, like the Enter that started it).
  if (at < 0 || !chord.pressed.has(path)) {
    if (at >= 0) chord.held.splice(at, 1);
    return false;
  }
  const held = chord.held;
  let mainAt = -1;
  for (let i = held.length - 1; i >= 0 && mainAt < 0; i--) if (!isModifierKey(held[i])) mainAt = i;
  if (mainAt < 0) mainAt = held.length - 1;
  const main = held[mainAt];
  bind(world, player, token, p, index, main, held.filter((_, i) => i !== mainAt));
  return true;
}

function step(world: World, dt: number): void {
  for (const row of world._query([RebindRequest, InputPlayer])) {
    const player = row.node;
    const token = player.getData(RebindRequest)!.token;
    const p = pending.get(token);
    if (!p) {
      player.removeData(RebindRequest);
      continue;
    }
    p.remaining -= dt;
    if (p.remaining <= 0) {
      finish(player, token, null, "timeout");
      continue;
    }
    const index = player.getData(InputPlayer)!.index;
    for (const e of DeviceEvents.read()) {
      if (e.device.getData(InputDevice)?.player !== index) continue;
      const c = control(e.control);
      if (!c) continue;
      const down = Math.abs(e.value) >= PRESS_POINT;
      if (down && c.path === p.cancel) {
        finish(player, token, null, "cancel");
        break;
      }
      if (controlGroup(c) !== p.group) continue;
      if (p.chord) {
        if (!c.additive && chordEvent(world, player, token, p, index, c.path, down)) break;
        continue;
      }
      if (!down) continue;
      bind(world, player, token, p, index, c.path, []);
      break;
    }
  }
}

defineBuiltinSystem({ name: "engine.InputRebind", phase: "input", after: ["engine.InputPairing"], before: ["engine.InputEvaluate"], run: (w, dt) => step(w, dt) });
