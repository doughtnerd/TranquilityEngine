# 0398. Each WebSocket path numbers its unreliable messages on its own, so a message too big for a datagram is never dropped as stale

- **Status:** Accepted
- **Date:** 2026-11-24
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0333)
- **Related:** 0033, 0333, 0334

## Context

0333 gives every unreliable message on a negotiated connection one 32-bit sequence number, shared by both paths, and the receiver drops a message that isn't newer than the newest it delivered, "whichever path it came by". It also promises that a message too big for a datagram "is late, but never lost to fragmentation": it goes over the WebSocket instead.

The two rules conflict. With the data channel open, a tick's snapshot parts (0334) go out as datagrams N−1, N+1, … and a part bigger than one datagram (a ghost bigger than a whole part, which 0334 sends alone) goes over the socket as N. The socket is TCP, so N is slower, and much slower after a lost segment. When datagram N+1 arrives first, N is stale and the receiver drops it. The server repeats an unacked spawn every tick, and every tick it can be overtaken the same way, so a large spawn can fail tick after tick (`deliverSequenced` in `src/engine/net/transport/websocket.ts`).

The owner preferred to split such messages into fragments sent over the data channel and reassembled, reusing the code that already splits messages into 64 KiB fragments. No such code exists: nothing in `src/engine/net/`, `src/server/` or their git history fragments or reassembles messages. The WebSocket transport's only 64 KiB figure is its unreliable backlog limit, and replication's is the snapshot budget; the browser's data channel (SCTP) fragments internally, which is what 0333 avoids. With nothing to share, fragmentation would be new code, and it would bring back the loss multiplication 0333 and 0334 rejected: a 2 KB part in two fragments under 2% loss is lost about 4% of the time, a 50 KB one in 46 fragments about 60%. So the owner's fallback applies.

## Decision

We will give **each path its own sequence space**. On a negotiated connection:

- Datagrams carry the data channel's own sequence numbers, and socket frames with flag `0x04` the socket's own. Each end keeps a next number to send and a newest number delivered per path.
- The receiver drops an unreliable message that isn't newer than the newest delivered **from the same path** (serial-number arithmetic, as before). A socket frame is never compared with datagrams, so one overtaken by datagrams sent after it is delivered, late. TCP keeps socket frames in order, so in practice none of them is stale.
- A datagram's number is taken only when the datagram is handed to the channel, so a datagram dropped for a backed-up channel leaves no gap. (Gaps were harmless before and still would be.)
- The wire format doesn't change: the frame layouts and flags are 0333's. Only the meaning of the numbers does. Client and server must run the same engine version, as they already must.

This replaces 0333's "whichever path it came by". Its other rules stand, so 0333 is amended, not superseded.

## Alternatives considered

- **Fragments over the data channel, reassembled under the message's sequence number** (the owner's preferred option). There is no existing fragmenter to reuse (see Context), and new fragmentation multiplies loss with message size, which 0333 and 0334 rejected. A message that fails to fit a datagram is the rare case (one ghost bigger than ~1 KB), and TCP delivers it every time.
- **Exempting only oversize socket frames, on a new header flag.** The same effect for the oversize case, but a new flag, and a small message sent over the socket while the lane is opening or after a failed send would still share the datagrams' numbers. Two spaces by path cover every socket frame with no wire change.
- **Accepting the drop and rewording 0333** (Q16's option b). Leaves large spawns failing on lossy links, which is the bug.

## Consequences

**Positive**
- A message too big for a datagram arrives, as 0333 promised, however datagrams overtake it.
- No wire change and no new state beyond one counter pair per path.

**Negative / costs**
- The transport's `unreliable` promise (a message that arrives isn't older than one already delivered) now holds per path, not per connection: a socket message can arrive after a newer datagram. Replication tolerates this. The client reads every part of its newest tick once, whatever order they come in (0334), and inputs are keyed by tick on the server. But replication still drops a part of a tick **older** than the newest it has read, so a socket part delayed past the next tick's first datagram is dropped there and resent next tick; on a clean link the oversize part arrives within its own tick.
- When the lane opens mid-stream, the last socket messages before it can arrive after the first datagrams and are delivered late instead of dropped.

## Deprecates

0333's single sequence space "shared by both paths". The `websocket.ts` header comment and 0333's row in the decision index are updated.

## Open questions

- Should replication read an older tick's part when it only spawns ghosts the client doesn't have yet, so a spawn delayed past a tick boundary isn't resent? That is 0334's open question about per-kind stale rules, from the replication side.

## References

- `src/engine/net/transport/websocket.ts` (`PathSequence`, `send`, `deliverSequenced`)
- `src/engine/tests/webrtcTransport.test.ts` ("unreliable messages too big for a datagram (ADR 0398)": a fake peer connection whose lane opens without a network)
- Glenn Fiedler, "Packet Fragmentation and Reassembly" (gafferongames.com)
