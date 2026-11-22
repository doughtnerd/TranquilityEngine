# 0338. Input streams carry a local player index, and server pawns name theirs with `ConnectionPlayer`

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0311, 0337

## Context

ADR 0033's input streams (`defineInput`, `net/input.ts`) carry one input per connection per tick. ADR 0337 made networked action sets into streams, and its first build sent only the first local player's actions. Local co-op over one connection (two pads on one machine, playing online) therefore lost every player but the first.

On the server, a pawn's input is chosen by its owning connection (`Replicated.ownerId`, ADR 0311). With several local players per connection, the pawn must also say *which* of that connection's players drives it. `ControlledBy` can't say this: it names a local player of the World itself. On a host, the server World's own players would then be copied onto remote clients' pawns.

## Decision

**Streams carry a player index.** `InputDef` gains an optional `player` argument, a local player index from 0 to 63 (`MAX_LOCAL_PLAYERS`):
- `write(values, player?)`
- `localOf(player)`
- `of(node, player?)`
- `stats(node, player?)`

Each player has its own client history, server buffer and counters. Leaving it out means player 0, so existing code is unchanged.

**The wire stays byte-identical for player 0.** Another player's packet body starts with a varuint `0`, which is never a valid input count. Then come the player's index (varuint), then the usual count and delta-coded inputs. Receivers drop indices out of range.

**`ConnectionPlayer { index }` on a server pawn** says which of the owning connection's local players drives it; without it, the pawn gets player 0.
- On the client, a pawn's replayed input comes from `ConnectionPlayer`, else its `ControlledBy` player, else 0.
- `ConnectionPlayer` isn't replicated by default. A game that needs it on clients calls `replicate(ConnectionPlayer)`.

**Repeated ticks drop edges.** When the server repeats a tick's input because the real one is missing, the networked action set keeps its values and level flags but clears its edge flags (pressed, performed…). A press is never performed twice.

## Alternatives considered

- **One stream per local player** (`defineInput` ids with a suffix). No wire change, but the handshake's stream list grows with the player count, and games would name streams by player.
- **Put the player index in every packet.** Simpler, but it costs a byte per packet for the common single-player case.
- **Reuse `ControlledBy` on server pawns.** It's ambiguous on a host, as described above.

## Consequences

**Positive**
- Local co-op works online with the same action sets and pawns as offline.
- Single-player traffic and every existing `defineInput` call are unchanged.

**Negative / costs**
- A second wire variant to keep decodable, and a little per-player state on both ends.
- Games doing online local co-op must put `ConnectionPlayer` on server pawns.

## Deprecates

Nothing.

## Open questions

- Whether the lobby (ADR 0033) should announce how many local players a connection brings.

## References

- `src/engine/net/input.ts`, `src/engine/net/messages.ts`, `src/engine/input/inputNet.ts`
- Tests: `src/engine/tests/inputNet.test.ts` (two local players over one connection, per-player streams and stats)
