# 0067. Server Worlds can listen at runtime, and several share one WebSocket port by path

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0032, 0033, 0035, 0036, 0062

## Context

A server World starts listening only when a bootstrap link names it (`connectWorlds` in `net/session.ts`), or when `myco-server` creates it at start (`src/server/run.ts`). Open question O15: a server World created at runtime from a template, such as a match World on the dedicated server, can't listen. `WorldHandle` has `connect` but no `listen`, and `run.ts` logs "clients can't connect to it".

Matchmaking (0068) needs exactly that: one process runs a lobby World and creates a match World per game. Opening a new port per match is awkward behind firewalls and reverse proxies. `NetSession.listen` already takes a `path` in its address (`ws://0.0.0.0:7777/match`), but each `NodeWebSocketTransport` opens its own `ws` server, so two Worlds can't share a port.

## Decision

- **`WorldHandle.listen(transport, options?)`** makes a World a server and starts listening. It returns a `Promise<string>` that resolves to the address clients connect to (`ws://host:7777/match-3`, or a loopback address) and rejects with a reason. Options are a link's listen options (`port`, `host`, `path`, `address`, `maxConnections`, timeouts). It can be called once per transport and address. It throws if the World is a client. `WorldHandle.addresses()` lists where a World listens.
- **One port, many paths.** The Node WebSocket transport keeps a page-wide (process-wide) table of HTTP servers by `host:port`. A listener with a path joins the existing server for its port, and upgrade requests are routed by URL path to the World listening there. An unknown path is refused with HTTP 404. The server closes when its last path stops listening, which happens when the World is destroyed (its transports already close then).
- **Loopback** listens at runtime too: a path just makes the address unique (`loopback://Engine/Match 3`).
- **The dedicated server** serves Worlds created at runtime. `run.ts` no longer logs them as unreachable. A World made from a template listens only when code calls `listen` (the lobby does, 0068). `--port` is the default port for every runtime `listen` that doesn't give one, so all matches share the lobby's port.
- **Browsers** still can't listen over WebSocket. `listen("websocket")` in a browser rejects with that reason.

## Alternatives considered

- **A port per match.** Simplest code, but it needs a port range opened in firewalls and proxies, and makes `wss://` through a proxy one rule per port.
- **One transport for every World, routing by a handshake field.** Saves the path parsing, but the handshake is per session and versioned (0033). Routing before the handshake keeps sessions unaware of each other.

## Consequences

**Positive**
- O15 is resolved. Matches, instances and shards can be created on demand on one port.
- A reverse proxy needs one rule for the whole server.

**Negative / costs**
- A shared HTTP server is process-wide state. Tests must close Worlds so ports are released, as they already do.

## Deprecates

- The "created at runtime; the dedicated server only listens for the bootstrap's server Worlds" log line in `run.ts`.

## Open questions

- Authentication per path (a match token). 0068 checks a ticket in the match World instead.

## References

- `src/engine/net/session.ts` (`NetSession.listen`, `connectWorlds`), `src/server/websocketServer.ts`, `src/server/run.ts`, `src/engine/core/WorldHandle.ts`
- Open question O15 in `docs/architecture/open-questions.md`
