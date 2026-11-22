/**
 * Rebinding (ADR 0335) as data: `player.rebind("jump")` adds a `RebindRequest` to the player's node;
 * `engine.InputRebind` (input phase, before evaluation) takes the player's next press from
 * `DeviceEvents`, writes it into the player's profile as an override of that mapping's control,
 * reports conflicts with other mappings that can be active with it, and appends to `RebindResults`.
 */
import type { World } from "../core/World";
import { defineBuffer, defineComponent, i32 } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { PRESS_POINT, control, controlById, type DeviceFamily } from "./controls";
import { DeviceEvents, InputDevice } from "./deviceEntities";
import { playerTable, resolveAction, type CompiledMapping } from "./evaluate";
import { InputPlayer, familyName } from "./players";
import { overrideKey, profileOf } from "./profiles";
import { mappingFits } from "./prompts";

/** A rebind waiting for a press. `token` names it (the request's details are kept beside it). */
export const RebindRequest = defineComponent("engine.RebindRequest", { token: i32 });

export interface RebindResult {
  readonly player: GameObject;
  readonly action: string;
  /** The new control path; null when canceled. */
  readonly control: string | null;
  readonly canceled: boolean;
  /** Other mappings now using the control, as `"<context>: <action>"`. */
  readonly conflicts: readonly string[];
}

/** Rebinds finished this frame. */
export const RebindResults = defineBuffer<RebindResult>("engine.RebindResults");

export interface RebindOptions {
  /** A control that cancels instead of binding (default `<Keyboard>/escape`). */
  readonly cancel?: string;
  /** Which devices' mapping to rebind: `keyboard` (with the pointer) or `gamepad`. Default: the family the player last used. */
  readonly device?: "keyboard" | "gamepad";
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
  readonly gamepad: boolean;
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
  const gamepad = options.device ? options.device === "gamepad" : last !== "keyboard" && last !== "pointer";
  const fam: DeviceFamily = gamepad ? "generic" : "keyboard";
  let found: CompiledMapping | null = null;
  for (const ctx of playerTable(world, player).contexts) {
    if (options.context && ctx.name !== options.context) continue;
    found = ctx.mappings.find((m) => m.set === target.set && m.action === target.action && mappingFits(m, fam)) ?? null;
    if (found) break;
  }
  if (!found) throw new Error(`rebind: action "${action}" has no ${gamepad ? "gamepad" : "keyboard"} mapping${options.context ? ` in context "${options.context}"` : ""} to rebind.`);
  const composite = found.source.kind !== "single";
  const part = options.part ?? (found.source.kind === "modifier" ? "control" : composite ? "" : "control");
  if (!part) throw new Error(`rebind: action "${action}"'s mapping is a ${found.source.kind} composite; say which part to rebind (options.part).`);
  if (options.cancel && !control(options.cancel)) throw new Error(`rebind: cancel "${options.cancel}" isn't a control path.`);
  const token = nextToken++;
  const existing = player.getData(RebindRequest);
  if (existing) finish(player, existing.token, null);
  player.addData(RebindRequest, { token });
  return new Promise((resolve) => {
    pending.set(token, { action, context: found!.context, mapping: found!.index, part, cancel: control(options.cancel ?? "<Keyboard>/escape")!.path, gamepad, remaining: options.timeout ?? Infinity, resolve });
  });
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
      if ((c.source.device === "gamepad") !== p.gamepad) continue;
      const profile = profileOf(world, index);
      profile.overrides[overrideKey(p.context, p.mapping, p.part)] = c.path;
      profile.version++;
      const conflicts: string[] = [];
      for (const ctx of playerTable(world, player).contexts) {
        for (const m of ctx.mappings) {
          if (m.context === p.context && m.index === p.mapping) continue;
          if (m.controls.some((id) => controlById(id) === c)) conflicts.push(`${ctx.name}: ${m.action.name}`);
        }
      }
      finish(player, token, { control: c.path, conflicts });
      break;
    }
  }
}

defineBuiltinSystem({ name: "engine.InputRebind", phase: "input", after: ["engine.InputPairing"], before: ["engine.InputEvaluate"], run: (w, dt) => step(w, dt) });
