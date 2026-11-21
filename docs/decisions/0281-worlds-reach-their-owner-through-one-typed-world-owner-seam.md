# 0281. Worlds reach their owner through one typed World-owner seam, and lobbies follow the bootstrap topology

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0032 (the Engine owns Worlds), 0062 (links to Spawnable Worlds), 0067 (Worlds listen at runtime), 0068 (lobbies), 0132 (`Component.world`), 0255 (listen targets, per-Engine defaults), 0256 (bootstrap topology)

## Context

`World._engine` was typed `unknown`, and every module that needed the World's owner declared its own slice of `Engine` and cast to it:

- `net/lobby/wire.ts` had an 8-member `LobbyEngine` (with optional `_worldConfig?`, `_viewStates?`, `_handView?`) and `engineOf`, which duck-typed `createWorld` and `_world`.
- `net/session.ts` cast to `{ _world? }` to tell a destroyed World, and kept two `WeakMap`s keyed by the opaque engine: `listenDefaults` (ADR 0255) and `engineNumbers` (loopback name prefixes).
- `net/replication/server.ts` cast to `{ _worldConfig? }`; `core/Component.ts` to `{ _handleOf? }`.
- **Which bootstrap declares the templates** was decided three times: `Engine.resolveConfig` (`typeof options.bootstrap === "object"`, which let `null` through to a crash), `wire.ts`'s `declaredBootstrap` (reading `engine.options` through a cast), and `Engine.create`.
- **Lobby discovery drifted from ADR 0256.** `Lobby.connect("local")` ran any template with `lobby`, tagged `server` or not, while the bootstrap topology (and so the dedicated server) counts only `server`-tagged templates as lobbies, and starts them only when no start-up World is a server. A page could host a lobby the dedicated server never starts, and nothing reported it.

## Decision

We will give Worlds one typed owner interface in core and move every caller onto it.

- **`WorldOwner`** (`src/engine/core/worldOwner.ts`, `@internal`, not exported from `myco`): `createWorld`, `_createFromTemplate(template, name)`, `_declaredBootstrap`, `findWorld`, `worlds`, `_world(name)`, `_handleOf(world)` (null once destroyed: that is "alive"), `_worldConfig(name)`, `_destroyWorld`, `_linkedServer`, `_listenDefaults(transport)` / `_setListenDefaults(transport, defaults)`, `_loopbackPrefix`, `_viewStates`, `_handView`. `WorldViewState` moves there (re-exported from `Engine.ts`). The interface the handle used (`WorldOwner` in `WorldHandle.ts`) is this one.
- **`World._owner: WorldOwner | null`** replaces `World._engine: unknown`. `Engine implements WorldOwner` and sets it when it creates a World. A test can hand a World a fake owner (`engine/tests/worldOwner.test.ts`).
- **Callers:** the lobby client and server, the session (destroyed check, loopback prefix, listen defaults), replication (a World's `replication` config), `Component.world` and the dedicated server (`engine._setListenDefaults`) use the owner. `LobbyEngine`, `engineOf`, `declaredBootstrap` and `setListenDefaults` are deleted, and so are the two session `WeakMap`s keyed by engine. A small map remains for Worlds with no owner (made directly, in tests): their loopback prefix is `world-N`.
- **The declared bootstrap is decided once**, in the `Engine` constructor: the declarative bootstrap passed to `Engine.create`, else `project.json`'s when it is declarative, else null (a `null` or code bootstrap option falls through to `project.json`). Templates (`createWorld("Match")`, a lobby's match and match client Worlds) and lobby discovery read it. Which bootstrap *runs* is still `options.bootstrap ?? project.json`'s, as before.
- **The lobby is the topology's.** `BootstrapTopology` gains `serverLobby` (the first World the dedicated server starts that has a `lobby` config) and `lobbyProblems`. `Lobby.connect("local")` uses an existing lobby World of this Engine, else creates `serverLobby`; with none it fails with the first lobby problem. So a page runs the lobby the dedicated server would.
- **Lobbies no server would run are bootstrap problems.** `validateBootstrap` reports `lobbyProblems` (so the Worlds panel shows them and `Engine.create` and the dedicated server refuse the bootstrap): a `lobby` config on a World or template not tagged `server`, and a `server`-tagged lobby template when start-up servers exist (the server starts only those), unless a start-up World has the template's name (the dedicated server's own filtered bootstrap starts the lobby template that way).

## Alternatives considered

- **Keep structural slices, typed once in `wire.ts`** — still a cast per module and an interface net code owns for a core object; replication, session and `Component` would keep their own.
- **Type `World._engine` as `Engine`** — a value import cycle (`Engine` imports `World`), and tests would need a whole Engine to stand in.
- **Make `Lobby.connect("local")` keep running any lobby template** — contradicts 0256: the same project would host lobbies in a page that its dedicated server never starts.
- **Warn instead of refusing a lobby the server wouldn't run** — `validateBootstrap` has no warning channel, and a lobby that only exists in single-player is a configuration mistake the editor should show as one.

## Consequences

**Positive**
- One interface lists what a World's owner offers; the compiler checks every caller, and the `as never` casts are gone.
- The declared-bootstrap rule is written once; a `null` bootstrap option no longer crashes template lookup.
- Single-player lobbies and the dedicated server run the same lobby World; misplaced lobby configs are reported.
- Session and replication behaviour can be tested with a fake owner instead of an Engine.

**Negative / costs**
- A bootstrap with an untagged lobby template, or a lobby template beside start-up server Worlds, is now invalid. No sample is laid out that way (Pirates' `Lobby` template is `server`-tagged and there are no start-up servers).
- Loopback names for ownerless Worlds change from `engine-N` to `world-N` (only tests make such Worlds).

## Deprecates

- `World._engine`, `LobbyEngine`, `engineOf`, `declaredBootstrap` (`net/lobby/wire.ts`), `setListenDefaults` and the `listenDefaults`/`engineNumbers` `WeakMap`s (`net/session.ts`), `lobbyConfig` (`net/lobby/client.ts`): removed. ADR 0255's "`WeakMap` keyed by the Engine" becomes owner state; ADR 0132's "through `World._engine`" becomes `World._owner`.

## Open questions

None.

## References

- `src/engine/core/worldOwner.ts`, `Engine.ts`, `World.ts`, `WorldHandle.ts`, `Component.ts`, `bootstrapTopology.ts`, `settings.ts` (`validateBootstrap`)
- `src/engine/net/session.ts`, `net/replication/server.ts`, `net/lobby/{client,server,wire}.ts`, `src/server/run.ts`
- Tests: `engine/tests/worldOwner.test.ts`, `engine/tests/bootstrapTopology.test.ts`, `engine/tests/lobby.test.ts`
- Architecture review 6 (2026-11-21), card 2
