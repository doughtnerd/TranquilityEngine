# 0255. One listen target says where a World listens, from the transport, the options and the host's overrides

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033 §8 (the dedicated server), 0062 (links to Spawnable Worlds), 0067 (runtime listen and path routing; its link options now hold on the dedicated server), 0068 (lobbies)

## Context

Where a server World listens was worked out three times, with two precedence rules:

- `src/server/run.ts` (`listenOptions`, `linkAddress`) built an address string from a link's `address`, else `port`, else `url` — ignoring the link's `host` and `path` — under `--port` and `--host`.
- `src/engine/net/session.ts` (`listenAddress`) let `address` win outright, then `port`/`host`/`path`, then a **process-wide mutable map** (`listenDefaults`, set by `setDefaultListenOptions`) that the server runner set after start-up and cleared on close.
- `src/server/websocketServer.ts` parsed the string back (`parseListenAddress`), and the lobby (`net/lobby/server.ts`, `matchListenOptions`) parsed its own listener's address again by hand.

The result was a bug: on the dedicated server a link `{ port: 7777, path: "/game", host: "127.0.0.1" }` listened at `/` on every interface, although ADR 0067 documents `host` and `path` as listen options.

## Decision

We will work out a **listen target** once, in `src/engine/net/listenTarget.ts`, and have every caller read it.

- **The target:** `listenTarget(transport, options, host?)` returns `{ transport, host?, port, path, address }`, or null when a network transport has no port from anywhere. `address` is the normalised string the transport listens at: `"7777"`, `"7777/game"` (no host: every interface), `"ws://127.0.0.1:7777/game"`, or a loopback name.
- **One precedence, field by field:** the host's `overrides` (the dedicated server's `--host` for every World, `--port` for its first), then the options' `address` (all of it), then the options' `port`, `host` and `path`, then the port and path of the options' `url` (a client's address, which also says where its server is), then the host's `defaults`. Loopback addresses are names: an `address` or `port` (with its path) as given, else a name made up per World, or per Engine plus the path.
- **Overrides are passed in, not process state:** the runner passes `--port`/`--host` as `overrides` (deciding itself which World is first, and that the first falls back to port 7777). The shared port for Worlds created at runtime (a lobby's matches, ADR 0067) is a default **per Engine** (`setListenDefaults(engine, transport, defaults)`, `@internal`, a `WeakMap` keyed by the Engine), so two Engines in one process (tests, an editor beside a server) don't share it and nothing needs clearing on close.
- **Callers:** the session's `listen`/`listensAt` (`worldListenTarget`), the runner's `listenOptions` (start-up and spawned Worlds), and the lobby's match options (`parseListenAddress` on its listener's address). The Node WebSocket transport imports `parseListenAddress` from the module; its own copy is removed.

## Alternatives considered

- **Fix `linkAddress` in `run.ts` only** — closes the bug but keeps two precedence rules and the global map, so the next option (say `maxConnections` per path) drifts again.
- **Pass a structured target through `Transport.listen`** — cleaner for the transport, but the transport interface takes an address string (ADR 0033) and third-party transports implement it; the normalised string carries the same information.
- **Keep the defaults process-wide** — simplest, but it's state tests must reset and two Engines in one process would share a port default.

## Consequences

**Positive**
- A link's `host` and `path` work on the dedicated server, as ADR 0067 says (`server.test.ts`).
- The precedence rule is one pure function with a table test (`engine/tests/listenTarget.test.ts`).
- No process-wide listen state.

**Negative / costs**
- A link with only a client `url` now gives its port to in-process listens (play mode) as it already did on the dedicated server.
- A host-less listen with a path now binds every interface including IPv6 (`7777/game`), where the runner used to bind `0.0.0.0` only.

## Deprecates

- `setDefaultListenOptions` and the process-wide `listenDefaults` map in `session.ts`, `pathOption`/`listenAddress` there, `linkAddress` in `run.ts` and `parseListenAddress` in `websocketServer.ts`: removed (`parseListenAddress` moved to `listenTarget.ts`).

## Open questions

None.

## References

- `src/engine/net/listenTarget.ts`, `src/engine/net/session.ts`, `src/server/run.ts`, `src/server/websocketServer.ts`, `src/engine/net/lobby/server.ts`
- Architecture review 2 (2026-11-20), card 3
