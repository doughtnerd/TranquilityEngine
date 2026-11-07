# 0100. Replication sends each ghost's active flag and parent as a versioned structure, and spawn strings through a per-connection string table

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0067, 0068

## Context

ADR 0033's replication (`src/engine/net/replication/`) sends a ghost's transform and opted-in fields every snapshot, and its spawn (prefab path or scene path, plus its layout spec) until acked. Two things were missing (implementation status, 0033 "Not yet"):

- **Node activity and reparenting.** `setActive(false)` or `setParent` on the server never reached clients. A prefab ghost's parent was fixed in its spawn; a late joiner whose ghost's first parent had despawned never placed it.
- **Strings.** Every spawn repeats its prefab path, scene file, node ids and component ids in full, on every snapshot until acked: a 60-character path costs 60 bytes per spawn per snapshot. Ten tanks of one prefab cost ten copies.

## Decision

**Structure.** Each server ghost has a *structure*: its node's own active flag and its parent, with a `version` (0 at first sight, +1 on each sent tick that finds either changed) and the tick it changed at (`Structure` in `wire.ts`).
- The parent is a `ParentRef`: the World root; a ghost's node, or a node reached by node ids below it (a weapon under a player's "Hand"); a scene-placed node by scene file, occurrence and ids (a "Projectiles" container); or the client's active scene when the server's parent is nothing clients can find (a node from `GameObject.create`; the server warns once per ghost).
- A scene or nested ghost carries no parent until it moves (clients find it where it is). A prefab ghost always carries one: its spawn no longer has a parent of its own.
- **Wire:** a spawn is followed by the ghost's current structure, so a late joiner's ghost spawns under its current parent. After the spawns, a new section lists the structures of acked-spawn ghosts whose newest version the connection hasn't acked, repeated until acked, like despawns, whether or not their state fits the budget.
- **Clients** apply a structure when their interpolation tick reaches its tick (owned predicted ghosts at once), reparent with the local transform kept when the transform replicates (its values are local to the new parent from that tick) and the world transform kept otherwise, hold the last pre-move state until then and drop pre-move states after, so a ghost never interpolates across parents. A parent not there yet is retried each frame.

**String table.** Strings in spawns and structures go through a per-connection table (`StringTableOut`/`StringTableIn`): `varuint 2i+1` and the string defines index `i`; once the client acked a snapshot that defined it, `2i+2` alone; `0` and a string is inline with no index (past 4096 entries). The server marks indexes acked only from the acked snapshot's own record, so a client always has a string before the server refers to it. Both ends start a fresh table per connection.

**Protocol version 4** (`NET_PROTOCOL_VERSION`).

## Alternatives considered

- **Active flag and parent as layout fields** (in the delta-coded state) — states are interpolated and budgeted; a parent is a reference that needs strings and ordering with spawns, and a lost unreliable state would leave it wrong until the next change. A versioned, acked section is the same mechanism spawns already use.
- **A reliable message per change** (like `net.ghostStrings`) — ordering against unreliable snapshots (a move under a ghost not spawned yet, or a state already local to the new parent) is then the client's problem; inside the snapshot it's ordered by construction.
- **A global string table built from the project** (prefab paths known at build time) — needs a build step and breaks for scripts loaded later; per connection is self-contained.
- **Compressing whole snapshots** — doesn't help single small spawns and costs CPU per connection per tick.

## Consequences

**Positive**
- `setActive`, `setParent` and attaching to sub-nodes of ghosts work on clients, timed with interpolation.
- A repeated prefab spawn costs one or two bytes per string once acked (test: a second tank spawn is over 60 bytes smaller).

**Negative / costs**
- Each spawn grows by a few bits (version, tick gap, active, parent); each moved ghost costs its structure until acked.
- Old clients can't talk to new servers (protocol 4).
- A scene ghost moved before a client first finds it is still found by its current id path, which may not exist on the client (unchanged from before).

## Deprecates

The parent fields of prefab spawns (`parent`, `parentNode` in `SpawnInfo`), replaced by the structure's parent.

## Open questions

- Enabled state of individual components isn't replicated (only the node's own active flag).
- Ghosts' sibling order isn't replicated.

## References

`src/engine/net/replication/wire.ts`, `server.ts`, `client.ts`; tests `src/engine/tests/replicationStructure.test.ts`.
