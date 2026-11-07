# 0102. A link between two Worlds of one page over a transport that can't listen there connects them over loopback

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0033, 0035, 0062, 0067

## Context

A `websocket` bootstrap link (or `WorldHandle.connect(server, "websocket")`) between two Worlds of one Engine makes the server World listen. In a browser the WebSocket transport can only connect, so `Engine.create` failed ("only connect; listening needs the Node server"). A project that wants a dedicated server in production writes `websocket` links for it, then had to switch them to `loopback` to play in the editor or the player page, or keep two bootstraps.

## Decision

We pick **resolve to loopback, with a log**, over failing with a better error.

- `registerTransport(name, factory, capabilities?)` takes `{ listen?: boolean }` (default true); the browser WebSocket transport registers `{ listen: false }`. The Node one (`src/server/websocketServer.ts`) re-registers without it, so it can listen. `transportCanListen(name)` reads it.
- `connectWorlds` (both ends in this process): when the transport can't listen here, it connects them over `loopback` instead, dropping the address options that only meant something to WebSocket (`address`, `port`, `host`, `url`) and keeping the rest (timeouts, interpolation, simulated conditions), and says so once with `console.info`, naming both Worlds and that a dedicated server still listens over WebSocket.
- `WorldHandle.listen("websocket")` in a browser still rejects: there are no in-page clients to fall back for.
- The editor's simulated network conditions (`withConditions` in `src/editor/netPlay.ts`) apply to such links too.

Why: both ends are in the page, so loopback is what the link can only mean there, and it behaves the same (same session, handshake, snapshots); the dedicated server reads the same `project.json` and listens over WebSocket as before. Failing would keep the two-bootstrap problem.

## Alternatives considered

- **Fail with a clearer, actionable error** — honest, but every networked project then needs browser- and server-specific links for no benefit.
- **A WebRTC or BroadcastChannel transport in the page** — more moving parts for two Worlds that share memory.

## Consequences

**Positive**
- One bootstrap plays in the editor, the player and the dedicated server.

**Negative / costs**
- A link that says `websocket` doesn't exercise WebSocket framing or limits in the page; the info line says so.

## Deprecates

The "links between two Worlds of a page must be `loopback`" rule in the multiplayer guide.

## Open questions

None.

## References

`src/engine/net/Transport.ts`, `net/session.ts` (`connectWorlds`), `net/transport/websocket.ts`; tests `src/engine/tests/netSettings.test.ts`, `session.test.ts`.
