# 0035. The Node WebSocket server uses the `ws` package

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0015, 0033

## Context

ADR 0033 picks WebSocket as the transport that works everywhere, with dedicated servers running on Node. The client side is free: browsers, Tauri's webview and Node 22+ all have a global `WebSocket` client. Node has no WebSocket server, though, so accepting connections needs either a dependency or our own implementation of the protocol (RFC 6455) on top of `node:http`.

The server code is Node only. It lives in `src/server/`, which nothing under `src/engine/` imports, so whatever it uses never reaches a browser bundle.

## Decision

We will use the [`ws`](https://github.com/websockets/ws) package (v8) for the server side of the WebSocket transport, with `@types/ws` as a dev dependency.

- Only `src/server/` imports `ws`. The browser-safe client (`src/engine/net/transport/websocket.ts`) uses the global `WebSocket`, and engine code never imports `src/server/` or `ws`.
- `ws` is a runtime dependency of the dedicated server (T14), not of games: a game bundle that doesn't include the server never contains it.
- We use only the basics (`WebSocketServer`, binary messages, close codes and reasons), so swapping `ws` for something else later touches one file.

## Alternatives considered

- **Hand-write RFC 6455 over `node:http`.** The upgrade handshake is short, but a correct server also needs frame parsing and masking, fragmentation, control frames interleaved with fragments, ping/pong, the closing handshake and its timeouts, UTF-8 validation, size limits and back-pressure. That's a few hundred lines of security-sensitive parsing that `ws` has already hardened against the Autobahn test suite, for no gain to us.
- **A larger realtime framework (Socket.IO, uWebSockets.js).** Socket.IO adds its own protocol on top of WebSocket, which browser clients would need its client library for. uWebSockets.js is faster but ships native binaries and isn't on npm, which complicates installs and packaging. Neither is needed at our scale.
- **Wait for Node to ship a WebSocket server.** Node has had a client since 22 but no server, and there's no date for one.

## Consequences

**Positive**
- A mature, widely used server (the de facto standard on Node) with no dependencies of its own and no native code, so it installs everywhere Node does and packages simply with the dedicated server.
- Small: tens of kilobytes, pure JavaScript.

**Negative / costs**
- One more runtime dependency to keep updated, and one more package in the supply chain.
- `ws` is Node only, so the server can't run in Deno or Bun without their Node compatibility layers (0033 doesn't target them for now).

## Deprecates

Nothing.

## Open questions

- TLS (`wss://`): terminate it in a reverse proxy for now, or have the dedicated server (T14) accept a certificate. `ws` supports both.
- Compression (`permessage-deflate`) is off by default in `ws`; it costs CPU and memory per connection and snapshot data is small, so it stays off until measured.

## References

- [ADR 0033](0033-server-authoritative-netcode.md), Transports and "Dedicated servers run on Node".
- [RFC 6455](https://www.rfc-editor.org/rfc/rfc6455), The WebSocket Protocol.
- `src/server/websocketServer.ts`, `src/engine/net/transport/websocket.ts`.
