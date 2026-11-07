# 0101. A server World's snapshot rate and budget are set by `replication` on its World config

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0032, 0033, 0062

## Context

Replication's `sendRate` (snapshots per second) and `maxSnapshotBytes` (the per-snapshot budget, 64 KiB) existed only as an internal `configureReplication(world, …)` used by tests. Games couldn't lower the snapshot rate to save bandwidth or fit snapshots under a path MTU.

## Decision

We add `replication?: { sendRate?, maxSnapshotBytes? }` to `WorldConfig` (public type `ReplicationSettings`), so it works for start-up Worlds, templates (Spawnable Worlds) and `Engine.createWorld({…})`. Validation (`validateBootstrap`): an object with only those keys; `sendRate` a positive number; `maxSnapshotBytes` a whole number ≥ 256. A server World's replication reads them when it starts (`ServerReplication`'s constructor, through `Engine._worldConfig`). A snapshot goes every `round(tickRate / sendRate)` ticks. Ignored on Worlds that aren't servers.

## Alternatives considered

- **Link options** — the setting belongs to the server, not each link; two links to one server would disagree.
- **A runtime method on `WorldHandle`** — every implementation (the dedicated server's stub handles too) would grow; none of the samples need runtime changes. Can be added later.
- **Project-wide setting** — servers in one project (a lobby and its matches) may want different rates.

## Consequences

**Positive**
- Declarative, validated, and the dedicated server honours it (it runs the same configs).

**Negative / costs**
- Not editable at runtime; the Worlds panel doesn't edit it yet (it keeps it).

## Deprecates

Nothing (`configureReplication` stays internal for tests).

## Open questions

Per-connection send rates (thin clients, spectators).

## References

`src/engine/core/worlds.ts`, `core/settings.ts`, `net/replication/server.ts`; tests `src/engine/tests/netSettings.test.ts`.
