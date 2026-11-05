# Worlds

An Engine runs one or more **Worlds**. Each World is a separate game: its own nodes and scenes, its own systems, its own clock and physics. A single-player game has one World and never has to think about this. Multiplayer games, split-screen, a menu that starts a match, or a background simulation use several.

The design is in [ADR 0032](../decisions/0032-worlds-systems-and-bootstraps.md) and [ADR 0034](../decisions/0034-current-world-view-and-async.md). This guide is about using it. For networking between Worlds, see [Multiplayer](multiplayer.md).

## The default World

A project without a `bootstrap` section in `project.json` gets the **default bootstrap**: one World named `Default`, tagged `default` and `local`. It renders, takes local input, and runs every system whose `worlds` filter matches its tags (by default, all of yours). This is how the Flappy Bird sample runs.

`engine.world` is the Engine's default World: the first one its bootstrap made. If that World is destroyed, the next one becomes the default.

## Tags

A World has a name, unique in its Engine, and a list of **tags**. Tags are free strings. These have meaning to the engine:

| Tag | Meaning |
| --- | --- |
| `default` | The ordinary game World. Systems without a `worlds` filter run here. |
| `local` | A World that simulates on its own, not over a network. Systems without a `worlds` filter run here too. |
| `client` | A network client (see [Multiplayer](multiplayer.md)). |
| `server` | A network server. Doesn't render unless its config says `renders: true`. The dedicated server runs only these. |
| `editor` | The editor's own World. Game systems don't run here unless their filter names `editor`. |

You can add your own (`ai`, `replay`, `ui`) and filter systems and components by them.

## Declarative bootstraps

To run more than one World, add a `bootstrap` section to `project.json`. The editor's **Worlds** panel writes it for you (see [below](#the-worlds-panel)); this is what it looks like:

```json
"bootstrap": {
  "worlds": [
    { "name": "Server", "tags": ["server"], "tickRate": 30, "scenes": ["scenes/arena.scene.json"] },
    { "name": "Client", "tags": ["client"], "scenes": ["scenes/arena.scene.json"], "systems": { "exclude": ["game.DebugDraw"] } }
  ],
  "links": [{ "from": "Client", "to": "Server", "transport": "loopback" }],
  "templates": {
    "Match": { "tags": ["server"], "scenes": ["scenes/arena.scene.json"] }
  }
}
```

- **`worlds`**: the Worlds created at start, in order. The first is the default World. Each entry takes:
  - `name` (required) and `tags` (default `["default", "local"]`).
  - `tickRate`: fixed steps per second. Default: `1 / time.fixedDeltaTime` from `project.json` (60).
  - `timeScale`: the starting time scale. Default 1; 0 starts paused.
  - `renders` and `input`: whether it wants the screen and local input. See [The view and input](#the-view-and-input).
  - `scenes`: scenes loaded at start. The first replaces, the rest load additively.
  - `systems`: `include` and `exclude` lists of system names, on top of what the tags select.
- **`links`**: network links, `from` a client World `to` a server World. Each applies once both Worlds exist: at start for two start-up Worlds, or when game code creates a Spawnable World the link names (see [Links to Spawnable Worlds](#links-to-spawnable-worlds)). See [Multiplayer](multiplayer.md).
- **`templates`**: **Spawnable Worlds**, named World configs that game code creates when it needs them. Same keys as a World entry; `name` is optional and defaults to the template's key. The editor calls them Spawnable Worlds; in `project.json` and the API they're `templates`.

The bootstrap is checked when the Engine starts. Unknown keys, duplicate names, bad tick rates, unknown system names and links to missing Worlds are errors. You get one error that lists every problem, and no World is created.

## Code bootstraps

For setups the declarative form can't express, point `bootstrap` at a project script:

```json
"bootstrap": "scripts/Bootstrap.ts"
```

The script exports a function named `bootstrap` that creates the start-up Worlds:

```ts
import type { Bootstrap } from "myco";

export const bootstrap: Bootstrap = (engine) => {
  const server = engine.createWorld({ name: "Server", tags: ["server"], scenes: ["scenes/arena.scene.json"] });
  const client = engine.createWorld({ name: "Client", tags: ["client"], scenes: ["scenes/arena.scene.json"] });
  client.connect(server, "loopback");
};
```

The editor and the dedicated server load the script themselves. Code that calls `Engine.create` directly passes the function instead: `Engine.create({ bootstrap })`. A bootstrap can be `async`.

## Systems per World

`defineSystem` registers a system in a catalog. It doesn't run anywhere by itself. A World runs the catalog systems whose `worlds` filter matches one of its tags:

```ts
import { defineSystem } from "myco";

defineSystem({
  name: "game.ApplyDamage",
  phase: "fixedUpdate",
  worlds: ["server", "local"], // the authoritative game, online or offline
  run(rows, ctx) {
    // …
  },
});
```

- Without `worlds`, the filter is `["default", "local"]`. So a system you write for a single-player game runs in the default World, but **not** in a World tagged only `client` or `server`. Give multiplayer systems an explicit filter.
- `"*"` matches every World. Engine built-ins (script hooks, physics, networking) use it.
- A World can add or drop systems by name: `systems.include` / `systems.exclude` in its config, or `addSystem(name)` / `removeSystem(name)` on its handle at runtime.
- Order (`phase`, `after`, `before`) works within each World's own list.
- Scripts loaded later (in the editor, say) join the Worlds whose tags match.

`handle.systems()` lists a World's systems in execution order. The Worlds panel shows the same list with the reason for each one.

### Components per World

GameBehaviors run in every World where their component exists. By default a component exists in every World that loads its scene. To keep one out of some Worlds, give it a filter:

```ts
import { GameBehavior, behavior } from "myco";

@behavior("game.EnemyAI", { worlds: ["server", "local"] })
export class EnemyAI extends GameBehavior {
  update() {
    // runs only where the game is simulated, never on a client
  }
}
```

A scene file can also set `"worlds"` on one component entry, for that instance only (it works for data components too). In Worlds that don't match, the component isn't created when a scene or prefab loads. The editor's own World creates everything, so you can still edit it.

## Time in a World

Each World has its own clock. `Time` reads the clock of the World that's running:

- `Time.deltaTime`, `Time.time`, `Time.fixedDeltaTime` and the rest are that World's.
- `Time.timeScale` scales that World only. At 0, its fixed steps stop and `update` runs with `deltaTime` 0.
- `tickRate` in a World's config sets its fixed step. A 30 Hz World runs `fixedUpdate` on about every other frame of a 60 Hz display; a 120 Hz one runs it twice per frame.
- In a behavior, `this.time` is its own World's clock. In a system, `ctx.time` is.
- `Time.network` (and `this.time.network`, `ctx.time.network`) is set on networked Worlds. See [Multiplayer](multiplayer.md#ticks-and-time).

The Engine has one loop. Each frame it steps every running World once, in creation order. Each World turns the frame's real time into as many fixed steps as its accumulator and tick rate call for, capped at `time.maxSubSteps`.

## Creating and destroying Worlds at runtime

Game code can create Worlds while it runs, for example from a menu's **Host** button. `Engine.createWorld` takes a World config or a template name and returns a **World handle**:

```ts
import { Engine, GameBehavior, Input, behavior } from "myco";

@behavior("game.MainMenu")
export class MainMenu extends GameBehavior {
  update() {
    if (!Input.getKeyDown("enter")) return;
    const server = Engine.createWorld("Match"); // the template from project.json
    const client = Engine.createWorld({ name: "Player", tags: ["client"], scenes: ["scenes/arena.scene.json"] });
    client.connect(server, "loopback");
    Engine.findWorld("Menu")?.destroy(); // this menu's own World; the screen and input pass to "Player"
  }
}
```

- The new World's scenes load in the background, and it steps from the next frame.
- A template creates a World named after the template (or its `name`), so it can exist once at a time. For several, pass configs with different names.
- A bad config throws an error listing every problem, and nothing changes.
- `Engine.createWorld` and `Engine.findWorld` act on the Engine of the World that's running. In setup code that holds the Engine, `engine.createWorld` and `engine.findWorld` do the same.

### Links to Spawnable Worlds

A link can name a Spawnable World. It applies when game code creates that World, if the World at the other end is alive: the client connects to the server as if the script had called `connect` right after creating it. With this bootstrap, a menu's **Host** button only has to create the server:

```json
"bootstrap": {
  "worlds": [{ "name": "Client", "tags": ["client"], "scenes": ["scenes/menu.scene.json"] }],
  "links": [{ "from": "Client", "to": "Server", "transport": "loopback" }],
  "templates": { "Server": { "tags": ["server"], "renders": false, "scenes": ["scenes/arena.scene.json"] } }
}
```

```ts
Engine.createWorld("Server"); // the link connects Client to it
```

- Links name Worlds, by name: `Engine.createWorld("Server")` completes links naming `Server`, but a copy made as `createWorld({ ...templates.Server, name: "Server 2" })` completes only links naming `Server 2`.
- If the server World is destroyed and created again, its links apply again.
- A script's `connect` for a pair a link already connected does nothing, with a warning.
- The Arena sample works this way: Host creates `Server`, and P (a second local player) creates `Client 2`; both connect through links.

A `WorldHandle` has:

| Member | What it does |
| --- | --- |
| `name`, `tags`, `hasTag(tag)` | The World's identity. |
| `alive`, `paused` | False once destroyed; whether it's paused. Methods on a destroyed handle throw. |
| `loadScene(path, { additive })` | Loads a scene into that World. |
| `addSystem(name)`, `removeSystem(name)`, `systems()` | Its system list. |
| `connect(server, transport, options)` | Joins it to a server World as a client. See [Multiplayer](multiplayer.md). |
| `pause()`, `resume()` | A paused World skips its frames entirely. |
| `destroy()` | Destroys the World and everything in it. Mid-frame, it's torn down at the end of that frame. The Engine's last World can't be destroyed. |

## Isolation

Worlds don't share nodes. A handle is the only thing one World can hold of another, and it never leads to the other World's nodes.

- Reparenting a node under another World's node throws. So do `GameObject.create` and `instantiate` with a parent from another World, `$node` references and initial values that point across Worlds, and buffer records holding another World's nodes.
- Plain field assignment can't be checked. Don't store another World's nodes in fields.
- `Input` returns nothing in a World that doesn't take input.
- `SceneManager`, `GameObject.instantiate`, `Physics2D` and the other static facades act on the World that's running.
- Assets and storage are shared by the Engine. Autoloads (`project.json`'s `autoload`) go into the default World only.
- Script modules are shared too: a module-level variable is the same in every World of the page. Keep per-World state in components.

Worlds exchange data only through network messages: RPCs, inputs and replication over a link, even inside one Engine.

## Async code and the current World

While a World's frame runs, that World is current, and the static facades act on it. Between frames, the Engine's default World is current.

JavaScript can't carry the current World across an `await`. Code after an `await` runs after the frame has ended, so a bare `GameObject.instantiate(path)` or `Time.time` there acts on the **default** World, which may not be yours. Use the forms that name their World:

- `this.instantiate(path, options)` in a behavior: always its own World. A parent from another World throws.
- `this.time`: always its own World's clock.
- `GameObject.create(name, { parent })` and `GameObject.instantiate(path, { parent })`: the parent's World.
- `handle.loadScene(path)`: the handle's World. `SceneManager.load` captures the current World when you call it, so call it before the `await`, not after.

```ts
import { GameBehavior, behavior } from "myco";

@behavior("game.Spawner")
export class Spawner extends GameBehavior {
  async start() {
    await this.wait.seconds(2);
    this.instantiate("prefabs/enemy.prefab.json"); // right World, even if it isn't the default one
  }
}
```

In a single-World game, both forms behave the same.

## The view and input

An Engine has one screen and one set of local input devices. The first World that wants the view gets it: every World does unless its config says `renders: false`, except `server`-tagged Worlds, which want it only with `renders: true`. Input follows the view unless a World's config sets `input` itself. When the World with the view is destroyed, the view passes to the next World that wants it. That's what keeps the screen working when a menu World creates a match and destroys itself.

Showing several Worlds at once is something only the editor's play mode does so far.

## The Worlds panel

The editor's **Worlds** tab (beside History) edits `project.json`'s `bootstrap` as a graph:

- Start-up Worlds and Spawnable Worlds are nodes; links are edges. **+ World**, **+ Spawnable World** and **+ Link** create them, and each can be renamed or removed (links follow). Both kinds share one graph, laid out in columns from clients to the servers they link to; Spawnable Worlds are dashed and tagged "spawnable", as are links naming them, and each link's transport sits on a label beside its arrow.
- Selecting a Spawnable World shows the line of code that creates it, `Engine.createWorld("Name")`, with a copy button, and the project scripts that mention its name in quotes.
- Selecting one shows its tags (preset chips plus your own), tick rate, time scale, **Renders**, **Input** and start-up scenes.
- A checklist of every catalog system shows which ones the World runs and why: added by a tag, included or excluded by name. Ticking a box writes the smallest `include`/`exclude` that gets you there.
- Links have a from, a to and a transport; either end can be a start-up or a Spawnable World. Link `options` (ports, URLs, conditions) are edited in `project.json` (the Code panel); the panel keeps them. Worlds can also connect from scripts (`world.connect(…)`), which the panel can't see until you play.
- While playing, the graph also draws the live connections between the session's Worlds, however they were made, with their state.
- Valid edits save at once, keeping the rest of `project.json` and its formatting. Invalid ones stay unsaved, with the problems listed in the panel. The panel has its own undo and redo.
- A project with a code bootstrap shows the script's path instead. Read-only projects (samples opened in a browser) show the panel disabled.

## Play mode

**Play** builds an Engine from the project's bootstrap, so you play the Worlds you configured:

- A start-up World whose config lists no `scenes` plays the scene open in the editor. `"scenes": []` starts empty, as it would in a game.
- The game view tiles every World that renders, including Worlds created at runtime. Each tile is labelled with its World's name.
- Clicking a tile gives that World local input. Held keys stay held.
- A strip lists every World, headless ones too, with **Pause** / **Resume** buttons and **Step**, which advances just that World one frame, paused or not.
- **Pause** and **Step** in the menu bar (beside Play/Stop, in the middle) hold and advance the whole game: Step runs one 60 Hz frame in every World that isn't paused on its own, with a fixed step where one is due. Shortcuts: **Ctrl+Shift+P** pauses or resumes, **F10** or **Ctrl+Alt+P** steps (Cmd on macOS).
- While playing, the **Show** picker at the top of the Hierarchy switches the Hierarchy and Inspector between the edited scene and any live World, Worlds created at runtime included. The live tree shows scenes, nodes made at runtime, ghosts and connections, and refreshes as the World changes. Selecting a node outlines it in that World's view and shows its live values in the Inspector. Edits there change the running game only.
- **Keep values** on a live component header (or **Keep all changes to this node**) writes those values into the edited scene when you stop, as one undoable step: plain values on scene nodes, overrides on prefab instances. Only nodes loaded from the scene you're editing can keep values; for others (made or instantiated at runtime, from another scene) the Inspector says why.

For client/server projects, the **Network** tab adds multiplayer play with several clients and simulated network conditions. See [Multiplayer](multiplayer.md#the-editor).

## Limits

- The live Hierarchy can't create, delete, rename or reparent nodes, and the live Inspector can't add or remove components or change node references.
- A bare `GameObject.instantiate(path)` or `Time.*` after an `await` acts on the default World (above).
- Plain field assignment across Worlds isn't caught.
- The Inspector has no per-instance `worlds` setting yet; edit the scene file.
- Outside the editor, only one World is visible at a time.
