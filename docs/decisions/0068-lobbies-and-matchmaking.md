# 0068. Lobbies and matchmaking: a lobby server World hands players to match Worlds it creates

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0032, 0033, 0034, 0036, 0062, 0067

## Context

Netcode (0033) joins one client World to one server World. A game that has players find each other, wait in a room, pick settings and then play needs more. The multiplayer guide lists "matchmaking and lobbies (v2)" as not built. The first game that needs this is King of Pirates: rooms of up to 8 ships, an arena choice, quick match, and bots in empty slots.

There are also gaps on the data side. RPC and replicated fields are numbers only (`f32`, `i32`, `u8`) and behavior fields replicate numbers and booleans, so a lobby can't send player names or room codes. The codec already has `writeString`/`readString` (`net/codec.ts`).

## Decision

**Shape.** A **lobby** is a server World with the lobby service turned on. Clients join it through a hidden **lobby client World** that the engine manages. When a room starts, the lobby creates a **match World** from a server template (0062) and has it listen (0067). Each player's page then creates a match client World from a client template and connects it there. When the match ends, the match Worlds are destroyed and the players are back in their room. Game menus run in an ordinary World and read the lobby's state, which they poll (0017: no events).

**Server: turning it on.** `"lobby": { ... }` on a server World in the bootstrap or a template, or `Lobby.host(world, options)` in code. Options:
- `matchTemplate`: the server template for matches (required).
- `clientTemplate`: the client template players use (sent to clients).
- `maxPlayers` (default 8), `minPlayers` (default 1), `fillWithBots` (default false).
- `startCountdown`: seconds after everyone is ready (default 3).
- `settings`: allowed room settings and their choices, e.g. `{ "arena": ["bay", "open", "maze"] }`, with defaults.
- `quickMatchWait`: seconds a quick-match room waits for more players before starting with bots (default 10).

**Rooms.** A room has an id, a 5-letter join code, a name, `public`, a host (the first player; passed on when the host leaves), up to `maxPlayers` members each with a name, a slot index and a ready flag, and string settings from the allowed choices. Members ready up. The host may change settings, kick members and start early once `minPlayers` is met. Otherwise the room starts when every member is ready, after the countdown. **Quick match** joins the fullest public room in the lobby that's waiting with matching settings, or makes one. That room starts on its own after `quickMatchWait`.

**Starting a match.** The lobby creates a World from `matchTemplate`, named `Match <id>`, and listens at `path: /match/<id>` over the lobby's transport (loopback in a page, WebSocket on `myco-server`). It gives each member a one-time ticket and sends them the address, the ticket and `clientTemplate`. In the match World, `Match.current` returns:
- `roomId` and `settings`.
- `players`: one per slot. Each has a `slot`, a `name`, `bot: boolean` and a `connectionId` (0 until that player's connection opens, and for bots). When `fillWithBots` is set, empty slots up to `maxPlayers` are bots, named by the game through `Match.current.players[i].name`.
- `end(results?)`: closes the match. Results are a string map passed back to the room, e.g. the winner.

A connection whose handshake doesn't carry a valid ticket for that match is refused. If no player connects within 30 s, or every human has left, the match ends.

**Client API.** `Lobby` is static and page-wide, so it's usable from any World:
- `Lobby.connect(address | "local", profile: { name })`. `"local"` creates the lobby server World in this page over loopback, from the project's lobby World config, for single-player and hot-seat play. Returns at once.
- `Lobby.state`: `"offline" | "connecting" | "lobby" | "room" | "starting" | "match"`, plus `Lobby.error` (the last refusal or disconnect reason).
- Lists and snapshots: `Lobby.rooms` (public rooms: code, name, member count, settings), `Lobby.room` (members, ready flags, host, settings, countdown), `Lobby.me` (my slot and whether I'm the host).
- Actions: `quickMatch(settings?)`, `createRoom({ name, public, settings })`, `joinRoom(code)`, `leaveRoom()`, `setReady(ready)`, `setSetting(key, value)` (host only), `kick(slot)` (host only), `start()` (host only).
- In a match: `Lobby.matchWorld` is the match client World, and `Lobby.leaveMatch()` leaves it. When the match World is created, the page stops rendering other Worlds that render to the screen (they're paused, not destroyed) and switches back when the match ends.
- `Lobby.disconnect()`.

**Strings on the wire.** Lobby messages use the codec's strings internally. For games, data schemas and RPCs get a `str` field type, with a UTF-8 length-prefixed value capped at 255 bytes. Behavior fields `@field(String, { replicate: true })` replicate whole values when they change. Replicated data-component storage stays numeric: `str` is for RPCs only and isn't allowed in `defineComponent` (registration throws).

**Headless.** The lobby and match servers run in `myco-server` and in pages. The client side needs no rendering. Its state is plain data that tests can poll.

## Alternatives considered

- **A third-party backend (Nakama, Colyseus, PlayFab).** Mature, but it means another server to run and another protocol beside 0033, and Colyseus brings its own state sync. A lobby is small enough to build on the netcode we have.
- **Lobby and match in one World.** Fewer Worlds, but several matches would share one simulation, and the scene would have to hold every arena. Worlds already give isolation (0032).
- **The client World reconnects from lobby to match.** Saves a World, but the client World's scenes, systems and timeline belong to the match. A separate hidden lobby World keeps the menu alive during a match and keeps the "one connection per client World" rule.

## Consequences

**Positive**
- Quick match, private rooms with codes, ready-up, host settings and bots, in a page and on the dedicated server, with one API.
- Strings in RPCs and behavior fields help every networked game (names, chat, codes).

**Negative / costs**
- Matchmaking means one lobby process. Several lobby servers, skill rating, regions and parties are out of scope.
- No reconnect into a running match after a disconnect. The player goes back to the room.
- Tickets only stop casual joins. They aren't authentication.

## Deprecates

- "Matchmaking and lobbies (v2)" under the multiplayer guide's known gaps.

## Open questions

- Persistent player identity and accounts.
- Spectators.
- Joining a match in progress (`Match.current.players` would need to grow).

## References

- `src/engine/net/session.ts`, `src/engine/net/messages.ts`, `src/engine/net/codec.ts`, `src/server/run.ts`
- 0067 (runtime listen, one port by path)
