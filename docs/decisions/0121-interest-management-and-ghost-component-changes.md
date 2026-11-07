# 0121. Snapshots carry only ghosts relevant to each connection (by distance and group), and replicate components' enabled state, sibling order and components added or removed after spawn

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0068, 0100, 0101

## Context

ADR 0033's replication (`src/engine/net/replication/`) sends every ghost to every open connection. Under the byte budget (`maxSnapshotBytes`, ADR 0101) ghosts are ordered by `importance` × ticks unsent, but nothing filters them: a big map sends far-away enemies and another team's private markers to everyone, costing bandwidth and leaking information. ADR 0033 lists relevancy as "Not yet" and asks "per-connection relevancy by distance, or explicit groups?".

Three smaller gaps, from 0033's status row and 0100's open questions:

- **Enabled state.** `component.enabled = false` on the server never reaches clients (0100 replicates only the node's own active flag).
- **Sibling order.** Clients' children come in spawn order, not the server's order.
- **Late components.** A ghost's layout is fixed when first seen; a replicated data component or a behavior with replicated fields added later is never sent, and one removed keeps its last values on clients.

## Decision

**Relevancy.** A ghost is sent to a connection only while it's *relevant* to it:
- `net.Replicated` gets two fields: `relevantDistance` (world units; 0, the default, means everywhere) and `group` (`""`, the default, means none).
- A ghost passes its own filter for a connection when the connection owns it (`ownerId`), or when its group is `""` or one the connection is in, **and** its `relevantDistance` is 0 or its world position is within that distance of one of the connection's viewpoints.
- A ghost is relevant when it **and every ghost above it** (its parent ghost chain, which includes a nested ghost's root) pass their filters, so children leave with their parent and a client never gets a ghost whose parent it can't find.
- **Viewpoints:** the node set with `Interest.setViewer(connection, node)`, or by default the world positions of the root ghosts the connection owns (its player). A connection with neither sees only ghosts with no distance limit.
- **Hysteresis:** a relevant ghost stays relevant until it's 10% beyond its distance, so a ghost at the edge doesn't spawn and despawn every tick.
- **Groups:** server code calls `Interest.join(connection, "red")`, `Interest.leave(connection, "red")`, `Interest.groups(connection)`. A ghost has at most one group; a connection can be in many. Owner-only ghosts use a group per player (`"player:3"`).
- `Interest.isRelevant(connection, node)` says whether a ghost is currently sent to a connection (server).
- Computed with per-ghost checks each sent tick (~64k distance tests for 1000 ghosts × 64 connections, well under a millisecond); a spatial grid can come later behind the same API.
- Relevancy filters first; `importance` then orders the relevant ghosts under the budget as before.

**Entering and leaving.** A ghost that becomes irrelevant to a connection goes in a new snapshot section, **leaves**, repeated until acked, like despawns. The client destroys a prefab ghost it instantiated and *deactivates* a scene-placed or nested ghost (it can't make those again), and forgets its states and strings. On re-entry the server sends a fresh spawn (with the ghost's current structure, layout and, on the reliable string channel, all its string fields) and full states; a leave not yet acked is cancelled. A scene ghost destroyed on the server while out of relevance is still despawned on that connection, so the client doesn't keep a dead node deactivated.

**Enabled state.** A ghost's structure (ADR 0100) gains the list of its layout's behaviors (components with replicated fields; `Replicated` itself excluded) that are disabled, by component id and index, through the string table. Clients set those components' `enabled` when they apply the structure (at the interpolation tick). Only components in the layout are touched; other components stay the client's business. An empty list costs one bit-padded varuint.

**Sibling order.** The structure gains `after`: the ghost id of the nearest ghost before it among its siblings, or 0 when no sibling ghost comes before it. Clients move the node right after that ghost's node (or before the first sibling ghost). Ordering among ghosts only, so destroying a non-ghost sibling changes nothing and destroying a ghost changes one neighbour. Like the parent, a scene or nested ghost carries "unspecified" until its order changes. When the ghost before it isn't on the client (irrelevant, not spawned yet), the order is left alone.

**Late components.** Each sent tick the server checks whether a ghost's components or data components changed (an identity comparison of the lists), and if its layout spec changed, bumps its `layoutVersion`:
- Spawns carry the layout version; a new **relayouts** section (after spawns) carries the version and spec of acked-spawn ghosts whose newest layout the connection hasn't acked, repeated until acked.
- Baselines from an older layout are dropped, so states after a relayout are sent whole until one in the new layout is acked; both sections precede states, so a client always reads a state with the layout it was written in.
- Clients rebuild the binding: data components the new layout adds are added (as before), behaviors it adds are added when their class is registered and allowed in the World, and components the old layout had and the new one doesn't are removed (data components, and behaviors from the last index of a class). States from before are dropped (no interpolation across a relayout); prediction restarts for the ghost.
- "Replicated" components only: data components marked with `replicate()` and behaviors with replicated fields. Adding or removing other components isn't replicated.

**Protocol version 5** (`NET_PROTOCOL_VERSION`). Snapshot order: baseline, despawns, leaves, spawns (+ layout version, structure), relayouts, structure changes, states.

## Alternatives considered

- **A per-ghost callback (`relevantTo(connectionId)`)** — fully custom, but code rather than data (nothing for the Inspector), a call per ghost per connection per snapshot, and easy to make inconsistent with parent ghosts. The fields cover distance, teams and owner-only; a custom filter can be added later.
- **A uniform grid** — faster past ~10k ghosts but more code and a cell-size setting; per-ghost checks are cheap at the sizes the engine targets (64 connections).
- **Several groups per ghost** — more flexible, but one group plus the owner rule covers teams, private objects and rooms; a list can be added later without breaking one.
- **Deactivate instead of destroy prefab ghosts that leave** — keeps nodes and their scripts alive on clients that will never see them updated, and a long session accumulates them.
- **Enabled flags in the state record** (a bit per behavior) — states are unreliable, budgeted and interpolated; the structure is acked and timed already.
- **Sibling index** — any non-ghost sibling added or removed on the server (projectiles under a container) would shift every later ghost's index and resend all of them.
- **Replicating every behavior's add/remove/enabled** — server-only scripts would need `worlds` to stay off clients, and traffic grows with components clients don't need.

## Consequences

**Positive**
- Large maps and team games send each connection only what it should see; hidden objects aren't on the wire at all.
- Ghosts enter and leave cleanly, with spawns, structure and strings resent on re-entry.
- `enabled`, child order and components added or removed at runtime now match the server.

**Negative / costs**
- Distance relevancy uses the server's world positions each sent tick (a matrix read per distance-limited ghost).
- A scene ghost out of relevance stays on the client deactivated, with its last values.
- A ghost re-entering costs a whole spawn and full state again.
- Sibling order is only relative to other ghosts; non-ghost siblings may still sit in a different order.
- Old clients can't talk to new servers (protocol 5).

## Deprecates

Nothing. (0033's "all ghosts to every connection" becomes the default case: no distance, no group.)

## Open questions

- A spatial grid for very many ghosts; per-connection send rates (0101).
- Relevancy-scaled priority (closer ghosts sent more often) on top of `importance`.
- A custom relevancy filter function.

## References

`src/engine/net/interest.ts`, `net/replication/server.ts`, `client.ts`, `wire.ts`, `strings.ts`, `net/Replicated.ts`; tests `src/engine/tests/replicationInterest.test.ts`; guide `docs/guide/multiplayer.md`.
