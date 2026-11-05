# Multiplayer

Multiplayer in Myco Engine is a layout of [Worlds](worlds.md). The server simulates the game in a World tagged `server`. Each player runs a World tagged `client` that sends its input and draws what the server sends back. A **link** joins a client World to a server World over a **transport**. The same project runs hosted (server and client in one page), as a dedicated server in Node, or in the editor with several clients.

The model follows Unity's Netcode for Entities: the server is authoritative, it simulates at fixed ticks, nodes it replicates are called **ghosts**, clients interpolate other players and predict their own. The design is in [ADR 0033](../decisions/0033-server-authoritative-netcode.md). This guide is about using it.

> **Sample.** `samples/arena/` is a small multiplayer game that uses everything below. Open it from the editor's start screen and use **Host**, **Add local player** or **Join**, or run its dedicated server with `npm run server -- samples/arena`.

## Client and server Worlds

A minimal `project.json` bootstrap for a hosted game:

```json
"bootstrap": {
  "worlds": [
    { "name": "Client", "tags": ["client"], "scenes": ["scenes/arena.scene.json"] },
    { "name": "Server", "tags": ["server"], "scenes": ["scenes/arena.scene.json"] }
  ],
  "links": [{ "from": "Client", "to": "Server", "transport": "loopback" }]
}
```

Both Worlds load the same scene. What differs between them is decided per system and per component, by tags:

- Systems run where their `worlds` filter matches. The default filter is `["default", "local"]`, which matches **neither** `client` nor `server`, so give every multiplayer system a filter: `["server"]` for game rules, `["client"]` for reading the keyboard, `["client", "server"]` for shared or predicted code.
- GameBehaviors run in every World whose scene has them. Keep server-only logic out of clients with `@behavior("game.EnemyAI", { worlds: ["server"] })`, and client-only effects out of the server with `{ worlds: ["client"] }`. See [Components per World](worlds.md#components-per-world).
- A server World doesn't render unless its config says `renders: true`. The client World gets the screen and input.

Client and server must agree on everything sent between them: protocol version, tick rate, RPCs, input streams and replicated layouts. Both load the same scripts, so they do. The handshake checks and refuses a mismatched client with a reason.

## Links and transports

A link names its client (`from`), its server (`to`), a transport and optional settings:

```json
{ "from": "Client", "to": "Server", "transport": "loopback", "options": { "latencyMs": 50, "interpolationMs": 100 } }
```

| Transport | Where | Notes |
| --- | --- | --- |
| `loopback` | In one page or process | No real network. Options `latencyMs` (one way), `jitterMs` and `loss` (0 to 1) simulate a bad connection. Reliable messages are delayed by a loss, never dropped. |
| `websocket` | Browser and Tauri clients; Node servers | Options `port` (where a Node server listens) and `url` (where a client connects, e.g. `"ws://localhost:7777"`). Browsers can only connect; only Node can listen. Unreliable messages share the TCP stream: a lost packet holds them up rather than dropping them. They're dropped only when the socket's send buffer backs up. |

Settings any link takes:

- `interpolationMs`: how far behind the newest snapshot a client draws other ghosts. Default 100.
- `commandSlack`: how many ticks early a client's input aims to reach the server. Default 2.
- `handshakeTimeoutMs` (default 5000) and `idleTimeoutMs` (default 15000): a connection that doesn't finish its handshake, or goes quiet, is closed.
- `maxConnections`: clients a server World accepts at once. Default 64.
- `address`: where the server listens. Loopback makes one up per Engine and server World.

Because browsers can't listen, a link between two Worlds in a browser page must use `loopback`. The dedicated server listens over WebSocket whatever the link says (see [below](#the-dedicated-server)).

### Connecting at runtime

A client World can join a server World while the game runs, for example when a menu's **Host** button creates them:

```ts
import { Engine } from "myco";

const server = Engine.createWorld({ name: "Server", tags: ["server"], scenes: ["scenes/arena.scene.json"] });
const client = Engine.createWorld({ name: "Client", tags: ["client"], scenes: ["scenes/arena.scene.json"] });
client.connect(server, "loopback", { interpolationMs: 100 });
```

`connect` returns at once; the connection opens over the next frames. A World can be a client or a server, not both, and a client has one connection.

To join a server in another process, such as a [dedicated server](#the-dedicated-server), pass its address instead of a World (ADR 0036):

```ts
Engine.findWorld("Client")!.connect("ws://localhost:7777", "websocket");
```

### Listening at runtime

A server World created at runtime starts listening with `listen` (ADR 0067), as a link's server does:

```ts
const match = Engine.createWorld({ ...matchConfig, name: "Match 3" });
const address = await match.listen("websocket", { path: "/match/3" }); // "ws://localhost:7777/match/3"
match.addresses(); // where it listens
```

- Options are a link's listen options: `port`, `host`, `path`, `address`, `maxConnections` and the timeouts. `listen` resolves with the address clients connect to and rejects with a reason. It throws if the World is a client, or already listens there.
- **One port, many paths.** In Node, Worlds that listen over WebSocket on the same port share it, each at its own `path`; connections are routed by the URL's path and an unknown path gets HTTP 404. A World alone at `/` on its port still takes every path. The port closes when its last World is destroyed.
- On the [dedicated server](#the-dedicated-server), a `listen` without a port uses the server's port, so every match shares the lobby's port and a reverse proxy needs one rule.
- Over loopback, a `path` just makes the address unique.
- Browsers can't listen over WebSocket; `listen("websocket")` there rejects, saying so.

### Connection nodes

Connections aren't events. Each one is a node with a `net.Connection` data component (`Connection` in code), which the engine creates and destroys:

- A server World has one node per accepted client, `open` from the first frame you see it.
- A client World has one node for its connection: `connecting`, then `open` once the server accepts it.
- When a connection closes, its node is `closing` for the rest of that frame and then destroyed.

| Field | Meaning |
| --- | --- |
| `id` | The connection's id, 1, 2, … per server World. The client's node has the same id as the server's node for it. 0 on a client until accepted. |
| `state` | A `ConnectionState` value: `connecting`, `open` or `closing`. |
| `rtt` | Smoothed round-trip time in ms. |
| `lastAckedTick` | The newest snapshot tick the client has acknowledged. |

"A player joined" is a query. This server system gives each new connection a player:

```ts
import { Connection, ConnectionState, GameObject, Replicated, defineSystem } from "myco";

const players = new Map<number, GameObject>(); // assumes one server World in the page

defineSystem({
  name: "game.SpawnPlayers",
  phase: "update",
  worlds: ["server"],
  query: [Connection],
  run(rows) {
    for (const row of rows) {
      const c = row.node.getData(Connection)!;
      if (c.state === ConnectionState.open && !players.has(c.id)) {
        const player = GameObject.instantiate("prefabs/player.prefab.json");
        player.getBehavior(Replicated)!.ownerId = c.id;
        players.set(c.id, player);
      } else if (c.state === ConnectionState.closing && players.has(c.id)) {
        GameObject.destroy(players.get(c.id)!);
        players.delete(c.id);
      }
    }
  },
});
```

Destroying a connection node on the server kicks that client.

## Ticks and time

Networked Worlds simulate in fixed ticks. Clients and servers must use the same tick rate (`tickRate`, or the project's `time.fixedDeltaTime`). `Time.network` (also `this.time.network` and `ctx.time.network`) is set on a networked World and undefined elsewhere:

| Field | Server | Client |
| --- | --- | --- |
| `tick` | Fixed steps since its network session started | The same, for the client |
| `serverTick` | `tick` | The server tick it's predicting: its estimate of the server's tick, plus RTT/2, plus the command slack |
| `interpolationTick`, `interpolationFraction` | `tick`, 0 | The tick other ghosts are drawn at: the newest snapshot that should have arrived, minus `interpolationMs` |
| `rtt` | 0 (each `Connection` has its own) | Smoothed round-trip time in ms |
| `tickRate` | Fixed ticks per second | The same |

Clients ping 10 times a second to keep the estimate. Neither client tick goes backwards while connected; each new connection starts the client's timeline afresh.

## RPCs

An RPC is a reliable one-off message, declared with `defineRpc`. Sending queues it; it goes at the end of the frame. The receiving World reads what arrived as rows, each tagged with the connection node it came from:

```ts
import { defineRpc, defineSystem, u8 } from "myco";

export const ChooseTeam = defineRpc("game.ChooseTeam", { team: u8 });
export const TeamChosen = defineRpc("game.TeamChosen", { team: u8 });

// A client asks (to the server by default):
ChooseTeam.send({ team: 1 });

// The server answers the client that asked:
defineSystem({
  name: "game.Teams",
  phase: "update",
  worlds: ["server"],
  run() {
    for (const m of ChooseTeam.read()) TeamChosen.send({ team: m.team }, m.connection);
  },
});
```

- `send(values, to)`: `to` is `"server"` (a client's default), `"all"` (a server's default), a connection node, or a list of them. Fields are numbers (`f32`, `i32`, `u8`), as in data components, or strings (`str`): UTF-8, at most 255 bytes (`send` throws for a longer one). `str` is for RPCs only; `defineComponent` and `defineInput` refuse it.

  ```ts
  import { defineRpc, str, u8 } from "myco";
  export const Chat = defineRpc("game.Chat", { team: u8, text: str });
  Chat.send({ team: 1, text: "Ahoy!" });
  ```
- `read()` returns what arrived for the phase it's called in: in `fixedUpdate`, what arrived for that fixed step; in `update` and `lateUpdate`, what arrived this frame. Each phase sees each message once.
- `send` throws in a World that isn't networked.
- Both ends must define the same RPCs with the same fields.

## Replication

The server sends the state of its ghosts to every client about once per tick, in unreliable snapshots compressed against what each client last acknowledged. Unchanged ghosts cost about a byte.

### Making a node a ghost

Add a `net.Replicated` component to a prefab's root (and to any node inside it that should also replicate), or to a node placed in a scene. Its fields:

| Field | Default | Meaning |
| --- | --- | --- |
| `mode` | `"interpolated"` | `"predicted"`: the owning client predicts it (see [Prediction](#prediction)). |
| `ownerId` | 0 | The owning connection's `id`. 0: the server owns it. The owner sends input for it. |
| `importance` | 1 | Priority when a snapshot is full. |
| `replicateTransform` | true | Send its local position, rotation and scale. |

On the server, game code sets `ownerId` and `mode`. On clients, read them. `Replicated` also has `ghostId`, `isGhost` (true on clients for nodes the server drives), `isOwnedLocally` and `isPredictedLocally`.

### What's sent

- The transform, unless `replicateTransform` is false.
- Data components marked with `replicate()`, on both ends:

  ```ts
  import { defineComponent, f32, replicate } from "myco";

  export const Health = defineComponent("game.Health", { current: f32, max: f32 });
  replicate(Health, { encoding: { current: { quantize: 0.1 } } });
  ```

  `fields` limits which fields are sent (default: all), `encoding` sets per-field quantization, and `predicted` lists fields the owner predicts.

- Behavior fields declared with `replicate`:

  ```ts
  import { GameBehavior, behavior, field } from "myco";

  @behavior("game.Score")
  export class Score extends GameBehavior {
    @field(Number, { replicate: true }) points = 0;
    @field(Number, { replicate: true, quantize: 0.01 }) charge = 0;
    @field(Boolean, { replicate: true }) alive = true;
  }
  ```

  Numbers, booleans and strings replicate. `quantize` rounds a number to a step before sending, to save bandwidth. A `String` field (`@field(String, { replicate: true }) captain = ""`) is sent whole, reliably, when it changes (capped at 255 bytes), not in every snapshot, so it suits names and labels rather than values that change every tick.

What a ghost sends is fixed when the server first sees it. Components added later aren't sent.

### Prefab ghosts and scene ghosts

- **Prefab ghosts.** When the server instantiates a prefab whose root has `Replicated` (`GameObject.instantiate` or `this.instantiate`), clients instantiate the same prefab, by path, under their active scene, or under the ghost that's its parent on the server. Destroying it on the server destroys it on clients.
- **Scene ghosts.** A node placed in a scene matches the same node in the client's copy of that scene, by scene and node id. Clients don't spawn these; they wait until they've loaded the scene.
- A replicated node made with `GameObject.create`, or inside an instance whose root isn't replicated, can't be found on clients. The server skips it and warns once.

### Interpolation

Clients draw ghosts they don't predict at `interpolationTick`, between the two snapshots around it: positions are interpolated, rotations slerped, integers snap. If snapshots stop arriving, ghosts extrapolate for up to 250 ms and then hold. Raise the link's `interpolationMs` for smoother motion on lossy links, at the cost of seeing others further in the past.

## Inputs

Player input is a per-tick stream, declared with `defineInput`. The client writes it every fixed tick. Each packet repeats the last few ticks (`redundancy`, default 3), so a lost packet loses nothing. The server applies each input at the tick it was written for.

```ts
import { Input, defineInput, defineSystem, f32 } from "myco";

export const Move = defineInput("game.Move", { x: f32, y: f32 });

defineSystem({
  name: "game.ReadMove",
  phase: "fixedUpdate",
  worlds: ["client"],
  run() {
    Move.write({
      x: (Input.getKey("d") ? 1 : 0) - (Input.getKey("a") ? 1 : 0),
      y: (Input.getKey("w") ? 1 : 0) - (Input.getKey("s") ? 1 : 0),
    });
  },
});
```

- Client: `Move.write(values)` sets some of this tick's fields; the rest keep last tick's values. `Move.local` is the same input as a writable view. Both throw in a server World.
- Server: `Move.of(node)` is the input for the tick being simulated, from `node`'s connection. `node` is a connection node or a ghost whose `ownerId` names a connection. If a tick's input hasn't arrived, the newest earlier one is used and counted. `Move.stats(node)` gives `received`, `repeated` and `late`.
- On a client, `Move.of(node)` returns its own input for its connection node or a ghost it owns.
- `Move.of` returns null in a World that isn't networked, so offline play needs its own path to input.

## Prediction

Interpolated ghosts lag behind by RTT/2 plus `interpolationMs`. For the player's own character that feels slow, so the owning client can **predict** it: run the movement code itself, ahead of the server, and correct it when snapshots disagree.

1. Make the ghost predicted: `"mode": "predicted"` on its `Replicated`, with `ownerId` set to the client's connection id.
2. Say which values are predicted: the transform (if replicated), data-component fields in `replicate(def, { predicted: [...] })`, and behavior fields declared `@field(Number, { predicted: true })` (which implies `replicate`).
3. Move them in a `predicted` system that runs on both ends:

```ts
import { Transform, defineComponent, defineSystem, f32, replicate } from "myco";
import { Move } from "./input";

export const Player = defineComponent("game.Player", { speed: f32, vx: f32, vy: f32 });
replicate(Player, { predicted: ["vx", "vy"] });

defineSystem({
  name: "game.MovePlayers",
  phase: "fixedUpdate",
  predicted: true,
  worlds: ["client", "server"],
  query: [Transform, Player],
  run(rows, ctx) {
    for (const row of rows) {
      const input = Move.of(row.node);
      if (!input) continue;
      const p = row.node.getData(Player)!;
      p.vx = input.x * p.speed;
      p.vy = input.y * p.speed;
      row.transform.position.x += p.vx * ctx.dt;
      row.transform.position.y += p.vy * ctx.dt;
    }
  },
});
```

On the server, and in Worlds that aren't networked, a predicted system runs like any other. On a client:

- Its rows are only the ghosts this client predicts.
- It runs once per predicted tick (`serverTick`), so a fixed step may run it more than once (catching up) or not at all.
- When a snapshot differs from what the client predicted for that tick, the client rolls the ghost back to the server's state and runs the predicted systems again for every tick since, with each tick's recorded input. Small corrections blend the drawn position over 100 ms; jumps over 2 units snap.

So keep predicted systems deterministic and have them change only their rows' predicted values. Two helpers:

- `isResimulating()`: true while the client re-runs ticks after a correction. Skip one-off effects (sounds, particles) then.
- `predictedTick()`: the tick being simulated, including replayed ones. -1 in a World that isn't networked.

GameBehaviors aren't predicted or re-simulated. They run once per frame as usual and see the corrected state.

## The dedicated server

`myco-server` runs a project's server Worlds headless in Node and has them listen over WebSocket:

```sh
npm run server -- path/to/project
npm run server -- path/to/project --port 9000 --max-connections 16
```

| Flag | Default | Meaning |
| --- | --- | --- |
| `--port N` | The first server World's link port, else 7777 | Port for the first server World. 0 picks a free one. |
| `--host H` | All interfaces | Interface every server World binds. |
| `--max-connections N` | 64 | Clients each server World accepts at once. |
| `--tick-rate N` | The fastest server World's tick rate | Engine steps per second. Each World still simulates at its own tick rate. |
| `--stats-interval S` | 60 | Seconds between stats lines; 0 turns them off. |

What it runs:

- It reads `project.json`, the JSON assets (scenes, prefabs) and every script under `scripts/`, so your components, systems, RPCs and inputs are registered. Images and audio aren't loaded.
- From a declarative bootstrap it creates only the Worlds tagged `server`, and the links between them. Other Worlds are skipped and logged. Templates stay available to `Engine.createWorld`.
- If the bootstrap has no server Worlds but has server-tagged templates (a game whose **Host** button creates the server World at runtime), it creates those templates at start instead, each named after its key. When one of them has `"lobby"`, it creates only that one: the lobby makes its match Worlds from their templates.
- A code bootstrap runs with Worlds not tagged `server` skipped; `connect` calls from skipped Worlds tell the server where to listen.
- Each server World listens on the port of a `websocket` link that connects to it (its `port`, `address` or `url`). The first server World falls back to `--port` or 7777. Others with no such link don't listen, and the server logs that.
- Server Worlds created at runtime (a lobby's matches) run too. One listens when code calls `listen`; without a port it shares the first server World's port, by path. The server logs when such a World starts listening and when it's destroyed.
- It logs each connection opened and closed, and stats every minute. Ctrl+C closes every connection and exits.

Server Worlds must run headless: no code in them that needs a canvas, the DOM or Web Audio. TLS (`wss://`) needs a reverse proxy in front.

## Lobbies and matchmaking

A **lobby** (ADR 0068) is a server World with the lobby service on. Players join it, wait in rooms, ready up and pick settings; when a room starts, the lobby creates a **match World** for it from a template and the players' pages join that. When the match ends, the players are back in their room.

> **Sample.** `samples/pirates/` (King of Pirates) uses a lobby for everything: its menu (`scripts/behaviors/Menu.ts`) runs a lobby in the page for Practice, Quick Match and rooms, or joins `npm run server -- samples/pirates`; `scripts/lobby.ts` loads the room's arena in the match Worlds and hands the results back.

### The lobby World

Turn the service on with `"lobby"` on a server World or template:

```json
"bootstrap": {
  "worlds": [{ "name": "Menu", "scenes": ["scenes/menu.scene.json"] }],
  "templates": {
    "Lobby": {
      "tags": ["server", "lobby"],
      "lobby": {
        "matchTemplate": "Match",
        "clientTemplate": "MatchClient",
        "maxPlayers": 8,
        "fillWithBots": true,
        "settings": { "arena": ["bay", "open", "maze"] }
      }
    },
    "Match": { "tags": ["server", "match"], "scenes": ["scenes/arena.scene.json"] },
    "MatchClient": { "tags": ["client", "match"], "scenes": ["scenes/arena.scene.json"] }
  }
}
```

Or in code: `Lobby.host(worldHandle, options)`.

| Option | Default | Meaning |
| --- | --- | --- |
| `matchTemplate` | (required) | The server template each match World is made from. |
| `clientTemplate` | none | The client template players' pages make their match client World from. |
| `maxPlayers` | 8 | Room size. |
| `minPlayers` | 1 | Members needed to start. |
| `fillWithBots` | false | Empty slots up to `maxPlayers` are bots in the match. |
| `startCountdown` | 3 | Seconds between everyone being ready and the start. |
| `settings` | none | Room settings and their allowed values; the first is the default (or `{ "choices": [...], "default": "open" }`). |
| `quickMatchWait` | 10 | Seconds a quick-match room waits for more players before it starts on its own. |
| `joinTimeout` | 30 | Seconds a match waits for its first player before it ends. |

Give game systems a tag of the match Worlds (`["match"]` above) rather than `["server"]` or `["client"]`, so they don't run in the lobby World. The hidden lobby client World is tagged `lobby-client` only, so no game system runs in it.

### Rooms

A room has an id, a 5-letter join code, a name, `public`, a host (the first member; passed on when the host leaves) and up to `maxPlayers` members, each with a slot, a name and a ready flag. When every member is ready (and there are at least `minPlayers`), the room counts down and starts; someone unreadying, leaving or joining stops the countdown. The host can change settings, kick members and start at once once `minPlayers` is met. **Quick match** joins the fullest public room that's waiting with the settings asked for, or makes one, which starts on its own after `quickMatchWait`.

### The client side

`Lobby` is static and page-wide, usable from any World's code. Menus poll it (there are no events):

```ts
import { Lobby } from "myco";

Lobby.connect("ws://play.example.com:7777", { name: "Anne" }); // or "local"
// later, in a menu's update:
if (Lobby.state === "lobby") showRooms(Lobby.rooms);
if (Lobby.state === "room") showRoom(Lobby.room!, Lobby.me!);
if (Lobby.error) showError(Lobby.error);
```

- `Lobby.connect(address, { name })` returns at once. `"local"` runs the project's lobby World (the template or World with `"lobby"`) in this page over loopback, for single-player and hot-seat play.
- `Lobby.state`: `"offline"`, `"connecting"`, `"lobby"`, `"room"`, `"starting"` (counting down) or `"match"`. `Lobby.error` is the last refusal or disconnect reason.
- `Lobby.rooms` (public rooms: code, name, member count, state, settings), `Lobby.room` (members, ready flags, `hostSlot`, settings, `countdown` in whole seconds, the last match's `results`), `Lobby.me` (slot, host, name).
- Actions: `quickMatch(settings?)`, `createRoom({ name, public, settings })`, `joinRoom(code)`, `leaveRoom()`, `setReady(ready)`, `setSetting(key, value)`, `kick(slot)` and `start()` (the last three host only). A refused action sets `Lobby.error`.
- In a match, `Lobby.matchWorld` is the match client World (named `Match <id> Client`) and `Lobby.leaveMatch()` leaves it. While it plays, the page's other Worlds that render are paused, not destroyed, and resume when it ends.
- `Lobby.disconnect()`.

### The match World

The lobby names each match World `Match <id>` and has it listen over the lobby's own transport at `/match/<id>` (on the lobby's port, see [Listening at runtime](#listening-at-runtime)). Each member gets a one-time ticket; a connection without a valid ticket for that match is refused. In the match World, `Match.current` says what to play:

```ts
import { Match, defineSystem } from "myco";

defineSystem({
  name: "game.Setup",
  phase: "update",
  worlds: ["match"],
  run() {
    const match = Match.current;
    if (!match) return;
    for (const p of match.players) if (p.bot && !p.name) p.name = `Captain ${p.slot + 1}`;
    // ... when someone wins:
    // match.end({ winner: "Anne" });
  },
});
```

- `id`, `roomId`, `settings`.
- `players`: one per slot, each with `slot`, `name`, `bot` and `connectionId` (the player's `Connection.id` once connected; 0 before, after they leave, and for bots).
- `end(results?)`: closes the match; `results` is a string map the room shows (`Lobby.room.results`).
- A match ends on its own if nobody connects within `joinTimeout`, or once every player who joined has left (`results` is then `{ reason }`).

## The editor

### Multiplayer play

The **Network** tab (beside Worlds) sets up how **Play** runs a client/server project:

- Tick **Multiplayer play**, then pick **Clients** (1 to 4) and **Thin clients** (0 to 8). Play copies the project's client World (one linked to a server World) as `Client 1`…`Client N` and `Thin 1`…`Thin T`, each with that World's links. `project.json` isn't changed.
- Thin clients don't render or take input. They send synthetic input on every input stream the game defines: **Random walk** or **Zeros**.
- Rendering clients get a tile each in the game view. Click a tile to give that client the keyboard.
- **The Host pattern** (like `samples/arena`): a bootstrap with no links whose server is a `server`-tagged template the game creates at runtime (a Host button). Play creates that template as a World up front, under the name the game would give it (so the game's `Engine.findWorld` finds it), and copies the project's client World as `Client 1…N` and `Thin 1…T`, each connected to it over loopback. **Clients load** picks their scenes: **the server's scenes** (the default: they join the game straight away) or **their own** (a menu; they're connected already, so the game's own Host or Join may then try to connect again).
- Thin client input wins over the game's own: a system that writes the keyboard into an input stream every tick (zeros in a World without input, as Arena's does) doesn't overwrite it.
- Without a client World linked to a server World, or a server template, Play runs the project as it is.

### Network conditions

Sliders for **Latency** (0 to 500 ms), **Jitter** (0 to 100 ms) and **Loss** (0 to 30%) apply to every loopback link of the game, both ways, live while playing. **Off** turns them off. They don't affect WebSocket links.

### Stats

While playing, the Network tab shows each networked World with its role, tick, server tick and ghost count, and each connection with its state, RTT and bytes per second in and out. Server rows add the last snapshot's size, the ghosts that client knows about and its input counts (received, repeated, late). Expand a row for traffic per kind of message, and on a server connection, **bandwidth per ghost type**: bytes per second, share and total for each prefab (or scene ghost, as `scene#node/path`), from the bits each ghost's spawn and state took in the snapshots sent. Client Worlds that predict show mispredictions, rollbacks and re-simulated ticks.

## Limits and known gaps

From [implementation status](../architecture/implementation-status.md) and [open questions](../architecture/open-questions.md):

- **Bootstrap links to a server elsewhere.** A link names two Worlds of the project (start-up or Spawnable, ADR 0062); a server in another process is joined at runtime with `connect(address, transport)`.
- **Lobbies:** one lobby process; no skill rating, regions, parties, spectators, joining a match in progress, or reconnecting to a match after a disconnect (the player goes back to the room). Tickets stop casual joins; they aren't authentication. In a page with a canvas the match World is drawn over the paused menu on a surface of its own; that hand-over is checked by hand in a browser, not by headless or end-to-end tests.
- **WebSocket in the browser.** A link between two Worlds in a browser page must use `loopback`; a `websocket` link there fails to start, because browsers can't listen.
- **Not replicated:** node active state, reparenting, and components added to a ghost after the server first saw it.
- **Prediction** covers data components, behavior fields and the transform moved by `predicted` systems. Behaviors aren't re-simulated, and physics isn't predicted.
- WebSocket carries unreliable messages over TCP, so packet loss delays them instead of dropping them. WebRTC, which would fix that, needs a signalling server and is deferred.
- Not built: lag compensation, relevancy and interest management, host migration, a single-World host, client-authoritative modes.
- Bandwidth per ghost type counts each ghost's spawn and state bits; snapshot headers and despawns aren't attributed to any type.
- A client World and a server World can't be the same World, and one World can't be both a client and a server (a relay).
