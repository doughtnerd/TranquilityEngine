/**
 * Networked action sets (ADR 0337): `defineActions(…, { networked: true })` is also an input
 * stream (`defineInput`) with the set's id, its value and phase fields, and its encoding. Only
 * resolved actions travel: triggers and modifiers run on the client.
 *
 * - Client: each fixed step, after `engine.InputTick` wrote the tick's actions, every local
 *   player's are written into the stream under that player's index (quantized values are written
 *   back to the player and its pawns, so the client predicts with what the server receives). One
 *   local player sends exactly what a single-player client always sent.
 * - Server: after `engine.NetInputTick` applied the tick's inputs, every node with the set's
 *   component that a connection owns gets that connection's actions, of the local player its
 *   `ConnectionPlayer` names (player 0 without one), so gameplay reads the same component on
 *   client, server and offline. The tick's phase edges become `ActionEvents` with the pawn as
 *   their `node`, so `this.input.on` works on server pawns. A tick whose input didn't arrive
 *   repeats the last one's values and levels, not its edges (a lost press isn't performed twice).
 * - Prediction: while a client re-simulates a tick, its pawns' sets are restored from that tick's
 *   input before the predicted systems run (a predicted built-in), of the local player its
 *   `ConnectionPlayer` names, else its `ControlledBy` player.
 */
import type { World } from "../core/World";
import { defineComponent, i32, type DataComponentDef, type Schema } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import { _redefineInput, defineInput } from "../net/input";
import type { InputDef } from "../net/messages";
import { netSession } from "../net/session";
import type { GameObject } from "../scene/GameObject";
import { ActionEvents, ActionPhase, EDGE_FLAGS, onActionSetDefined, type ActionEventPhase, type ActionSetDef } from "./actions";
import { ControlledBy, InputPlayer, playerNodes } from "./players";

/**
 * On a networked pawn: which of its owning connection's local players drives it (ADR 0337), for a
 * client that sends several local players' actions over one connection (local co-op online). The
 * server writes that player's actions into the pawn's action sets. Without it, player 0: a
 * single-player client needs nothing. The owning connection is `Replicated.ownerId`'s, as before.
 * It's a separate component from `ControlledBy`, which names a player of the World's own (a host's
 * local players), so a host never copies its own players' actions onto a remote client's pawn.
 */
export const ConnectionPlayer = defineComponent("engine.ConnectionPlayer", { index: i32 });

/** Networked sets and their streams. */
const streams = new Map<ActionSetDef, InputDef>();

/** The fields a networked set sends: values and phases (not the actuated time). */
function wireSchema(def: ActionSetDef): Schema {
  const schema: Schema = {};
  for (const a of def.actions) {
    for (const f of a.valueFields) schema[f] = def.schema[f];
    schema[a.phaseField] = def.schema[a.phaseField];
  }
  return schema;
}

onActionSetDefined((def) => {
  if (!def.options.networked) return;
  let redefined = false;
  for (const old of streams.keys()) if (old.id === def.id) redefined = streams.delete(old);
  const encoding: Record<string, { quantize?: number }> = {};
  for (const [name, enc] of Object.entries(def.options.encoding ?? {})) {
    const a = def.actions.find((x) => x.name === name);
    if (!a) throw new Error(`defineActions("${def.id}"): encoding names "${name}", which isn't an action.`);
    if (enc?.quantize !== undefined) for (const f of a.valueFields) encoding[f] = { quantize: enc.quantize };
  }
  const define = redefined ? _redefineInput : defineInput;
  streams.set(def, define(def.id, wireSchema(def), { encoding, redundancy: def.options.redundancy }));
});

function send(world: World): void {
  const session = netSession(world);
  if (!session || session.isServer || !streams.size) return;
  const players = playerNodes(world);
  if (!players.length) return;
  for (const [def, stream] of streams) {
    const fields = Object.keys(stream.schema);
    for (const player of players) {
      const index = player.getData(InputPlayer)!.index;
      const view = player.getData(def as unknown as DataComponentDef) as Record<string, number> | null;
      if (!view) continue;
      const values: Record<string, number> = {};
      for (const f of fields) values[f] = view[f];
      stream.write(values, index);
      // Quantized fields go back as sent, to the player and its pawns, so prediction uses them.
      const sent = stream.localOf(index) as Record<string, number>;
      for (const f of fields) view[f] = sent[f];
      for (const row of world._query([ControlledBy, def as unknown as DataComponentDef])) {
        const r = row as unknown as Record<string, Record<string, number>>;
        if (r[ControlledBy.key].player !== index) continue;
        for (const f of fields) r[def.key][f] = sent[f];
      }
    }
  }
}

const PHASE_EVENTS: [number, ActionEventPhase][] = [
  [ActionPhase.started, "started"],
  [ActionPhase.performed, "performed"],
  [ActionPhase.completed, "completed"],
  [ActionPhase.canceled, "canceled"],
];

/** The input each server pawn was last given, per set: the same record again is a repeated tick. */
const lastApplied = new WeakMap<GameObject, Map<ActionSetDef, object>>();

/** The local player whose actions drive `node`: its `ConnectionPlayer`, else (on a client) its `ControlledBy` player, else 0. */
function localPlayerOf(node: GameObject, client: boolean): number {
  const named = node.getData(ConnectionPlayer);
  if (named) return named.index;
  if (client) return node.getData(ControlledBy)?.player ?? 0;
  return 0;
}

function apply(world: World, replayOnly: boolean): void {
  const session = netSession(world);
  if (!session || !streams.size) return;
  if (replayOnly ? session.isServer || session.replayTick === null : !session.isServer) return;
  for (const [def, stream] of streams) {
    const fields = Object.keys(stream.schema);
    for (const row of world._query([def as unknown as DataComponentDef])) {
      const node = row.node;
      const index = localPlayerOf(node, replayOnly);
      const input = stream.of(node, index) as Record<string, number> | null;
      if (!input) continue;
      const view = (row as unknown as Record<string, Record<string, number>>)[def.key];
      for (const f of fields) view[f] = input[f];
      if (replayOnly) continue;
      // Server: a repeated tick keeps levels, not edges; a new one's edges become ActionEvents.
      let seen = lastApplied.get(node);
      if (!seen) lastApplied.set(node, (seen = new Map()));
      const repeated = seen.get(def) === input;
      seen.set(def, input);
      let owner: GameObject | null = null;
      for (const a of def.actions) {
        if (repeated) {
          view[a.phaseField] &= ~EDGE_FLAGS;
          continue;
        }
        const flags = view[a.phaseField];
        if (!(flags & EDGE_FLAGS)) continue;
        owner ??= connectionNode(world, node) ?? node;
        const x = view[a.valueFields[0]];
        const y = a.valueFields.length > 1 ? view[a.valueFields[1]] : 0;
        const z = a.valueFields.length > 2 ? view[a.valueFields[2]] : 0;
        const value = a.valueFields.length === 1 ? x : Math.hypot(x, y, z);
        for (const [bit, phase] of PHASE_EVENTS) {
          if (flags & bit) ActionEvents.push({ player: owner, node, index, set: def, action: a.name, phase, value, x, y, z });
        }
      }
    }
  }
}

/** The connection node of the connection that owns `node` (`Replicated.ownerId`), or `node` itself if it is one. */
function connectionNode(world: World, node: GameObject): GameObject | null {
  return netSession(world)?.connectionOf(node)?.node ?? null;
}

defineBuiltinSystem({ name: "engine.InputNetSend", phase: "fixedUpdate", after: ["engine.InputTick", "engine.PredictionTick"], before: ["engine.FixedUpdateScripts"], run: (w) => send(w) });
defineBuiltinSystem({ name: "engine.InputNetApply", phase: "fixedUpdate", after: ["engine.NetInputTick", "engine.InputTick", "engine.PredictionTick", "engine.InputNetSend"], before: ["engine.FixedUpdateScripts"], run: (w) => apply(w, false) });
defineBuiltinSystem({ name: "engine.InputNetReplay", phase: "fixedUpdate", predicted: true, after: ["engine.PredictionTick"], before: ["engine.FixedUpdateScripts"], run: (w) => apply(w, true) });
