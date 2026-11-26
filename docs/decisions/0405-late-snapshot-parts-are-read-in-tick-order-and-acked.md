# 0405. Late snapshot parts are read in tick order and acked

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0334 (reading parts, acks), 0402 (stale parts)
- **Related:** 0033, 0121, 0333, 0398

## Context

0334 splits a tick's snapshot into datagram-sized parts. A ghost whose state alone is bigger than a datagram still goes, alone, in a part over a datagram, which the WebSocket transport sends by its slower reliable path (0333). 0398 stopped the transport dropping that part when a newer datagram overtook it. 0402 moved spawns and other lifecycle events to a reliable message, leaving parts with states only.

The replication client still dropped such a part in two ways:

- **Older than the newest tick read.** On a link where the next tick's datagrams overtake the stream every tick, every big part arrived after a newer tick and was dropped.
- **Older than the newest lifecycle message.** 0402 dropped any part older than the newest lifecycle message applied, in case it held a ghost that message despawned, took away or relayouted. In a game that spawns something every tick, a lifecycle message arrives every tick, so every late part was dropped this way too.

The server never got an ack for those parts, so the ghost's baseline (0334) stayed at its spawn state. Every later state then differed from it in every changed field, stayed over a datagram, and was dropped again. The ghost froze at its spawn state, even after its changes stopped (0402's open question).

## Decision

We will read a late part, file its states in tick order, and ack it.

**Reading (client).**
- A part is read when its tick is no older than the newest tick read minus `BASELINE_WINDOW` (the server keeps that many ticks' records), and it isn't a part already read of that tick. Parts read are kept per tick for the window.
- Staleness is decided per ghost, not per message. A part is stale if one of its ghosts is gone, or was spawned or relayouted at a tick after the part's (its `layoutTick`), or got a structure change after it. Such a part can't be decoded in the right layout, or shown in the right place.
- A part is taken whole or not at all. Its ghosts are decoded into a staging list first. A stale part, or a late part whose baseline the client has already dropped, is dropped whole and not acked, keeping nothing. So everything an ack names is kept, which is what the server's baselines rely on.
- States are filed in tick order in each ghost's states (a tick already there is kept). Interpolation then uses them as it does any state. A late state never replaces a newer shown one; it only fills the history.
- A part that can't be stale (not older than the newest tick read or the newest lifecycle message) and is still wrong is an error, as before.

**Acks.** `net.snapshotAck` becomes `varuint lifecycle tick, varuint tick count`, then per tick `varuint part count`, the first part index and the gaps between the rest. The ticks are the newest snapshot tick read, then older ticks that got a late part, each as the gap back from the one before. A late tick is repeated by the next `LATE_ACK_REPEATS` (4) acks, so one lost ack doesn't lose it. An ack names at most `MAX_ACK_TICKS` (16) ticks.

**Baselines (server).** The server accepts an ack of an older tick while it still has that tick's record. A part's states become baselines only where they're newer than the ghost's baseline, as before, so a baseline never goes back. Records are no longer dropped when a newer tick is acked; they're kept for `BASELINE_WINDOW` ticks, each part's until it's acked.

**Protocol.** The net protocol version goes from 6 to 7.

**Safety net.** A part that never arrives at all needs no new path. A baseline older than `BASELINE_WINDOW` isn't used (0334), so the server then sends the ghost's full state, which the client reads once it arrives within the window. A ghost can only stay stuck if the stream lags more than `BASELINE_WINDOW` ticks (about four seconds at 60 Hz), where the connection is effectively gone. A full-state refresh over the lifecycle message was considered for that case and left out.

## Alternatives considered

- **Refresh over the reliable lifecycle message.** When a ghost's oversize part isn't acked for a few ticks, send its full state as a lifecycle event, which becomes the baseline once acked. Simpler, and it can't break baselines. But the client throws away the late per-tick parts between refreshes, so the ghost updates in steps every few ticks instead of every tick. Chosen against by the owner in favour of using every tick's data.
- **Fragment one ghost's state across datagrams.** Losing any fragment loses the state, which 0334 rejected.
- **Keep 0402's per-message staleness rule.** It starves late parts in any game with lifecycle traffic every tick.

## Consequences

**Positive**
- A ghost whose state changes by more than a datagram every tick keeps updating, a little behind, and catches up when its changes stop.
- Lifecycle traffic every tick no longer starves late parts.
- Baselines stay sound: the client keeps everything it acks, and the server never moves a baseline back.

**Negative / costs**
- Wire change to `net.snapshotAck` (protocol 7). Client and server must run the same engine version, as they already must.
- The client keeps which parts it read for `BASELINE_WINDOW` ticks, and the server keeps unacked part records for that window even after newer acks.
- A late part stale for one of its ghosts is dropped for all of them. Parts over a datagram hold one ghost, so in practice it's that ghost's own update.

## Deprecates

0402's rule that a snapshot part older than the newest lifecycle message is dropped (replaced by the per-ghost rule), and 0334's rule that only the newest tick's parts are read and acked.

## Open questions

- None new. 0402's open question about late state parts is answered here.

## References

- `src/engine/net/replication/client.ts` (`receive`, `read`, `fileState`, `ClientGhost.layoutTick`), `server.ts` (`run`'s ack reading, `acked`), `wire.ts` (`MAX_ACK_TICKS`), `net/session.ts` (protocol version 7)
- `src/engine/tests/replicationParts.test.ts`, "late state parts are read in tick order (ADR 0405)": a ghost whose every change is over a datagram keeps updating and never goes back; lifecycle messages every tick don't starve it; late parts from before a relayout are dropped and it converges after.
