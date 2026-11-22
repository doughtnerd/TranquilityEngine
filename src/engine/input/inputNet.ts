/**
 * Networked action sets (ADR 0337): `defineActions(…, { networked: true })` is also an input
 * stream (`defineInput`) with the set's id, its value and phase fields, and its encoding. Only
 * resolved actions travel: triggers and modifiers run on the client.
 *
 * - Client: each fixed step, after `engine.InputTick` wrote the tick's actions, the first local
 *   player's are written into the stream (quantized values are written back, so the client
 *   predicts with what the server receives).
 * - Server: after `engine.NetInputTick` applied the tick's inputs, every node with the set's
 *   component that a connection owns gets that connection's actions, so gameplay reads the same
 *   component on client, server and offline.
 * - Prediction: while a client re-simulates a tick, its pawns' sets are restored from that tick's
 *   input before the predicted systems run (a predicted built-in).
 */
import type { World } from "../core/World";
import type { DataComponentDef, Schema } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import { defineInput } from "../net/input";
import type { InputDef } from "../net/messages";
import { netSession } from "../net/session";
import { onActionSetDefined, type ActionSetDef } from "./actions";
import { ControlledBy, playerNodes } from "./players";

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
  for (const old of streams.keys()) if (old.id === def.id) streams.delete(old);
  const encoding: Record<string, { quantize?: number }> = {};
  for (const [name, enc] of Object.entries(def.options.encoding ?? {})) {
    const a = def.actions.find((x) => x.name === name);
    if (!a) throw new Error(`defineActions("${def.id}"): encoding names "${name}", which isn't an action.`);
    if (enc?.quantize !== undefined) for (const f of a.valueFields) encoding[f] = { quantize: enc.quantize };
  }
  streams.set(def, defineInput(def.id, wireSchema(def), { encoding, redundancy: def.options.redundancy }));
});

function send(world: World): void {
  const session = netSession(world);
  if (!session || session.isServer || !streams.size) return;
  const player = playerNodes(world)[0];
  if (!player) return;
  for (const [def, stream] of streams) {
    const view = player.getData(def as unknown as DataComponentDef) as Record<string, number> | null;
    if (!view) continue;
    const values: Record<string, number> = {};
    for (const f of Object.keys(stream.schema)) values[f] = view[f];
    stream.write(values);
    // Quantized fields go back as sent, to the player and its pawns, so prediction uses them.
    const sent = stream.local as Record<string, number>;
    for (const f of Object.keys(stream.schema)) view[f] = sent[f];
    for (const row of world._query([ControlledBy, def as unknown as DataComponentDef])) {
      const pawn = row as unknown as Record<string, Record<string, number>>;
      for (const f of Object.keys(stream.schema)) pawn[def.key][f] = sent[f];
    }
  }
}

function apply(world: World, replayOnly: boolean): void {
  const session = netSession(world);
  if (!session || !streams.size) return;
  if (replayOnly ? session.isServer || session.replayTick === null : !session.isServer) return;
  for (const [def, stream] of streams) {
    for (const row of world._query([def as unknown as DataComponentDef])) {
      const input = stream.of(row.node);
      if (!input) continue;
      const view = (row as unknown as Record<string, Record<string, number>>)[def.key];
      for (const f of Object.keys(stream.schema)) view[f] = (input as Record<string, number>)[f];
    }
  }
}

defineBuiltinSystem({ name: "engine.InputNetSend", phase: "fixedUpdate", after: ["engine.InputTick"], before: ["engine.FixedUpdateScripts"], run: (w) => send(w) });
defineBuiltinSystem({ name: "engine.InputNetApply", phase: "fixedUpdate", after: ["engine.NetInputTick", "engine.InputTick"], before: ["engine.FixedUpdateScripts"], run: (w) => apply(w, false) });
defineBuiltinSystem({ name: "engine.InputNetReplay", phase: "fixedUpdate", predicted: true, after: ["engine.PredictionTick"], before: ["engine.FixedUpdateScripts"], run: (w) => apply(w, true) });
