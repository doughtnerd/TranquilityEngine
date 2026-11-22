/**
 * Input players (ADR 0335): a player is a node under the World's `Input` node with `InputPlayer`
 * and every action set's component. Devices are paired to players (`InputDevice.player`) by the
 * project's join policy (`project.json` `input.join`):
 *
 * - `single` (default): player 0, created as soon as an action set is defined, owns every device.
 * - `onePerDevice`: the keyboard and pointer are one player, each gamepad another; a player leaves
 *   when its gamepad is unplugged.
 * - `pressToJoin`: a device not yet paired joins as a new player with its first press.
 * - `manual`: the game joins and pairs players (`InputPlayers.join`, `player.pair`).
 *
 * `ControlledBy { player }` on a node makes it that player's pawn: the player's actions are copied
 * onto it each frame and tick (`evaluate.ts`), so systems query one entity.
 */
import type { World } from "../core/World";
import { defineBuffer, defineComponent, i32, u8 } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { GameObject } from "../scene/GameObject";
import { PRESS_POINT } from "./controls";
import { actionSets } from "./actions";
import { DEVICE_FAMILIES, DeviceEvents, DeviceKind, InputDevice, deviceNodes, inputRoot, takesLocalInput } from "./deviceEntities";

/** A player. `lastFamily` is the `DEVICE_FAMILIES` index of the device that last performed an action (prompts). */
export const InputPlayer = defineComponent("engine.InputPlayer", { index: i32, joinState: u8, lastFamily: u8 });

/** On a pawn: the index of the player controlling it. Its action sets are copies of that player's. */
export const ControlledBy = defineComponent("engine.ControlledBy", { player: i32 });

export interface PlayerChange {
  /** The player's node. */
  readonly player: GameObject;
  readonly index: number;
}

/** Players who joined this frame. */
export const PlayerJoined = defineBuffer<PlayerChange>("engine.PlayerJoined");
/** Players who left this frame (their node is destroyed at the end of the frame). */
export const PlayerLeft = defineBuffer<PlayerChange>("engine.PlayerLeft");

interface WorldPlayers {
  readonly nodes: Map<number, GameObject>;
}

const perWorld = new WeakMap<World, WorldPlayers>();

function stateOf(world: World): WorldPlayers {
  let s = perWorld.get(world);
  if (!s) perWorld.set(world, (s = { nodes: new Map() }));
  return s;
}

/** @internal The World's players by index (valid nodes only), in index order. */
export function playerNodes(world: World): GameObject[] {
  const s = stateOf(world);
  for (const [i, n] of s.nodes) if (!n.isValid) s.nodes.delete(i);
  return [...s.nodes.entries()].sort((a, b) => a[0] - b[0]).map((e) => e[1]);
}

/** @internal The player with `index`, or null. */
export function playerNode(world: World, index: number): GameObject | null {
  const n = stateOf(world).nodes.get(index);
  return n?.isValid ? n : null;
}

/** @internal Give `node` every defined action set it lacks. */
export function addActionSets(node: GameObject): void {
  for (const set of actionSets()) if (!node.hasData(set)) node.addData(set);
}

/** @internal Create player `index` (the lowest free one when omitted), announcing it in `PlayerJoined`. */
export function createPlayer(world: World, index?: number): GameObject {
  const s = stateOf(world);
  const max = world.settings.input.maxPlayers;
  let i = index ?? 0;
  if (index === undefined) while (s.nodes.get(i)?.isValid) i++;
  if (s.nodes.get(i)?.isValid) throw new Error(`InputPlayers.join: player ${i} has already joined.`);
  if (i >= max) throw new Error(`InputPlayers.join: player ${i} is over the project's input.maxPlayers (${max}).`);
  const node = world._createNode(`Player ${i}`, inputRoot(world).entity, { transform: false });
  node.addData(InputPlayer, { index: i, joinState: 1, lastFamily: 0 });
  addActionSets(node);
  s.nodes.set(i, node);
  PlayerJoined.push({ player: node, index: i });
  return node;
}

/** @internal Remove player `index`: its devices are unpaired, `PlayerLeft` announces it, and its node is destroyed at the end of the frame. */
export function removePlayer(world: World, index: number): void {
  const s = stateOf(world);
  const node = s.nodes.get(index);
  s.nodes.delete(index);
  if (!node?.isValid) return;
  for (const d of deviceNodes(world)) {
    const data = d.isValid ? d.getData(InputDevice) : null;
    if (data && data.player === index) data.player = -1;
  }
  PlayerLeft.push({ player: node, index });
  world._destroyNode(node.entity);
}

/** The devices as join groups: the keyboard and pointer together, each gamepad alone. */
function groups(world: World): GameObject[][] {
  const kbm: GameObject[] = [];
  const out: GameObject[][] = [];
  for (const d of deviceNodes(world)) {
    if (!d.isValid) continue;
    const data = d.getData(InputDevice)!;
    if (!data.connected) continue;
    if (data.kind === DeviceKind.gamepad) out.push([d]);
    else kbm.push(d);
  }
  if (kbm.length) out.unshift(kbm);
  return out;
}

const pairedTo = (group: GameObject[]): number => group[0].getData(InputDevice)!.player;
const pairGroup = (group: GameObject[], index: number) => {
  for (const d of group) d.getData(InputDevice)!.player = index;
};

function pair(world: World): void {
  if (!takesLocalInput(world) || actionSets().length === 0) return;
  const policy = world.settings.input.join;
  const s = stateOf(world);
  for (const node of s.nodes.values()) if (node.isValid) addActionSets(node);
  if (policy === "single") {
    if (!playerNode(world, 0)) createPlayer(world, 0);
    for (const group of groups(world)) pairGroup(group, 0);
    return;
  }
  if (policy === "manual") return;
  const max = world.settings.input.maxPlayers;
  const all = groups(world);
  if (policy === "onePerDevice") {
    // A gamepad's player leaves with it.
    for (const [index] of [...s.nodes]) {
      const owns = all.some((g) => pairedTo(g) === index);
      if (!owns && index !== 0) removePlayer(world, index);
    }
    for (const group of all) {
      const owner = pairedTo(group);
      if (owner >= 0 && playerNode(world, owner)) continue;
      if (playerNodes(world).length >= max) break;
      const node = createPlayer(world);
      pairGroup(group, node.getData(InputPlayer)!.index);
    }
    return;
  }
  // pressToJoin: an unpaired group's first press joins it.
  const pressed = new Set<GameObject>();
  for (const e of DeviceEvents.read()) if (e.value >= PRESS_POINT || e.value <= -PRESS_POINT) pressed.add(e.device);
  for (const group of all) {
    const owner = pairedTo(group);
    if (owner >= 0 && playerNode(world, owner)) continue;
    if (owner >= 0) pairGroup(group, -1); // its player left
    if (!group.some((d) => pressed.has(d))) continue;
    if (playerNodes(world).length >= max) break;
    const node = createPlayer(world);
    pairGroup(group, node.getData(InputPlayer)!.index);
  }
}

/** @internal The `DEVICE_FAMILIES` index of a device node. */
export function familyIndex(device: GameObject): number {
  return device.getData(InputDevice)?.family ?? 0;
}

/** @internal The family name of `InputPlayer.lastFamily`. */
export function familyName(code: number): (typeof DEVICE_FAMILIES)[number] {
  return DEVICE_FAMILIES[code] ?? "keyboard";
}

defineBuiltinSystem({ name: "engine.InputPairing", phase: "input", after: ["engine.InputDevices"], run: (w) => pair(w) });
