# Writing a plugin

A plugin adds a feature to Myco: Components and systems for the game, and asset kinds, panels and
Inspector extras for the editor (ADR 0133). Myco's own features (Sky, Tilemaps, Physics…) are built
the same way. This page covers **third-party plugins**: ones that live in your project or come from an
npm package (ADR 0139).

> **Experimental.** Both SDK entry points, `myco` and `myco/editor`, can change before v1.

> **Trust.** A plugin runs with the same access as your scripts: in the editor, the game and, in the
> desktop editor, your files. There is no sandbox. Only add plugins whose authors you trust.

## The layout

A project plugin is a folder under `plugins/`:

```
my-game/
  project.json
  scripts/…
  plugins/
    spinner/
      plugin.json        the manifest
      runtime/index.ts   the runtime half: what ships in the game
      editor/index.ts    the editor half: only the editor loads it
```

`src/plugins/fixtures/spinner-project/` in the engine repository is this example, complete.

- **The runtime half** is everything in the plugin folder outside `editor/`. It ships in game builds
  and on the dedicated server, and imports only `"myco"`, its own files, the project's JSON files and
  npm packages.
- **The editor half** is the `editor/` folder. It may import `"myco/editor"` and the plugin's runtime
  files. It is never exported. A runtime file that imports it, or `"myco/editor"`, is a load problem.

Plugin files compile like scripts. You can edit them in the Code panel or any TypeScript editor; the
project's generated `tsconfig.json` includes `plugins/**/*.ts` and maps `myco/editor`.

## plugin.json

```json
{
  "name": "acme.spinner",
  "version": "1.0.0",
  "title": "Spinner",
  "description": "A Component that spins its node, and spin preset assets.",
  "sdk": "^1.0.0",
  "dependencies": { "myco.physics": "*" },
  "runtime": "runtime/index.ts",
  "editor": "editor/index.ts",
  "server": true,
  "assetKinds": [{ "id": "spin", "extensions": [".spin.json"], "label": "Spin Preset", "icon": "M4 12a8 8 0 1 0 8-8" }]
}
```

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Unique, lower case (`a-z 0-9 . - _`). `myco.` is reserved for Myco's own plugins. Use a prefix of your own, such as `acme.`. |
| `version` | yes | The plugin's version, `x.y.z`. |
| `sdk` | yes | The Myco versions it works with, as an npm range (`^1.0.0`). Myco refuses the plugin if it doesn't match. |
| `runtime`, `editor` | at least one | Entry files, relative to the plugin folder. `editor` must be inside `editor/`; `runtime` outside it. |
| `title`, `description` | no | Shown in **Project Settings > Plugins**. |
| `dependencies` | no | Other plugins it needs, name → version range. Myco's plugins carry the engine's version, so `"*"` is usual for them. |
| `server` | no | `false` for a plugin that only draws: the dedicated server leaves it out. Default `true`. |
| `assetKinds` | no | File types the Assets panel recognises before any plugin code runs: `id`, `extensions` (lower case, with the dot), `label`, `icon` (an SVG path in a 24×24 box). |

Version ranges use npm's syntax: `1.2.3`, `^1.2.3`, `~1.2.3`, `>=1.2 <2`, `1.x`, `*`, `a || b`.

## The runtime half

The entry exports `activate(context)`. Decorate Components as in scripts, then claim them, so turning
the plugin off unregisters them:

```ts
import { Component, Time, component, field, type RuntimePluginContext } from "myco";

@component("acme.Spinner")
export class Spinner extends Component {
  @field(Number) speed = 90;

  update(): void {
    this.transform.rotate2D(this.speed * Time.deltaTime);
  }
}

export function activate(context: RuntimePluginContext): void {
  context.registerComponents([Spinner]);
}
```

The context also has:
- `registerSystems([...])`: systems for the catalog;
- `registerWorldService(...)`: a per-World subsystem loaded on demand;
- `contribute(point, value)`: add to another plugin's contribution point.

Everything registered through the context is removed again when the plugin is turned off or reloaded.

### A physics backend

The Physics plugin's backends are a contribution point (ADR 0137), exported from `myco`. Depend on
`myco.physics` in `plugin.json`, then:

```ts
import { PHYSICS_BACKENDS, type PhysicsBackend2D, type RuntimePluginContext } from "myco";

export function activate(context: RuntimePluginContext): void {
  context.contribute(PHYSICS_BACKENDS, { id: "box2d", dimension: "2d", title: "Box2D", load: () => import("./box2d").then((m) => m.backend as PhysicsBackend2D) });
}
```

`myco` exports every type a backend implements (`PhysicsBackend`, `PhysicsWorldBackend`, the shape,
body, collider, joint and query descriptions). A project picks a backend with `physics.backend2d` or
`physics.backend3d` in `project.json`.

## The editor half

The editor entry also exports `activate(context)`, with the editor's contribution points:

```ts
import type { EditorPluginContext } from "myco/editor";
import { Spinner } from "../runtime/index";

export function activate(context: EditorPluginContext): void {
  const speed = new Spinner().speed;
  context.registerComponentNote({ id: "acme.spinner.note", note: (type) => (type === "acme.Spinner" ? `spins at ${speed}°/s` : null) });
}
```

`EditorPluginContext` registers:
- asset kinds (with an opener, an Inspector view and a New… entry), asset formats and panels;
- Project settings categories, panel extensions and Component notes;
- Inspector sections and viewport tools.

`openAssetDocument` gives an asset kind load, save, undo and redo. An asset kind the editor half
registers replaces the `plugin.json` entry with the same id.

## Turning plugins on and off

Plugins found in the project are **on** by default. **Project Settings > Plugins** lists them after
Myco's own, with where each came from, and lists plugins that can't load with the reason. Turning one
off writes its name into `project.json`'s `plugins.disabled`, as for Myco's plugins. A plugin that is
off doesn't load anywhere: not in the editor, not in Play, not in exported games. Its Components stay
in your scenes and show as missing until you turn it on again.

## Reloading

Saving a plugin file reloads the project's code, as saving a script does.
- **Editor half:** its contributions are registered again at once.
- **Runtime half:** changes apply to the editor's scene at once, and to the game at the next Play. A
  save during Play swaps Components live, as for scripts. Changing `plugin.json` reloads too.

## npm packages

To publish a plugin as a package, put the manifest in the package and point at it from its
`package.json`:

```json
{
  "name": "acme-spinner",
  "version": "1.0.0",
  "myco": { "plugin": "plugin.json" },
  "files": ["plugin.json", "dist"]
}
```

- **Entries** (`runtime`, `editor`) are paths in the package, usually built JavaScript (`dist/runtime.js`). They are imported as `<package>/<entry>`, so if the package has an `exports` map, export them there.
- **Imports:** `"myco"` and `"myco/editor"` stay external. Don't bundle the engine.
- **Using one:** add the package to your project's `package.json` and run `npm install` in the project folder. Myco checks the packages listed there.

## What can stop a plugin

The editor's status bar, `npm run export` and the dedicated server all report a refused plugin by
name:
- a `plugin.json` that doesn't parse or validate;
- an `sdk` range this Myco doesn't meet;
- a missing entry file;
- a missing dependency, or one at a version outside the range;
- a dependency cycle;
- a name already taken.

A plugin that needs a refused one is refused too. Exports and the server stop on any refused plugin;
the editor loads the rest.

## Limits

- **Custom render passes:** third-party plugins can't draw them. Draw with meshes, materials, shader graphs, sprites, particles, UI and lines (ADR 0133).
- **Settings storage:** there's no per-plugin settings storage in `project.json` yet.
