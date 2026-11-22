# 0323. The dedicated server listens through one operation, which the link applier tells when a linked World appears

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0062 (links to Spawnable Worlds), 0067 (runtime listen, path routing), 0068 (lobbies), 0238 (the link applier; amended here), 0255 (listen targets), 0256 (bootstrap topology), 0311 (the net session answers net questions)

## Context

"A World named in a link has appeared, act on it" was done in two places. The Engine's link applier
(`core/linkApplier.ts`, ADR 0238) connects a link when `createWorld` makes one of its Worlds. The dedicated
server (`src/server/run.ts`) had its own copy for its links from client Worlds it skips to server templates
(ADR 0062): `spawnedListener` walked `engine.worlds()` after every step looking for new ones.

Listening itself was written twice around `listenOptions`: the start-up loop and `spawnedListener` each did the
transport check, the "no port" and "port in use" wording (the `EADDRINUSE` mapping twice), and the logging, and
they drifted (a non-WebSocket link was reported in different words at start-up and at runtime, and the
runtime "in use" message had no hint).

And there was a race (confirmed by a test). `spawnedListener` took "game code already listens" as
`handle.addresses().length > 0`, but `addresses()` leaves out listeners still starting, and a Node WebSocket
listen finishes asynchronously. A lobby calls `handle.listen` right after `createWorld` in the same step
(`net/lobby/server.ts`), so after that step the World had no address yet and the server listened a second
time, where the link said: the match World ended up with two sockets.

## Decision

**The link applier tells, the server doesn't poll.** `LinkApplier.watch(links, act)` (behind the internal
`Engine._watchLinks`) calls `act(world, link)` for each World created at runtime that one of `links` names as
its server (`to`). It calls it at the start of the next frame (`beginFrame`, which replaces `retryDeferred`
and still retries deferred links first), not inside `createWorld`: by then the code that created the World
has run on, so a lobby's own `listen` is already under way. A World destroyed before then is skipped; a
throwing `act` is logged. The applier stays the one place that notices linked Worlds appear.

**One server listen.** `serverListen(world, link, kind, cli, log)` in `run.ts` is the only way the server
listens, for the start-up server Worlds (`kind` `"first"`, which `--port` applies to, or `"start-up"`) and for
templates created at runtime (`"runtime"`, from the watch). It:

- asks the World's network session whether it listens **or is starting to** (`session.listens()`, internal;
  it counts listeners before their address is known), and leaves it alone if so;
- notes a non-WebSocket link, works out the options from the listen target (`listenOptions`, ADR 0255), and
  logs "isn't listening" when there's no port;
- listens, mapping `EADDRINUSE`/"already listened on" and `EACCES` to one `ServerError` wording each, with the
  right hint (`--port` for the first World, the link's port otherwise).

Start-up awaits it and stops the server on its error; the runtime watch logs the error. The start-up loop
logs "listening on"; a runtime World's listen is logged by the connection watcher, as before.

**Tests.** `server.test.ts` creates a lobby-style World at runtime through the Engine (a project script
creates the template and listens on it in one step) and checks it listens exactly once;
`tests/linkApplier.test.ts` covers `watch` with plain Worlds.

## Alternatives considered

- **Keep polling, check `listensAt` instead of `addresses()`** — fixes the race but keeps the second
  "a World appeared" mechanism and the per-step walk over every World.
- **Act inside `createWorld`** — the server would listen before the lobby's own `listen` on the next line,
  so the match World would still get two listeners (or the lobby's `listen` would throw "already listens").
- **A public `WorldHandle.listening` flag** — a public API change for a question only the server asks; the
  session already answers net questions about a World (ADR 0311).

## Consequences

**Positive**
- One place for the listen rules and messages; start-up and runtime use the same checks and words.
- The double listen is gone; no per-step walk over the Worlds for listening.
- `LinkApplier` covers the server's links with the same rule as its own: act once a linked World exists.

**Negative / costs**
- A runtime World's server listen starts when the next frame begins rather than right after the frame that
  created it: the same point between frames, one timer tick later in wall time.
- Code that listens on a linked template later than the frame that created it (from a scene script that
  loads afterwards) still gets the server's listen too; such a template shouldn't have a link from a client.

## Deprecates

`spawnedListener` and `runLoop`'s `afterStep` (`run.ts`) and `LinkApplier.retryDeferred`: removed
(`beginFrame` replaces the last).

## Open questions

None.

## References

- `src/server/run.ts` (`serverListen`, `listenOptions`), `src/engine/core/linkApplier.ts` (`watch`,
  `beginFrame`), `src/engine/core/Engine.ts` (`_watchLinks`), `src/engine/net/session.ts` (`listens`).
- Tests: `src/server/server.test.ts`, `src/server/lobbyServer.test.ts`, `src/engine/tests/linkApplier.test.ts`.
