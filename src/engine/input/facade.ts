/**
 * The scripting face of input (ADR 0336, 0337): `this.input` in a behavior, `InputPlayers` for
 * players. Both read and write the ECS data the input systems keep: action-set components on
 * player and pawn nodes, `InputDevice` pairings, `RebindRequest`s, `ActionEvents`.
 */
import { Vector2, Vector3 } from "../core/math";
import { World } from "../core/World";
import { _setInputFacade, type GameBehavior } from "../core/Component";
import type { DataComponentDef } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import { Storage } from "../platform/Storage";
import type { GameObject } from "../scene/GameObject";
import { ActionEvents, actionSets, type ActionEvent, type ActionEventPhase, type ActionInfo, type ActionSetDef } from "./actions";
import type { DeviceFamily } from "./controls";
import { DeviceKind, InputDevice, deviceNodes } from "./deviceEntities";
import { devices } from "./devices";
import { resolveAction } from "./evaluate";
import { ControlledBy, InputPlayer, createPlayer, familyName, playerNode, playerNodes, removePlayer } from "./players";
import { profileOf, type InputAccessibility, type InputProfileData } from "./profiles";
import { promptFor, type InputPrompt } from "./prompts";
import { startRebind, type RebindOptions, type RebindResult } from "./rebind";
import type { TriggerEffect } from "./triggerEffects";

interface Subscription {
  readonly owner: GameBehavior | null;
  readonly player: GameObject | null;
  /** The node the subscriber reads actions on (its pawn, or the player's node). */
  readonly reader: GameObject | null;
  readonly set: ActionSetDef;
  readonly action: string;
  readonly phase: ActionEventPhase;
  readonly fn: (e: ActionEvent) => void;
}

const subscriptions = new WeakMap<World, Set<Subscription>>();

function find(action: string, reader: GameObject | null): { set: ActionSetDef; action: ActionInfo; view: Record<string, number> | null } {
  const colon = action.lastIndexOf(":");
  if (colon <= 0 && reader?.isValid) {
    // A bare name: the first set on the node that has it.
    for (const set of actionSets()) {
      const a = set.actions.find((x) => x.name === action);
      if (!a) continue;
      const view = reader.getData(set as unknown as DataComponentDef) as Record<string, number> | null;
      if (view) return { set, action: a, view };
    }
  }
  const target = resolveAction(action);
  if (!target) throw new Error(`input: there's no action "${action}".`);
  const view = reader?.isValid ? (reader.getData(target.set as unknown as DataComponentDef) as Record<string, number> | null) : null;
  return { ...target, view };
}

/**
 * One player's input, as a script reads it. From a behavior (`this.input`) it reads the pawn the
 * behavior belongs to (the nearest node up its hierarchy with `ControlledBy` or an action set),
 * so it also works on a server, where pawns get their connection's actions; from `InputPlayers`
 * it reads the player's node.
 */
export class PlayerInput {
  /** @internal */
  constructor(
    private readonly world: World,
    /** The player's node, or null (a server pawn, or no player yet). */
    private readonly playerRef: GameObject | null,
    /** Where actions are read: the pawn, else the player's node. */
    private readonly reader: GameObject | null,
    private readonly owner: GameBehavior | null = null,
  ) {}

  /** The player's index, or -1 when no local player is behind it (a server pawn). */
  get index(): number {
    return this.playerRef?.isValid ? this.playerRef.getData(InputPlayer)!.index : -1;
  }

  /** The player's node (under the World's `Input` node), or null. */
  get player(): GameObject | null {
    return this.playerRef?.isValid ? this.playerRef : null;
  }

  private flags(action: string): number {
    const f = find(action, this.reader);
    return f.view ? f.view[f.action.phaseField] : 0;
  }

  /** A button's or axis's value; a vector's length. 0 when there's nothing to read. */
  value(action: string): number {
    const f = find(action, this.reader);
    if (!f.view) return 0;
    if (f.action.valueFields.length === 1) return f.view[f.action.valueFields[0]];
    return Math.hypot(...f.action.valueFields.map((k) => f.view![k]));
  }

  /** A `vec2` action's value (+Y up). */
  vector2(action: string, out = new Vector2()): Vector2 {
    const f = find(action, this.reader);
    return f.view ? out.set(f.view[f.action.valueFields[0]], f.view[f.action.valueFields[1]] ?? 0) : out.set(0, 0);
  }

  vector3(action: string, out = new Vector3()): Vector3 {
    const f = find(action, this.reader);
    const v = f.view;
    return v ? out.set(v[f.action.valueFields[0]], v[f.action.valueFields[1]] ?? 0, v[f.action.valueFields[2]] ?? 0) : out.set(0, 0, 0);
  }

  /** Seconds the action has been actuated (hold progress, charge). */
  elapsed(action: string): number {
    const f = find(action, this.reader);
    return f.view ? f.view[f.action.timeField] : 0;
  }

  held(action: string): boolean {
    return (this.flags(action) & 1) !== 0;
  }
  pressed(action: string): boolean {
    return (this.flags(action) & 2) !== 0;
  }
  released(action: string): boolean {
    return (this.flags(action) & 4) !== 0;
  }
  started(action: string): boolean {
    return (this.flags(action) & 8) !== 0;
  }
  ongoing(action: string): boolean {
    return (this.flags(action) & 16) !== 0;
  }
  triggered(action: string): boolean {
    return (this.flags(action) & 32) !== 0;
  }
  performed(action: string): boolean {
    return (this.flags(action) & 64) !== 0;
  }
  completed(action: string): boolean {
    return (this.flags(action) & 128) !== 0;
  }
  canceled(action: string): boolean {
    return (this.flags(action) & 256) !== 0;
  }

  /**
   * Call `fn` when the action reaches `phase`, for this input's player or the node it reads:
   * dispatched from `ActionEvents`, in the input phase for local players, and in the fixed step
   * (before fixedUpdate scripts) for a pawn a network server writes a client's actions onto. From
   * a behavior, it's unsubscribed when the behavior is disabled; the returned function
   * unsubscribes sooner.
   */
  on(action: string, phase: ActionEventPhase, fn: (e: ActionEvent) => void): () => void {
    const target = find(action, this.reader);
    let set = subscriptions.get(this.world);
    if (!set) subscriptions.set(this.world, (set = new Set()));
    const sub: Subscription = { owner: this.owner, player: this.playerRef, reader: this.reader, set: target.set, action: target.action.name, phase, fn };
    set.add(sub);
    const off = () => void subscriptions.get(this.world)?.delete(sub);
    this.owner?.abortSignal.addEventListener("abort", off, { once: true });
    return off;
  }

  /** The family of the device this player last performed an action with (prompts follow it). */
  get lastFamily(): DeviceFamily {
    return this.playerRef?.isValid ? familyName(this.playerRef.getData(InputPlayer)!.lastFamily) : "keyboard";
  }

  /** What performs `action`, named for `family` (default: the family last used). Null if nothing does. */
  prompt(action: string, family?: DeviceFamily): InputPrompt | null {
    const player = this.requirePlayer("prompt");
    return promptFor(this.world, player, action, family);
  }

  /** Bind `action` to the player's next press (see `RebindOptions`). */
  rebind(action: string, options?: RebindOptions): Promise<RebindResult> {
    return startRebind(this.world, this.requirePlayer("rebind"), action, options);
  }

  /** The player's binding overrides and accessibility settings (changes apply next frame). */
  get accessibility(): Readonly<InputAccessibility> {
    return profileOf(this.world, this.requireIndex("accessibility")).accessibility;
  }

  set accessibility(value: InputAccessibility) {
    const rep = value?.repeat;
    if (rep !== undefined) {
      if (!(typeof rep.delay === "number" && rep.delay >= 0)) throw new Error(`input.accessibility: repeat.delay (${rep.delay}) must be a number of at least 0 seconds.`);
      if (!(typeof rep.interval === "number" && rep.interval > 0)) throw new Error(`input.accessibility: repeat.interval (${rep.interval}) must be a number of seconds above 0.`);
      if (rep.actions !== undefined && !Array.isArray(rep.actions)) throw new Error("input.accessibility: repeat.actions must be a list of action names.");
    }
    const p = profileOf(this.world, this.requireIndex("accessibility"));
    p.accessibility = { ...value };
    p.version++;
  }

  /** Drop every binding override (back to the contexts' controls). */
  resetBindings(): void {
    const p = profileOf(this.world, this.requireIndex("resetBindings"));
    p.overrides = {};
    p.version++;
  }

  /** Save overrides and accessibility with the game's settings, as `input.<profile>.json` (default `player<index>`). */
  saveBindings(profile?: string): Promise<void> {
    const index = this.requireIndex("saveBindings");
    const p = profileOf(this.world, index);
    const data: InputProfileData = { format: 1, overrides: { ...p.overrides }, accessibility: { ...p.accessibility } };
    return Storage.save(`input.${profile ?? `player${index}`}.json`, data, "settings");
  }

  /** Load what `saveBindings` saved; false if nothing was saved. */
  async loadBindings(profile?: string): Promise<boolean> {
    const index = this.requireIndex("loadBindings");
    const data = await Storage.load<Partial<InputProfileData>>(`input.${profile ?? `player${index}`}.json`, "settings");
    if (!data || typeof data !== "object") return false;
    const p = profileOf(this.world, index);
    p.overrides = typeof data.overrides === "object" && data.overrides ? { ...data.overrides } : {};
    p.accessibility = typeof data.accessibility === "object" && data.accessibility ? { ...data.accessibility } : {};
    p.version++;
    return true;
  }

  /** The device nodes paired with this player. */
  get devices(): GameObject[] {
    const index = this.index;
    return [...deviceNodes(this.world)].filter((d) => d.isValid && d.getData(InputDevice)!.player === index && index >= 0);
  }

  /** Pair a device node with this player (taking it from any other). */
  pair(device: GameObject): void {
    const data = device.getData(InputDevice);
    if (!data) throw new Error(`pair: ${device} isn't a device node (one with engine.InputDevice).`);
    data.player = this.requireIndex("pair");
  }

  /** Unpair a device node from this player. */
  unpair(device: GameObject): void {
    const data = device.getData(InputDevice);
    if (data && data.player === this.index) data.player = -1;
  }

  /** Rumble the player's gamepads: `low` and `high` motor strengths 0..1, for `durationMs`. */
  rumble(low: number, high: number, durationMs: number): void {
    for (const d of this.devices) {
      const data = d.getData(InputDevice)!;
      if (data.kind === DeviceKind.gamepad) devices.output?.rumble(data.device, low, high, durationMs);
    }
  }

  /** Rumble the triggers (DualSense and Xbox impulse triggers; where the device and platform can). */
  rumbleTriggers(left: number, right: number, durationMs: number): void {
    for (const d of this.devices) {
      const data = d.getData(InputDevice)!;
      if (data.kind === DeviceKind.gamepad) devices.output?.triggerRumble?.(data.device, left, right, durationMs);
    }
  }

  /**
   * Set an adaptive trigger effect: resistance, a weapon's click, vibration (DualSense, in
   * Chromium browsers through WebHID). `{ mode: "off" }` frees the trigger.
   */
  setTriggerEffect(trigger: "left" | "right", effect: TriggerEffect): void {
    for (const d of this.devices) {
      const data = d.getData(InputDevice)!;
      if (data.kind === DeviceKind.gamepad) devices.output?.triggerEffect?.(data.device, trigger, effect);
    }
  }

  /** Set the light bar colour (0..255 each; DualSense, DualShock 4, on desktop). */
  setLight(r: number, g: number, b: number): void {
    for (const d of this.devices) {
      const data = d.getData(InputDevice)!;
      if (data.kind === DeviceKind.gamepad) devices.output?.setLed?.(data.device, r, g, b);
    }
  }

  /** Turn gyro and accelerometer reports on or off (desktop; off by default, they cost battery). */
  setSensors(enabled: boolean): void {
    for (const d of this.devices) {
      const data = d.getData(InputDevice)!;
      if (data.kind === DeviceKind.gamepad) devices.output?.setSensors?.(data.device, enabled);
    }
  }

  private requirePlayer(what: string): GameObject {
    const p = this.player;
    if (!p) throw new Error(`input.${what}: there's no local player here (a server pawn, or no action set defined yet).`);
    return p;
  }

  private requireIndex(what: string): number {
    return this.requirePlayer(what).getData(InputPlayer)!.index;
  }
}

/** The input a node reads: its pawn (nearest node up with ControlledBy or an action set) and that pawn's player. */
function inputOf(world: World, node: GameObject, owner: GameBehavior | null): PlayerInput {
  for (let n: GameObject | null = node; n; n = n.parent) {
    const by = n.getData(ControlledBy);
    if (by) return new PlayerInput(world, playerNode(world, by.player), n, owner);
    if (actionSets().some((s) => n!.hasData(s as unknown as DataComponentDef))) return new PlayerInput(world, null, n, owner);
  }
  const p0 = playerNode(world, 0);
  return new PlayerInput(world, p0, p0, owner);
}

/** Local players (ADR 0337): who has joined, joining and leaving by hand (`input.join: "manual"`). */
export const InputPlayers = {
  /** Player `index` in the current World, or null if they haven't joined. */
  get(index: number): PlayerInput | null {
    const world = World.require();
    const node = playerNode(world, index);
    return node ? new PlayerInput(world, node, node) : null;
  },

  /** Every player in the current World, by index. */
  all(): PlayerInput[] {
    const world = World.require();
    return playerNodes(world).map((n) => new PlayerInput(world, n, n));
  },

  /** The input of the player controlling `node` (its pawn's), as `this.input` gives a behavior on it. */
  of(node: GameObject): PlayerInput {
    return inputOf(node.world, node, null);
  },

  /** Join a player (the lowest free index unless given). Pair devices with `player.pair(device)`. */
  join(index?: number): PlayerInput {
    const world = World.require();
    const node = createPlayer(world, index);
    return new PlayerInput(world, node, node);
  },

  /** Remove a player: their devices are unpaired and `PlayerLeft` announces it. */
  leave(index: number): void {
    removePlayer(World.require(), index);
  },
};

_setInputFacade((b) => inputOf(b._world, b.owner, b));

/** How many of this frame's `ActionEvents` each World has dispatched (dispatch runs in the input phase and in fixed steps). */
const dispatched = new WeakMap<World, { frame: number; count: number }>();

/** Whether event `e` is for subscriber `s`: the node it reads, or its local player (whose actions its pawn copies). */
function concerns(s: Subscription, e: ActionEvent): boolean {
  if (!s.player && !s.reader) return true;
  if ((s.reader !== null && s.reader === e.node) || (s.player !== null && s.player === e.player)) return true;
  // A pawn's local player, looked up now: the pawn may have subscribed before its player joined.
  const by = s.reader?.isValid ? s.reader.getData(ControlledBy) : null;
  return !!by && by.player === e.index && e.node.isValid && e.node.hasData(InputPlayer);
}

function dispatch(world: World): void {
  const events = world._buffer(ActionEvents);
  const frame = world.time.frameCount;
  let cursor = dispatched.get(world);
  if (!cursor || cursor.frame !== frame) dispatched.set(world, (cursor = { frame, count: 0 }));
  const from = cursor.count;
  cursor.count = events.length;
  const subs = subscriptions.get(world);
  if (!subs?.size) return;
  for (let i = from; i < events.length; i++) {
    const e = events[i];
    for (const s of [...subs]) {
      if (s.set !== e.set || s.action !== e.action || s.phase !== e.phase) continue;
      if (!concerns(s, e)) continue;
      if (s.owner && !s.owner.isActiveAndEnabled) continue;
      try {
        s.fn(e);
      } catch (err) {
        console.error(`[myco] An input.on("${e.action}", "${e.phase}") listener threw:`, err);
      }
    }
  }
}

defineBuiltinSystem({ name: "engine.InputEventScripts", phase: "input", after: ["engine.InputEvaluate"], run: (w) => dispatch(w) });
// Server pawns' events come from the network in the fixed step (inputNet.ts).
defineBuiltinSystem({ name: "engine.InputTickEventScripts", phase: "fixedUpdate", after: ["engine.InputNetApply"], before: ["engine.FixedUpdateScripts"], run: (w) => dispatch(w) });
