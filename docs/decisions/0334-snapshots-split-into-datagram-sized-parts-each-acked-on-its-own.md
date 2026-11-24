# 0334. Snapshots split into datagram-sized parts, each acked on its own

- **Status:** Accepted; amended by [0402](0402-ghost-creation-goes-reliably-apart-from-per-tick-state.md) and [0405](0405-late-snapshot-parts-are-read-in-tick-order-and-acked.md) (late parts are read and acked)
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0100, 0101, 0121, 0333

## Context

0333 caps a connection's snapshot at one datagram (about 1,090 bytes of body) while its WebRTC data channel is open, because losing one piece of a fragmented message loses all of it. Before 0333 the same connection got up to `maxSnapshotBytes` (64 KiB by default) per tick, over TCP. The cap is a regression for large worlds: an unchanged ghost costs about a byte and a moving one roughly 6–10, so one datagram holds about 100–150 moving ghosts per tick. Above that, each ghost updates less often than it did over TCP, even on a clean connection.

Sending several snapshots per tick doesn't work as replication stands, because of how acks work (`net/replication/server.ts`):

- A client acks only the newest snapshot tick it read.
- The server treats an ack of tick T as delivery of everything it sent for T: spawns, despawns, leaves, relayouts, structures, string table entries, and each ghost's state, which becomes that ghost's delta baseline.

With two messages for T, losing the first and acking the second would make the server delta-code later states against baselines the client never received. The client would then fail to decode them ("baseline is gone"), or show wrong values.

## Decision

We will split a tick's snapshot into **parts** when it doesn't fit one datagram. Each part is a complete snapshot of some of the connection's ghosts, and the client acks parts by index.

**Parts.** A snapshot message starts with `varuint part` (0, 1, …), then the existing layout. Each part is self-contained:
- A ghost's spawn, its pending relayout and structure change, and its state travel in the same part. A client never decodes a state in a layout it hasn't read, and never sees a moved ghost's state without its move.
- Strings not yet acked are written inline in every part that uses them (the existing rule), so no part depends on another.
- Despawns and leaves are spread over the parts and repeated, as now, until the part that carried them is acked.

**Budgets.** A part holds at most one datagram body (`NetPeer.datagramBodyBytes`), and a tick holds at most `maxSnapshotBytes` in all, i.e. at most `floor(maxSnapshotBytes / datagram)` parts (60 with the defaults). Without a datagram path (loopback, a plain WebSocket) there's one part of up to `maxSnapshotBytes`, as now.

**Filling the parts.** If the whole snapshot fits one part, it's written once, as now. Otherwise the items go first-fit into the parts (among the newest four, so filling stays linear in the part count), in priority order:
1. despawns and leaves;
2. the pending relayouts and structure changes of spawned ghosts, so they still go out when states are starved, as they do today;
3. ghosts, by the existing priority (unacked spawns first, then the ghosts unsent longest, times their `importance`). A ghost whose relayout or structure change went in a part goes in that same part, or waits for a later tick.

Item sizes come from the last whole write, or from the parts written since (the existing `lastCosts`), with a byte of slack per ghost for its id gap. A part that comes out over budget sheds its lowest-priority ghosts and is written again. A ghost bigger than a whole part still goes, alone; that one message is larger than a datagram, and the transport sends it over the socket (0333). When a tick's parts held every ghost, their total stands in for the whole write's size, so a world that shrinks back under one datagram is written whole again the next tick.

**Acks.** `net.snapshotAck` becomes `varuint tick, varuint count, then the part indexes` (as ascending gaps). The client acks the newest tick it read and every part of that tick it has read so far, so a lost ack is repeated by the next one. The server applies each acked part's record once, keeps the tick's unacked parts in case a later ack names them, and drops records of older ticks. `Connection.lastAckedTick` is the newest tick with any part acked.

**Reading.** The client reads each part of its newest tick once, and every part of a newer tick. A part of an older tick is dropped; the transport already drops unreliable messages older than the newest it delivered.

**Tools.** The Network panel's snapshot size is the tick's total, with the number of parts when there's more than one.

## Alternatives considered

- **Fragmenting one snapshot and reassembling it** (Glenn Fiedler's packet fragmentation). Simpler to fill, but losing any fragment loses the whole tick, which is the problem 0333 avoided. Independent parts lose only their own ghosts.
- **Acking by bitmask.** A mask in one varuint caps a tick at 53 parts, fewer than the 60 the defaults allow. A list of indexes is about as small for the common case of one to a few parts.
- **A separate sequence number per part instead of `(tick, part)`.** It means the same thing, but states are stamped with ticks anyway, and both ends already key their history by tick.
- **Sending big snapshots over TCP** (a per-World choice). It gives large worlds their rate back, but with head-of-line blocking again.

## Consequences

**Positive**
- Over WebRTC, large worlds get the same per-tick budget they had over TCP, and losing a packet delays only the ghosts in it.
- One part, and no extra work, whenever the snapshot fits one datagram, which is every current sample.
- The loopback and plain WebSocket behave as before, apart from the wire changes.

**Negative / costs**
- Wire changes to `net.snapshot` (a part index) and `net.snapshotAck` (a part list). Client and server must run the same engine version, as they already must.
- A tick that splits costs a planning pass on top of the writes. Measured in Node, with 2,000 moving ghosts and one client, the snapshot took about 2.7 ms in 37 parts against about 2.0 ms written whole. Each part also repeats a little: its header, and inline strings not yet acked.
- Parts reordered in the network are dropped by the transport's stale rule, so reordering costs what loss costs.

## Deprecates

0333's cap of one datagram per tick. Its other rules stand, so 0333 is amended, not superseded.

## Open questions

- Should the transport's stale rule apply per message kind, so reordered parts survive? That would change the `unreliable` contract (0033) for every transport.

## References

- `src/engine/net/replication/server.ts`, `client.ts`, `wire.ts`; `src/engine/editor/index.ts` (`netWorldInfo`)
- Glenn Fiedler, "Snapshot Compression" and "Packet Fragmentation and Reassembly" (gafferongames.com)
- Unity Netcode for Entities, snapshot packet size and ghost prioritisation: https://docs.unity3d.com/Packages/com.unity.netcode@1.6/manual/optimizations.html
