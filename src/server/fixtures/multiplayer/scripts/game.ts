// The dedicated server's test project (T14): a server-moved replicated node and an RPC the server
// answers. The project's Client World is for the editor; the dedicated server skips it.
import { Transform, defineComponent, defineRpc, defineSystem, f32, i32, type DataView } from "tranquility";

/** Moves a node right at `speed` units per second. */
export const Drift = defineComponent("fixture.Drift", { speed: f32 });

/** Client to server: a number to double. */
export const Ping = defineRpc("fixture.Ping", { n: i32 });
/** Server to the client that pinged: the number doubled. */
export const Pong = defineRpc("fixture.Pong", { n: i32 });

/** Drifts nodes, on the server only; clients see them move through replication. */
defineSystem({
  name: "fixture.Drift",
  phase: "fixedUpdate",
  worlds: ["server"],
  query: [Transform, Drift],
  run(rows, ctx) {
    for (const row of rows) row.transform.position.x += (row.drift as DataView<typeof Drift.schema>).speed * ctx.dt;
  },
});

/** Answers each Ping with a Pong to its sender. */
defineSystem({
  name: "fixture.Echo",
  phase: "update",
  worlds: ["server"],
  run() {
    for (const m of Ping.read()) Pong.send({ n: m.n * 2 }, m.connection);
  },
});
