# 0402. Ghost creation goes reliably, apart from per-tick state

- **Status:** Accepted; amended by [0405](0405-late-snapshot-parts-are-read-in-tick-order-and-acked.md) (late state parts are read and acked; the per-message staleness rule is replaced by a per-ghost one)
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0121, 0334 and 0398)
- **Related:** 0033, 0100, 0121, 0333, 0334, 0398

## Context

0334 splits a tick's snapshot into datagram-sized parts, each self-contained: a ghost's spawn (prefab or scene path, layout spec, structure, the strings they need) travels in the same unreliable part as its state, and is repeated every tick until a part carrying it is acked. A ghost bigger than a whole part still goes, alone, and the transport sends that message over the WebSocket's TCP stream (0333). 0398 stopped the transport from dropping it as stale when datagrams overtake it. But the replication client still drops any part from a tick older than the newest it has read (`src/engine/net/replication/client.ts`, `receive`). So an oversize part overtaken by the next tick's first datagram is dropped, the server resends it next tick, and on a laggy link the same thing happens every tick: a large ghost may never spawn (Q16).

The owner considered applying late oversize parts on the client (keeping newer state, reconciling baselines) and chose instead the model Unreal uses. An Unreal actor channel opens with a reliable bunch carrying the actor's class and its initial properties; ongoing property replication is unreliable and only flows once the channel is open. Creation and per-tick state are different kinds of data with different delivery needs, and mixing them in one unreliable message is what made a spawn hostage to datagram ordering.

The session already has a reliable, in-order channel per connection (`NetSession.send(kind, to, "reliable", …)`): RPCs, the handshake and replicated string fields (`net.ghostStrings`, ADR 0068) use it. On loopback and a plain WebSocket every message shares one ordered stream; with a data channel open, reliable messages stay on TCP and unreliable ones that fit go as datagrams.

## Decision

We will send a ghost's **lifecycle** reliably and in order, apart from its per-tick **state**:

**Lifecycle messages.** A new reliable message kind, `net.ghosts`, tagged with the server tick. On a sent tick with any lifecycle events for a connection, the server sends it one message with, in this order: despawns, leaves (0121), relayouts (layout version, layout spec and the ghost's full state in the new layout), structure changes (0100), then spawns (spawn info, layout spec, layout version, structure and the ghost's full state). Each event goes once: the stream doesn't lose it, so nothing is repeated until acked. Spawns go in id order while the tick's budget lasts (at least one, however big); the rest wait for the next tick. Relayouts and structure changes are sent only for ghosts whose spawn has gone; a spawn carries the current layout and structure.

**Snapshot parts carry states only.** A part is `varuint part index, varuint baseline gap, varuint state count`, then the states as before. The despawn, leave, spawn, relayout and structure sections leave the snapshot, and with them 0334's rule that a ghost's spawn, relayout and structure change travel in the same part as its state.

**Ordering: the server waits for the spawn's ack.** The server puts a ghost's state in a snapshot only once the client has acked the lifecycle message carrying its spawn, and, since its last relayout, only once it acked that relayout. So a client never reads a state for a ghost it hasn't spawned, or in a layout it doesn't have. We chose this over the client buffering states for ghosts it hasn't spawned: a buffered state can't even be decoded without the layout its spawn defines, so the client would have to hold raw bytes and the server would have to keep the spawn's state as a baseline the client might not have yet. Waiting costs a round trip of no state updates after a spawn, which the spawn's own full state covers (the ghost appears where it was spawned), as Unreal's property updates follow the channel open.

**Baselines.** The full state in a spawn or relayout is the ghost's first state in that layout on the client, and becomes the server's delta baseline once the lifecycle message is acked. From then on 0334's per-part rules apply unchanged: an acked part's states become baselines, a baseline is used only within `BASELINE_WINDOW` and only in the ghost's current layout.

**Acks.** `net.snapshotAck` becomes `varuint lifecycle tick, varuint snapshot tick, varuint part count, parts` (a tick of 0 is none). Lifecycle messages arrive in order, so one tick acks every message up to it. The client sends an ack at the end of any frame in which it read a lifecycle message or a snapshot part, so a lost ack is repeated by the next.

**Stale parts.** The client still reads every part of its newest snapshot tick once and drops parts of older ticks (0334). It also drops a part older than the newest lifecycle message it has applied: such a part may carry a state for a ghost that message despawned, took away or relayouted. That only drops stale states.

**Relevancy (0121) and the earlier fixes.** A ghost that leaves goes in that tick's message as a leave and into the connection's dormant set; one that comes back is spawned afresh in a later message, with a new `since`, so acks of messages from before its return don't count for it (B2). One destroyed after it left is still despawned, so the client destroys a deactivated scene or nested ghost and forgets its strings (B11). On the client a leave, a despawn and a later spawn of the same id are applied in the order sent. A ghost destroyed while its spawn is in flight is despawned in a later message, after the spawn.

**Strings (0100).** The per-connection string table is used only by lifecycle messages now. They're reliable and in order, so a string is the client's from the moment it's written: the server marks it acked at once, and later spawns of the same prefab name it by index, within the same message too. Replicated string fields (`net.ghostStrings`) travel on the same reliable stream, after the tick's lifecycle message.

**Size.** Reliable messages have no datagram cap, so the oversize problem disappears for creation. A tick's budget (`maxSnapshotBytes`) holds its lifecycle message and its snapshot together: the lifecycle message first, the snapshot in what's left. A ghost whose **state** alone exceeds a datagram keeps 0334's "goes alone" rule. If that part arrives after the next tick's datagrams, it's a stale state update and the client drops it; the next tick sends the ghost again. Nothing but that update is lost: its spawn isn't in it.

**Loopback and a plain WebSocket.** Unchanged in behaviour: every message shares one ordered stream, so lifecycle messages and snapshots arrive in the order sent.

**Version.** The net protocol version goes from 5 to 6; client and server must run the same engine version, as they already must.

## Alternatives considered

- **Apply late oversize parts on the client** (the owner's first option): read a part older than the newest tick, take its spawns and structure, keep its states only where newer, and ack exactly what was kept. It fixes spawns but leaves creation riding an unreliable, repeated message, needs per-ghost ack bookkeeping to keep server and client agreeing on baselines, and keeps 0334's coupling of spawn and state in one part. The owner chose the Unreal model instead.
- **The client buffers states for ghosts not spawned yet.** States can't be decoded without the spawn's layout, so the client would buffer raw parts and the server could reference a spawn baseline the client hasn't applied. Waiting for the spawn's ack is simpler and can't go wrong.
- **Reliable spawns, but structure changes and relayouts still in snapshot parts.** Structure changes and relayouts are lifecycle events that name other ghosts (a parent) and change how states decode (a layout); keeping them in parts would keep 0334's same-part coupling and its repeat-until-acked bookkeeping for no gain.
- **Fragment big messages over the data channel.** Rejected in 0398: no existing fragmenter, and fragments multiply loss.

## Consequences

**Positive**
- A ghost of any size spawns, however datagrams overtake the stream; its spawn is never resent.
- Snapshot parts are smaller and simpler: no spawn, despawn, leave, relayout or structure sections, and no planning a ghost's pending items into its state's part.
- A spawn's full state is a baseline, so a ghost's first snapshot states are deltas (an unchanged one costs about a byte from the start).
- Despawns, leaves, structure changes and relayouts each cost their bytes once, not once per tick until acked.

**Negative / costs**
- A round trip of no state updates after each spawn and each relayout, while the server waits for the ack. The interpolation buffer hides part of it; a ghost spawned moving holds its spawn position for that round trip, then catches up.
- Lifecycle events now depend on the reliable stream's latency. With a data channel open that's TCP, which can be slower than datagrams after a loss; a structure change (a deactivation, a reparent) can show up later than it would have in a datagram that got through. It can no longer be lost, so it's never later than the stream.
- A ghost whose state delta alone is bigger than a datagram is still sent over the stream every tick, and on a link where the next tick's datagrams overtake the stream every tick, every such update is dropped as stale: the ghost spawns and then holds its spawn state while it changes that much per tick. This is the owner's accepted trade (a stale state update may be dropped); see Open questions.
- The server keeps a lifecycle record per unacked message per connection (the full states of its spawns and relayouts) until acked. Nothing caps it: a client acks at the end of every frame in which it reads anything, and the records go with the connection.

## Deprecates

- 0334's same-part rule (a ghost's spawn, relayout and structure change travel with its state), its despawn and leave spreading over parts, and the spawn, despawn, leave, relayout and structure sections of `net.snapshot`. 0334's parts, budgets, per-part acks and baselines stand, so it's amended, not superseded.
- 0121's "repeated until acked" for leaves and relayouts, and 0100's for structure changes and the string table's "inline until a snapshot carrying it is acked".
- 0398's consequence "replication still drops a part of a tick older than the newest it has read" no longer concerns spawns, and its open question (read an older part that only spawns) is answered: spawns aren't in parts.
- The ack layout of 0334 (`tick, count, parts`), replaced by the one above.

## Open questions

- Should a state part that arrives late (older than the newest tick) be read when it's not older than the newest lifecycle message, inserting its states in tick order and acking it, so a ghost whose state is always bigger than a datagram isn't starved on a link that reorders every tick? The baselines stay sound if the client keeps every state of a part it acks; the cost is a richer ack (late parts by tick) and history kept for older ticks. **Answered by [0405](0405-late-snapshot-parts-are-read-in-tick-order-and-acked.md): yes.**
- Should spawns have their own budget, separate from states, so a burst of spawns doesn't take a tick's state updates?

## References

- `src/engine/net/replication/server.ts` (`lifecycleMessage`, `lifecycleAcked`, `snapshot`, the wire layouts at the top), `client.ts` (`readLifecycle`, `read`, `receive`), `wire.ts` (`GHOSTS`, `ACK`, `StringTableOut`), `net/session.ts` (protocol version 6)
- `src/engine/tests/replicationParts.test.ts` ("spawns go reliably, apart from states (ADR 0402)": a test transport whose stream lags its datagrams by 150 ms)
- Unreal Engine, "Actor Replication" and "Replication Graph" docs (actor channels: the reliable open bunch, then unreliable property replication)
