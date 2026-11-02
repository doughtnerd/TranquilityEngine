/**
 * Replication's built-in systems (ADR 0033, T11). They're in every World's catalog and do nothing
 * in Worlds that aren't network servers or clients. Order within a frame:
 *
 * - `engine.ReplicationReceive` (update, after `engine.NetReceive`, before the update scripts):
 *   a client reads the snapshots that arrived this frame (in either receive pass), spawns,
 *   matches and despawns ghosts, and queues its ack.
 * - `engine.ReplicationInterpolate` (update, right after): a client sets every ghost to its
 *   interpolated values, so update and lateUpdate scripts, systems, transform propagation and
 *   rendering all see this frame's poses.
 * - `engine.ReplicationSend` (lateUpdate, after the lateUpdate scripts, before `engine.NetSend`):
 *   a server reads acks and sends one snapshot per connection with the state the tick's game
 *   simulation (fixedUpdate, update and lateUpdate scripts and systems before it) left. Then
 *   `engine.NetSend` sends it, and the client's ack, at the end of the same frame.
 */
import { defineBuiltinSystem } from "../../core/systems";
import { clientReplication } from "./client";
import { serverReplication } from "./server";

defineBuiltinSystem({
  name: "engine.ReplicationReceive",
  phase: "update",
  after: ["engine.NetReceive"],
  before: ["engine.UpdateScripts"],
  run: (world) => clientReplication(world)?.receive(),
});
defineBuiltinSystem({
  name: "engine.ReplicationInterpolate",
  phase: "update",
  after: ["engine.ReplicationReceive"],
  before: ["engine.UpdateScripts"],
  run: (world) => clientReplication(world)?.interpolate(),
});
defineBuiltinSystem({
  name: "engine.ReplicationSend",
  phase: "lateUpdate",
  after: ["engine.LateUpdateScripts"],
  before: ["engine.NetSend"],
  run: (world) => serverReplication(world)?.run(),
});
