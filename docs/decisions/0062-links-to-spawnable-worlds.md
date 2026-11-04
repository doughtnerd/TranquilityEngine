# 0062. Bootstrap links apply whenever both Worlds exist, so they can name Spawnable Worlds (templates)

- **Status:** Proposed
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0032 (links only between start-up Worlds), 0033
- **Related:** 0032, 0033, 0034, 0036

## Context

A declarative bootstrap (ADR 0032) lists start-up `worlds`, `links` between them, and `templates`: named World configs that game code creates later with `Engine.createWorld("Server")`. Links are applied once, after the bootstrap creates its Worlds (`Engine.ts`: `bootstrapLinks`), so both ends must be start-up Worlds. The Worlds panel's link pickers offer only start-up Worlds.

In practice, servers are often created on demand. The Arena sample's menu creates its `Server` template when the player presses Host, then connects to it in a script (`me.connect(server, "loopback")`). The HUD does the same for a second local player (`Client 2`). A user opening the Worlds panel sees a client, two templates and no links, and can't tell how they connect. The owner found "templates" unclear, and expected to see the link.

## Decision

**Links apply whenever both of their Worlds exist.**
- A link names two Worlds, `from` (the client) and `to` (the server), as before.
- It applies when the second of the two comes into existence: at start-up for two start-up Worlds (as today), or when game code creates a World that completes it.
- When a World is created at runtime (`Engine.createWorld`), the Engine checks the bootstrap's links. For each link naming the new World whose other World is alive, the client connects to the server with the link's transport and options, as if the script had called `connect` right after creating it.
- If the server World is destroyed and created again, its links apply again. Destroying a client ends its connection as usual (ADR 0033).

**Links name Worlds, by name.**
- A link end may be a start-up World's name or a template's World name: the template's `name` if it has one, else its key.
- `Engine.createWorld("Server")` creates the World `Server`, which completes links naming `Server`.
- A copy with another name (`createWorld({ ...templates.Match, name: "Match 2" })`) completes only links naming `Match 2`.
- World names are unique within an Engine, so a link always means one pair of Worlds.

**Validation** (`parseBootstrap`, warned at start and shown in the Worlds panel):
- each end must name a start-up World or a template;
- `to` must be a World tagged `server`, and `from` one that can connect, as today;
- a link between two start-up Worlds keeps today's rules.

**In the editor, templates are "Spawnable Worlds".**
- The Worlds panel calls them Spawnable Worlds: Worlds that game code creates when needed, not at start-up.
- Selecting one shows the line of code that creates it (`Engine.createWorld("Server")`, with a copy button) and the project scripts that mention its name.
- The link pickers offer start-up and Spawnable Worlds; links to Spawnable Worlds draw as dashed arrows, applied when that World is created.
- `project.json` keeps the `templates` key and the API keeps `templates`, so nothing in existing projects changes. The docs say "Spawnable Worlds (`templates` in `project.json`)".

**The Arena sample** declares its links (`Client → Server` and `Client 2 → Server` over loopback). Host then just creates the `Server` World, and the HUD just creates `Client 2`. Join still connects to a dedicated server's address in its script (ADR 0036), because that server isn't a World in this Engine.

## Alternatives considered

- **Keep links for start-up Worlds only, and explain runtime connections in the panel.** No format change, but the panel could never show how a project's spawnable servers are wired, and every project repeats the same connect-after-create code.
- **Links that name templates rather than Worlds** (applied to every World created from a template). Copies of a template have different names, so a link to a template could match several live servers. Naming Worlds keeps each link one pair.
- **Rename the `templates` key to `spawnable`**, reading `templates` as an alias. More consistent with the editor, but it changes the file format and the public API for a label. Not worth it yet.
- **A per-link `when` setting** (start-up or on creation). Unneeded: "when both exist" covers both cases.

## Consequences

**Positive**
- **Visible wiring:** the Worlds panel shows how a project's Worlds connect, including servers created on demand.
- **Less boilerplate:** the connect-after-create code moves out of scripts; Arena's Host button becomes one `createWorld` call.
- **Compatible:** existing bootstraps behave as before. A link between start-up Worlds is the same link.

**Negative / costs**
- **Implicit connections:** creating a World can now connect others. A script that also calls `connect` for a linked pair would connect twice; the Engine skips a link whose client is already connected to that server, and warns.
- **Name coupling:** renaming a template's World name breaks links naming it. The panel's rename keeps links in step, as it does for start-up Worlds.

## Deprecates

Nothing.

## Open questions

- Links whose client is a Spawnable World created in another Engine (a dedicated server process): out of scope; those connect by address (ADR 0036).

## References

- `src/engine/core/worlds.ts` (`BootstrapConfig`, `LinkConfig`), `src/engine/core/bootstrap.ts`, `src/engine/core/Engine.ts` (`bootstrapLinks`, `createWorld`), `src/editor/worldsConfig.ts`, `src/editor/ui/WorldsPanel.tsx`, `samples/arena/`.
