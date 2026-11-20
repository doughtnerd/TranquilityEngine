# 0256. One bootstrap topology says which World plays which network role, for the server, play mode and the Worlds panel

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0032 (Worlds and bootstraps), 0033 §8–9 (dedicated server, multiplayer play), 0062 (links to Spawnable Worlds), 0068 (lobbies), 0236 (one launch: the server's filtering stays in `run.ts`), 0245 (World handles stay closed)

## Context

Play mode and the dedicated server worked out World roles from a declarative bootstrap separately:

- `src/server/run.ts` (`serverBootstrap`) kept the Worlds tagged `server` (`tags ?? DEFAULT_WORLD_TAGS`); with none, it ran the server templates, preferring lobby ones, and split the links into server links, listen links and spawn links.
- `src/editor/netPlay.ts` (`hostLayout`) found the Host pattern with `find`, so **only the first** server template, and `tags ?? []`; `clientLayout` found the client Worlds play copies.
- The Worlds panel (`worldsConfig.ts`, `lobbyLinks`) had its own "is a server" test, and showed nothing about which Worlds the server starts.

With two server templates (and no lobby) the dedicated server started both while play's Host pattern created only the first: the same project ran different Worlds in play and on the server.

## Decision

We will classify a declarative bootstrap once, in `src/engine/core/bootstrapTopology.ts` beside `bootstrap.ts`, and have the server, play mode and the Worlds panel read it.

- **`bootstrapTopology(setting)`** returns, for a declarative bootstrap (null for none or a code bootstrap): the start-up `servers`; the `serverTemplates` as Spawnable Worlds named as `Engine.createWorld` names them, and the `lobbies` among them; the **Host template** and the start-up client World it pairs with (`hostClient`); `serverStart` (the Worlds a dedicated server starts) and `skipped`; `serverLinks`, `listenLinks` and `spawnLinks`; play's `linkedClients` and `copiedClient`; and `startUpLinked`. `isServerConfig` is the one "tagged server" test.
- **Two server templates:** the Host template is the **first** `server`-tagged template (in `project.json` order), when no start-up World is a server and no template is a lobby. Play creates it up front with its client copies linked to it, and the dedicated server starts it and only it; the other server templates stay Spawnable Worlds that game code creates by name, and links to them say where they listen once created (ADR 0062). A Host button creates one server, so starting every server template on the dedicated server ran Worlds no client could reach by the play layout.
- **What the server starts:** the start-up servers, else every lobby (ADR 0068: a lobby makes its own match Worlds), else the Host template. Play's Host pattern also needs no link between two start-up Worlds (with one, play copies the linked clients instead).
- **Readers:** `run.ts` builds its filtered bootstrap from `serverStart`, `serverLinks`, `listenLinks`, `spawnLinks` and `skipped` (the call stays in `run.ts`, per 0236); `netPlay.ts`'s `clientLayout` and `hostLayout` read `copiedClient`/`linkedClients` and `hostTemplate`/`hostClient`; the Worlds panel badges the Host template ("Host") and the other Worlds the server starts ("on server") through `serverRoles` in `worldsConfig.ts`, and `lobbyLinks` uses `isServerConfig`.
- **The code-bootstrap stub stays:** a code bootstrap can't be classified without running it, so `run.ts` still runs it against a filtering `BootstrapEngine` whose skipped Worlds get an inert handle (`skippedWorld`) that records `connect` as a listen link. `WorldHandle` has no inert or recording implementation to reuse (0245 keeps handles closed), so the stub remains the one place that knows it.

## Alternatives considered

- **Start every server template on the server and in play** — play would need a rule for which server each client copy joins, and a Host button never creates two servers.
- **Keep the logic in each caller and add a test that compares them** — the rules would still drift; the review found three spellings of "tagged server" already.
- **Classify code bootstraps by running them against a recording Engine** — would remove the stub, but runs game code twice (once to classify, once for real) with side effects.

## Consequences

**Positive**
- Play mode and the dedicated server start the same Worlds for the same bootstrap; one suite (`engine/tests/bootstrapTopology.test.ts`) holds the rules.
- The Worlds panel shows which World the dedicated server starts and which template is the Host one.

**Negative / costs**
- A project with two or more server templates and no start-up server or lobby now runs only the first on the dedicated server (the others start when its code creates them). No sample is laid out that way.

## Deprecates

- The classification in `serverBootstrap` (`isServer`, the template and link filters), the bodies of `clientLayout` and `hostLayout`, and the `tags ?? []` server test in `lobbyLinks`: replaced by the topology.

## Open questions

None.

## References

- `src/engine/core/bootstrapTopology.ts`, `src/server/run.ts`, `src/editor/netPlay.ts`, `src/editor/worldsConfig.ts`, `src/editor/ui/WorldsPanel.tsx`
- Tests: `engine/tests/bootstrapTopology.test.ts`, `server/server.test.ts` (the Host template), `editor/netPlay.test.ts`, `editor/worldsConfig.test.ts` (server roles)
- Architecture review 2 (2026-11-20), card 7
