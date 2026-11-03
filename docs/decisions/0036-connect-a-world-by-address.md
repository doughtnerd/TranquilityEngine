# 0036. A client World connects to a remote server by address

- **Status:** Accepted
- **Date:** 2026-11-02
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0032, 0033, 0035

## Context

ADR 0032 gives World handles `connect(otherHandle, transport)`: a client World joins a server World of the same page. ADR 0033 adds dedicated servers in Node (T14, `tranquility-server`). A browser client of a dedicated server has no server World in its page, so `connect(handle, …)` can't reach it. The engine could already do it internally (`connectWorld` in `net/session.ts`, used by tests), but game code couldn't: the multiplayer sample's Join button, and T14's "a Node server and a browser client play the multiplayer sample", had no public API.

## Decision

We will let `WorldHandle.connect` take an address in place of a server handle:

```ts
Engine.findWorld("Client")!.connect("ws://localhost:7777", "websocket");
```

- `connect(server: WorldHandle | string, transport, options?)`. A string is the server's address for that transport (a WebSocket URL; a loopback address name). It's passed to the transport as `options.url` and `options.address`.
- Everything else is as for a handle: the client's `Connection` node appears and becomes `open` over the next frames, the handshake checks versions and definitions, and failures close the connection with a reason.
- A bootstrap `links` entry still names two Worlds of the project. Connecting to a remote address is done at runtime (a menu's Join), since an address usually comes from the player or a matchmaker.

## Alternatives considered

- **A separate `connectTo(address, transport)` method.** Clearer at the call site, but two names for one act; the overload keeps one verb, like Unity's `NetworkStreamDriver.Connect(endpoint)`.
- **A `url` in a link with no `to` World.** Mixes start-up layout with runtime choices, and links are validated as World pairs (ADR 0032).
- **Keep it internal until matchmaking.** Leaves the dedicated server unusable from the browser.

## Consequences

**Positive**
- Browser and Tauri clients can join dedicated servers with public API.

**Negative / costs**
- `WorldHandle.connect`'s parameter is a union; a typo'd World name passed as a string is taken as an address (the connection then fails with the transport's error).

## Deprecates

Nothing.

## Open questions

- A runtime `listen` for server Worlds created from templates (open question O15).

## References

- `src/engine/core/WorldHandle.ts`, `src/engine/net/session.ts` (`connectWorld`), `src/server/server.test.ts`.
