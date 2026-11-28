# 0471. One unreliable sequence for transports, and the session names a node's connection

- **Status:** Accepted
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0121, 0311, 0333, 0398

## Context

Every transport numbers its unreliable messages so a receiver drops one that isn't newer than the newest it delivered
(latest-wins, 0333). The knowledge was copied:

- `webrtc.ts` and `websocket.ts` each had an identical `newer(a, b)` (serial number arithmetic over u32), their own
  next-number code (`sendSeq`/`(seq + 1) >>> 0`; `nextSeq(path)`), their own `SEQUENCE_BYTES = 4`, and wrote and read
  the big-endian u32 header by hand with `DataView` (five places).
- `loopback.ts` compared with plain `<=` from −1, with no wrap.

Separately, "the connection a node stands for" — its own if it is a connection node, else the one that owns it by
`Replicated.ownerId` — was written twice, identically: `input/inputNet.ts` `connectionNode` and `net/input.ts`
`connectionOf`.

## Decision

We will number unreliable messages through `src/engine/net/transport/sequence.ts`:

```ts
const SEQUENCE_BYTES = 4;
function writeSeq(buf: Uint8Array, at: number, seq: number): void; // u32, big-endian (the existing wire format)
function readSeq(buf: Uint8Array, at: number): number;
function withSeq(seq: number, data: Uint8Array): Uint8Array<ArrayBuffer>; // the number, then data
class UnreliableSequence {
  peek(): number;               // the next number to send, not taken (a send that may not go)
  next(): number;               // take it: 0 first, wrapping after 2³² − 1
  accept(seq: number): boolean; // first one yes; then only newer across the wrap (up to 2³¹ − 1 ahead); becomes newest
}
```

Scope stays the transport's: WebRTC keeps one per connection (0333, whichever channel carries the message), WebSocket one
per path (0398: socket and datagram lane), loopback one per connection end. The wire format and protocol versions don't
change.

We will ask the session for a node's connection: `NetSession.connectionOf(node): NetPeer | null`, beside `ownerPeer`
(`peerOf(node) ?? ownerPeer(Replicated ownerId)`). Input streams (`net/input.ts`) and action-set networking
(`input/inputNet.ts`) call it.

`Interest` (`net/interest.ts`) keeps its own lookup: it asks a different question — "which **open server** connection
is this connection node", by its `net.Connection` id, throwing for anything else. Passing a ghost to `Interest.join`
must be an error, not resolve to the ghost's owner as `connectionOf` would.

## Alternatives considered

- **A free `newer(a, b)` function only** — removes one copy but leaves the next-number arithmetic, the "first is always
  newer" rule and the header encoding in each transport.
- **Fold `Interest`'s lookup into `connectionOf`** — wrong answer for a ghost or a closed connection (see above).

## Consequences

**Positive**
- One serial-number rule and one header encoding for every transport; loopback now wraps like the others.
- One ownership-to-connection rule for both input paths, in the session that owns the ownership rule (0311).
- Tests: `transport/sequence.test.ts` (wrap-around, staleness, the 2³¹ window, big-endian at any view offset). Wrap
  isn't driven through a transport: that takes 2³² sends. The transports' existing specs cover the per-path behaviour.

**Negative / costs**
- Behaviour change on purpose: loopback compares with serial arithmetic. Unobservable unless a connection sends 2³¹
  unreliable messages.
- `session.ts` now imports `Replicated` (which imports the session back); the session uses it only at call time.

## Deprecates

`newer`, `nextSeq`, `PathSequence`, `encodeDatagram` and the per-file `SEQUENCE_BYTES` in `webrtc.ts`/`websocket.ts`;
loopback's `unreliableSent`/`newestUnreliable`; `inputNet.ts`'s `connectionNode` body and `net/input.ts`'s
`connectionOf`: removed.

## Open questions

None.

## References

`src/engine/net/transport/sequence.ts`, `src/engine/net/session.ts`.

## As built

As above.
