/**
 * Rebinding (ADR 0337) as data: `player.rebind("jump")` adds a `RebindRequest` to the player's node;
 * `engine.InputRebind` (input phase, before evaluation) takes the player's next press from
 * `DeviceEvents`, writes it into the player's profile as an override of that mapping's control,
 * reports conflicts with other mappings that can be active with it (in every context the player
 * could have: the default one, those registered with `defineInputContext`, and those `InputContext`
 * components in the World name for the player, active or not), and appends to `RebindResults`.
 */
import type { World } from "../core/World";
import { defineBuffer, defineComponent, i32 } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { PRESS_POINT, control, controlById, type DeviceFamily } from "./controls";
import { DeviceEvents, InputDevice } from "./deviceEntities";
import { knownContexts, playerTable, resolveAction, type CompiledMapping } from "./evaluate";
import { InputPlayer, familyName } from "./players";
import { overrideKey, profileOf } from "./profiles";
import { controlGroup, familyGroup, mappingFits, type DeviceGroup } from "./prompts";

/** A rebind waiting for a press. `token` names it (the request's details are kept beside it). */
export const RebindRequest = defineComponent("engine.RebindRequest", { token: i32 });

export interface RebindResult {
  readonly player: GameObject;
  readonly action: string;
  /** The new control path; null when canceled. */
  readonly control: string | null;
  readonly canceled: boolean;
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
  /** Only this context's mapping (default: the first, by priority, that has the action for those devices). */
  readonly context?: string;
  /** Give up after this many seconds (reported as canceled). Default: wait. */
  readonly timeout?: number;
}

interface Pending {
  readonly action: string;
  readonly context: string;
  readonly mapping: number;
  readonly part: string;
  readonly cancel: string;
  readonly group: DeviceGroup;
  remaining: number;
  readonly resolve: (r: RebindResult) => void;
}

const pending = new Map<number, Pending>();
let nextToken = 1;

/** @internal Start a rebind for a player node; the promise resolves when it finishes. */
export function startRebind(world: World, player: GameObject, action: string, options: RebindOptions = {}): Promise<RebindResult> {
  const target = resolveAction(action);
  if (!target) throw new Error(`rebind: there's no action "${action}".`);
  const last = familyName(player.getData(InputPlayer)!.lastFamily);
  const group: DeviceGroup = options.device ?? familyGroup(last);
  const fam: DeviceFamily = group === "keyboard" ? "keyboard" : group === "gamepad" ? "generic" : group;
  let found: CompiledMapping | null = null;
  for (const ctx of playerTable(world, player).contexts) {
    if (options.context && ctx.name !== options.context) continue;
    found = ctx.mappings.find((m) => m.set === target.set && m.action === target.action && mappingFits(m, fam)) ?? null;
    if (found) break;
  }
  if (!found) throw new Error(`rebind: action "${action}" has no ${group} mapping${options.context ? ` in context "${options.context}"` : ""} to rebind.`);
  const composite = found.source.kind !== "single";
  const part = options.part ?? (found.source.kind === "modifier" ? "control" : composite ? "" : "control");
  if (!part) throw new Error(`rebind: action "${action}"'s mapping is a ${found.source.kind} composite; say which part to rebind (options.part).`);
  if (options.cancel && !control(options.cancel)) throw new Error(`rebind: cancel "${options.cancel}" isn't a control path.`);
  const token = nextToken++;
  const existing = player.getData(RebindRequest);
  if (existing) finish(player, existing.token, null);
  player.addData(RebindRequest, { token });
  return new Promise((resolve) => {
    pending.set(token, { action, context: found!.context, mapping: found!.index, part, cancel: control(options.cancel ?? "<Keyboard>/escape")!.path, group, remaining: options.timeout ?? Infinity, resolve });
  });
}

/** A rebind in progress, as the editor's input debugger shows it. */
export interface PendingRebind {
  readonly action: string;
  /** The context and mapping index whose control it replaces, and the part (`control`, `up`, `modifier0`…). */
  readonly context: string;
  readonly mapping: number;
  readonly part: string;
  /** The devices it listens to. */
  readonly device: "keyboard" | "gamepad";
  /** The control that cancels it. */
  readonly cancel: string;
  /** Seconds before it gives up (Infinity: it waits). */
  readonly remaining: number;
}

/** @internal The rebind a player node is waiting on, or null (the editor's input debugger). */
export function pendingRebind(player: GameObject): PendingRebind | null {
  const token = player.isValid ? player.getData(RebindRequest)?.token : undefined;
  const p = token === undefined ? undefined : pending.get(token);
  return p ? { action: p.action, context: p.context, mapping: p.mapping, part: p.part, device: p.gamepad ? "gamepad" : "keyboard", cancel: p.cancel, remaining: p.remaining } : null;
}

function finish(player: GameObject, token: number, chosen: { control: string; conflicts: string[] } | null): void {
  const p = pending.get(token);
  pending.delete(token);
  if (player.isValid && player.getData(RebindRequest)?.token === token) player.removeData(RebindRequest);
  if (!p) return;
  const result: RebindResult = { player, action: p.action, control: chosen?.control ?? null, canceled: !chosen, conflicts: chosen?.conflicts ?? [] };
  RebindResults.push(result);
  p.resolve(result);
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
      finish(player, token, null);
      continue;
    }
    const index = player.getData(InputPlayer)!.index;
    for (const e of DeviceEvents.read()) {
      if (Math.abs(e.value) < PRESS_POINT) continue;
      if (e.device.getData(InputDevice)?.player !== index) continue;
      const c = control(e.control);
      if (!c) continue;
      if (c.path === p.cancel) {
        finish(player, token, null);
        break;
      }
      if (controlGroup(c) !== p.group) continue;
      const profile = profileOf(world, index);
      profile.overrides[overrideKey(p.context, p.mapping, p.part)] = c.path;
      profile.version++;
      // Every context the player could have active, not only today's: a vehicle's context counts while on foot.
      const conflicts: string[] = [];
      for (const ctx of knownContexts(world, index)) {
        for (const m of ctx.mappings) {
          if (m.context === p.context && m.index === p.mapping) continue;
          const conflict = `${ctx.name}: ${m.action.name}`;
          if (m.controls.some((id) => controlById(id) === c) && !conflicts.includes(conflict)) conflicts.push(conflict);
        }
      }
      finish(player, token, { control: c.path, conflicts });
      break;
    }
  }
}

defineBuiltinSystem({ name: "engine.InputRebind", phase: "input", after: ["engine.InputPairing"], before: ["engine.InputEvaluate"], run: (w, dt) => step(w, dt) });
