# 0311. The network session answers a World's net questions: who owns a node, which tick is simulated, whether a ghost is relevant

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033 (T11–T13: replication, inputs, prediction), 0121 (interest management), 0281 (Worlds reach their owner through one typed seam), 0312 (the predicted plan)

## Context

The net modules each keep per-World state in their own `WeakMap`, and four process-wide setter hooks, each with one adapter, joined them:

- `core/systems.ts` `_setPredictionDriver`, set by `net/prediction.ts`: how a World's predicted systems run.
- `net/interest.ts` `_setRelevanceQuery`, set by `net/replication/server.ts`; until set, `Interest.isRelevant` said false.
- `net/input.ts` `registerInputOwnerResolver`, set by `net/Replicated.ts`; until set, `Move.of(ghost)` said null.
- `net/input.ts` `setInputReplayTick`, set by `prediction.ts` around each replayed tick.

They worked only through import side effects (`Replicated.ts` imports `replication/systems.ts`, which imports `prediction.ts`) and failed silently when a module wasn't loaded. Facts were duplicated: the simulated tick lived in both `ClientPrediction.replaying` and input's `replayTicks` (always set together); the ownership rule "`ownerId` names an open connection" was written three times (`Replicated.ts`'s resolver and `ownedIn`, and twice in server relevancy). Two tick-history `Map`s (a client's sent inputs, a predicted ghost's states) were pruned by stopping at the first recent key, which assumed insertion order is tick order. Interest kept its own per-World map of connection ids, pruned by replication.

The session (`net/session.ts`) already sits below all of these modules: every one of them imports it, and it knows the World's connections and its timeline.

## Decision

We will make the session the World's net owner, answering the World's net questions; the hooks are deleted.

- **The scheduler's seam.** `World._net: WorldNet | null` (`WorldNet` in `core/systems.ts`: `predictedRun(): PredictedRun | null`), set by `ensureSession` and cleared by `close`; it replaces the session `WeakMap` (`netSession(world)` reads it). The scheduler asks `world._net?.predictedRun()`: a client answers the pass prediction last reported (`reportPredictedPass`; nothing runs until it reports one), a server or role-less session null (like any other system). Core still imports nothing from net.
- **Who owns a node.** `session.owns(peer, ownerId)` is the one ownership rule (the id is not 0, names the peer, and its connection is open). `ownerPeer(ownerId)` (a server's open connection with that id; a client's own connection when the id is its own) and `ownsLocally(ownerId)` (a server owns 0, a client its connection's id, a role-less World everything) build on it. Input streams map a node to a connection as `peerOf(node) ?? ownerPeer(node's Replicated.ownerId)` (`input.ts` imports `Replicated`); `Replicated.isOwnedLocally` and server relevancy ask `ownsLocally` and `owns`.
- **Which tick is simulated.** Prediction runs catch-up and re-simulated ticks inside `session.replay(tick, run)`; `session.replayTick` (null when not replaying) and `simulatedTick` answer input streams (`of()` returns that tick's input) and `predictedTick()`. `isResimulating()` stays prediction's own state.
- **Whether a ghost is relevant to a connection.** Each `NetPeer` keeps its `interest` (groups and viewer, set by `Interest`, gone with the connection) and `relevantGhosts`, the ghost ids server replication sends it (replication hands it its per-connection known-ghosts map). `session.isRelevant(connectionId, ghostId)` answers `Interest.isRelevant`, which reads the node's `Replicated.ghostId`.
- **Tick histories are kept by tick.** `net/tickHistory.ts` (`TickHistory<T>`): a ring of `capacity` slots holding the newest `capacity` ticks; what's kept is decided by tick numbers, whatever order ticks are written in. The client's sent inputs (`CLIENT_HISTORY`) and each predicted ghost's states (`HISTORY_TICKS`) use it.
- **Built-in order is stated, not inherited from load order.** `input.ts` now loads replication first, so the order that used to follow from which module loaded first is written as constraints: `engine.Lobby` runs before `engine.ReplicationReceive`, `engine.NetInputSend` before `engine.ReplicationSend`. The default World's system order is unchanged.
- **Comment fix:** skipped ticks get the previous input (the newest sent), not this one (`input.ts`'s `commit`).

## Alternatives considered

- **Keep the hooks, fail loudly when unset** — the order dependency and the one-adapter setters would stay; only the failure mode changes.
- **A per-World "net facts" object beside the session** — another per-World owner holding what the session already knows (connections, timeline); the session is the natural owner.
- **Let the session read `Replicated` itself (`ownerOf(node)`)** — `session.ts` importing `Replicated` makes an evaluation cycle (`replication/wire.ts` registers message kinds with the session at load). The session takes the owner id instead; the one rule still lives in the session.
- **Keep the `Map` histories and prune every key below the window** — fixes the order assumption but repeats the window rule in two modules; `TickHistory` states it once and is bounded by construction.

## Consequences

**Positive**
- No load-order dependency: `Move.of(ghost)`, `Interest` and predicted systems work whatever was imported first (`netSession.test.ts` imports modules one by one and builds Worlds directly).
- One ownership rule, one record of the simulated tick, interest that dies with its connection (no pruning pass).
- Tests stay on the public interface (`defineInput`, `predictedTick`, `isResimulating`, `Interest`) and the session's.

**Negative / costs**
- The session's interface grows (ownership, replay, relevance, the scheduler's question), and `NetPeer` carries server-side interest state.
- A client whose prediction never ticks (no replication loaded) no longer runs predicted systems on every row; it runs them on none, which is what prediction would do with no predicted ghosts.

## Deprecates

`_setPredictionDriver` (`core/systems.ts`), `_setRelevanceQuery`, `_interestOf`, `_pruneInterest` and `ConnectionInterest` (`net/interest.ts`), `registerInputOwnerResolver`, `InputOwnerResolver` and `setInputReplayTick` (`net/input.ts`), `ServerReplication.isRelevantTo`, `ClientPrediction.pass`/`replaying`, `ownedIn` (`Replicated.ts`) and the session `WeakMap`: removed.

## Open questions

None.

## References

- `src/engine/net/session.ts`, `net/input.ts`, `net/interest.ts`, `net/Replicated.ts`, `net/prediction.ts`, `net/replication/server.ts`, `net/tickHistory.ts`, `net/lobby/client.ts` (built-in order), `core/systems.ts`, `core/World.ts`
- Tests: `engine/tests/netSession.test.ts`, `engine/tests/tickHistory.test.ts`, `engine/tests/input.test.ts`, `engine/tests/prediction.test.ts`, `engine/tests/replicationInterest.test.ts`, `engine/tests/systemCatalog.test.ts`
- Architecture review 10 (2026-11-21), card 4 and small fix 9
