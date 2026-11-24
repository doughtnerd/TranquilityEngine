# 0379. The desktop editor listens for the debug link through a native WebSocket server (tungstenite), and the browser editor doesn't listen

- **Status:** Accepted, amended by 0403 (the browser editor is reached by code and WebRTC; listeners also serve the rendezvous)
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0376 (the debug link), 0033 and 0035 (the WebSocket transport and its Node server), 0067 (paths on one port), 0010

## Context

0376 says the editor **listens** for builds (WebSocket on `localhost`, on the LAN when Preferences allow). T60 built the link over the engine's listening `websocket` transport, but only Node registers one (`src/server/websocketServer.ts`). A page can't open a server socket, so neither shipped editor could listen: the desktop editor (Tauri) and the browser editor both said "can't listen here", and no build could connect to them.

`src-tauri`'s dependency tree had no WebSocket implementation: tokio and hyper are there (through Tauri's HTTP stack), but not tungstenite, tokio-tungstenite or axum.

## Decision

We will give the desktop editor a native WebSocket listener and leave the browser editor honest.

- **Crate:** `native/ws-listener` (`myco-ws-listener`), on **tungstenite 0.30** (MIT/Apache-2.0, `default-features = false, features = ["handshake"]`: no TLS, no client URL parsing) and std threads: one thread accepts, one runs each connection (reads with a 5 ms timeout, writes what the page queued in between). It has no Tauri dependency, so `cargo test` runs it anywhere. New crates in `src-tauri/Cargo.lock`: tungstenite, sha1, rand, rand_core, chacha20, data-encoding and their digest helpers.
- **What it does:** bind `host:port` (fails at once with "port 7790 is already in use"), accept upgrades to one path ("/" accepts any, as in 0067; others get 404), and move whole binary messages. Framing (the channel header, sequence numbers), limits and close rules stay in the TypeScript `WebSocketConnection`, the same code the Node server uses. The crate closes a connection itself only for a text message (1003), a message over 16 MiB (1009) or 8 MiB queued unsent (1009).
- **Commands** (`src-tauri/src/debug_link.rs`): `myco_debuglink_listen(host, port, path, events)` → `{ id, port }`, events (accept, message, close, error) as raw bytes on a Tauri channel; `myco_debuglink_send` takes a raw outbox body (sends and closes, in order) with the listener id in a `myco-listener` header; `myco_debuglink_close(id)` frees the port before it returns. A window that listens again on a port it already listens on replaces its old listener (a reloaded page, or a close that arrives after the next listen).
- **Wire format:** binary both ways, so messages never go through JSON: events `[kind u8][connection u32][rest]`, outbox records `[op u8][connection u32][length u32][bytes]` (`native/ws-listener/src/wire.rs`, mirrored in `tauriListener.ts`).
- **TypeScript:** `src/editor/debugLink/tauriListener.ts` subclasses the engine's `WebSocketTransport` (as the Node server does) and registers it as `websocket` with `listen: true`; the editor's `main.tsx` does this under Tauri before the debug link starts, so `EditorDebugLink` runs unchanged. IPC calls go one at a time, in order. Connecting stays the page's own `WebSocket`.
- **Address:** what the debug link asks for: `127.0.0.1`, or `0.0.0.0` with the LAN toggle on (D137).
- **Browser editor:** doesn't listen. Settings and the builds menu say "a browser page can't open a server socket. The desktop editor can." 0376 names no relay; a dev-server relay (the Vite dev server listening and forwarding to the page) would only exist in `npm run dev`, not in a hosted browser editor, so it isn't built.

## Alternatives considered

- **tokio-tungstenite or axum.** tokio is already in the tree, but both still add tungstenite, and an async server needs a runtime and task plumbing for a listener that serves a handful of local connections. Threads are simpler and test without a runtime.
- **A hand-written WebSocket server** (sha1 and base64 are cheap). The handshake, masking, fragmentation and close rules are where bugs live; tungstenite is the standard Rust implementation.
- **A Tauri plugin (`tauri-plugin-websocket`).** It is a client only.
- **JSON events.** Each message would become a JSON number array; raw channel messages arrive as `ArrayBuffer`s.
- **A dev-server relay for the browser editor.** Only useful in development; see above.

## Consequences

**Positive**
- Builds can connect to the shipped desktop editor; the link, accept prompt and builds menu work there as in Node.
- One framing implementation for Node, the desktop editor and clients.

**Negative / costs**
- A new crate dependency (tungstenite) and a thread per connection in the editor process.
- Messages wait up to 5 ms to go out, and every message crosses Tauri's IPC (an `eval` per event for small ones). Fine for a debug link polled every 33 ms; not for game traffic.
- No WebRTC datagram lane on this listener (the Node server offers one, 0333): a build asking for one just stays on the socket.
- The Audio Studio's window doesn't start a debug link yet; when it does, it registers the same transport.

## Deprecates

The "can't listen here" state in the desktop editor. Nothing else.

## Open questions

None.

## References

`native/ws-listener/`, `src-tauri/src/debug_link.rs`, `src/editor/debugLink/tauriListener.ts`, `src/engine/net/transport/websocket.ts`, `src/server/websocketServer.ts`, `docs/design/animation/decision-log.md` D137.
