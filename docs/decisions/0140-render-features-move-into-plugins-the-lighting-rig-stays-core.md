# 0140. Sprites, Meshes and models, Water and UI register their render features from plugins; Environment and Post-processing become plugins over core render services; lights, fog, probes and cameras stay core

- **Status:** Proposed (built; the owner pre-approved building it and reviews at QA)
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0075, 0083, 0108, 0127, 0128, 0129, 0130, 0133, 0134, 0135, 0136

## Context

ADR 0135's migration step 4 says "the other render features move as their features become plugins". After the Sky,
Particles and Tilemaps plugins (0135, 0136), `BabylonRenderer`'s constructor still builds eight features itself:

| Feature | Phase | Component(s) | What the renderer core reads from it |
|---|---|---|---|
| sprites | content | SpriteRenderer | sort order for the quad batches (0136), `spriteSize` and the sprite iterator for the editor tools, `drawn.sprites` |
| meshes | content | MeshRenderer | shadow casters, "content loaded" (first frames, 0120; probes), the owner of a drawn mesh (variant report, 0080), the mesh iterator for the editor tools, `drawn.meshes`; the e2e specs read `renderer.meshes.meshRenderers` and `batchStats()` |
| lights | lighting | Light | shadow requests for the frame graph |
| fog | lighting | Fog | the sky fog the frame plan (0129) fades to; materials read the scene fog |
| environment | lighting | Environment (read, not owned) | — but it sets the default studio lighting of every World, and carries the sky's bake (0112) into the scene |
| probes | capture | ReflectionProbe | the probe lookup meshes and water use, captures, bakes, warm-up copies |
| water | surfaces | WaterSurface (lazy) | — |
| ui | overlay | UICanvas, UI elements, UIDocument, Text (lazy) | the UI core (editor, `uiState`), whether the preview inset has UI, world-canvas warm-up |

PostProcessing has no feature: the frame plan reads it per camera (0129) and the frame graph composes it.

ADR 0133 lists Sprites, Meshes and models, Environment, Water, UI and Post-processing as plugins, and keeps "the
renderer core and the shared render services (0127–0130)" in core. Two rules constrain how a feature can move:

- **Babylon stays in `src/engine/render/babylon/`** (0075; `babylonImports.test.ts`), and **`src/engine/` never imports
  `src/plugins/`** (0135; `plugins.test.ts`). A Babylon adapter that reads a Component class therefore needs that
  class in core, unless the plugin owns the logic behind a renderer-neutral host (0136).
- **Draw order must not change.** `byPhase` orders a phase by registration order adjusted by `after` constraints;
  plugin slots are appended after the built-ins.

The editor still detects, labels and previews the `environment`, `cubemap`, `lut`, `uidocument`, `stylesheet` and
`model` kinds in the built-in tables 0133 deprecates (`assetBrowser.ts`, `ui/Assets.tsx`, `ui/AssetPreview.tsx`,
`ui/AssetInspector.tsx`, `assetImport.ts`, `assetFieldKinds.ts`, `thumbnails/keys.ts`).

## Decision

### What becomes a plugin, and what stays core

| Feature | Decision | Why |
|---|---|---|
| **Sprites** | Plugin `myco.sprites`: claims SpriteRenderer, registers the `sprites` feature | Content feature; nothing else needs it to exist |
| **Meshes and models** | Plugin `myco.meshes`: claims MeshRenderer, registers the `meshes` feature (`after: ["sprites", "tilemaps"]`); editor half owns the `model` kind | Content feature |
| **Water** | Plugin `myco.water`: claims WaterSurface, registers the lazy `water` feature | Leaf feature |
| **UI** | Plugin `myco.ui`: claims the UI Components and Text, registers the lazy `ui` feature; editor half owns the `uidocument` and `stylesheet` kinds | Leaf feature (overlay phase) |
| **Environment** | Plugin `myco.environment`: claims Environment; editor half owns the `environment` and `cubemap` kinds and their Inspector view. The `environment` render feature **stays core** | Its sync is part of the lighting rig: it gives every World the studio lighting and carries the Sky plugin's bake into the scene, with or without an Environment Component |
| **Post-processing** | Plugin `myco.post-processing`: claims PostProcessing; editor half owns the `lut` kind. No render feature | The frame plan and frame graph compose it (0129); they are renderer core |
| **Lights, fog, reflection probes** | **Core** | Shared render services: lights feed the frame graph's shadows and the sky drives the sun through them; the fog's sky fog feeds the frame plan and materials read the scene fog; the probe lookup serves meshes, water and the warm-up (0130 point 3) |
| **Cameras, render textures, the material library, the quad-batch host** | **Core** | Renderer core (0127–0129, 0136) |

A plugin that "claims" a Component registers it through `registerComponents` (0135): disabling the plugin unregisters
it, so scenes load it as a missing Component (0133). Where a core service reads the Component (the environment sync,
the frame plan), it simply finds none.

### Component classes stay in core; adapters stay in the backend

Each moved feature's Babylon adapter (`BabylonSprites`, `BabylonMeshes`, `WaterFeature`, `BabylonUIFeature`) stays in
`render/babylon/` and reads its Component class, so the classes stay where they are (`render/components.ts`,
`render/water/`, `ui/`), as ParticleSystem did (0135). Unlike tiles (0136), these features have no renderer-neutral
logic worth lifting out: sprite batching, mesh instancing and Babylon GUI are the backend. A neutral host per feature
(like 0136's quad batches) is the step a second backend would take; it isn't needed to make them plugins.

Each plugin's runtime half has a `*Feature.ts` module, loaded on demand like Sky's (0135): a
`BabylonFeatureFactory` that builds the adapter from `BabylonFeatureHost`. It imports `render/babylon/` modules but
no Babylon module.

### The renderer reads named features through small APIs

As it already does for particles (`ParticlesFeatureApi`), the renderer finds a plugin feature by name and talks to it
through an interface in `render/babylon/feature.ts`:

- **`SpritesFeatureApi`** (`"sprites"`): `spriteSize`, `editorSprites`, `drawnNodes`.
- **`MeshesFeatureApi`** (`"meshes"`): `casters`, `loaded`, `ownerOf`, `drawn`, `editorMeshes`, `meshRenderers`,
  `batchStats`, `batchSources`, `meshesOf`. `BabylonRenderer.meshes` becomes a getter for it (null without the
  plugin), so the e2e specs' `renderer.meshes.meshRenderers` keeps working.
- **`UIFeatureApi`** (`"ui"`): `core`, `hasPreviewUI`, plus `warm`.

Without the plugin, each answer is the empty one: no casters, content counts as loaded, no sprite size, no UI.

**Sort order moves to core.** `sortingOrder(layers, layer, order)` (`render/sortOrder.ts`, renderer-neutral) gives
draw order for a sorting layer (ADR 0014); the sprites adapter and the quad-batch host both use it, so tiles keep
sorting with sprites when the Sprites plugin is off.

**`BabylonFeatureHost` grows** what the moved adapters took from the renderer: `settings()` (pixels per unit, sorting
layers), `drawPolicy()`, `texture`/`loadedTexture` (the material library already is), `probes` (`any`, `lookup`),
`reflected()` (the mesh-with-probe counter), `waterProbe` via `probeLookup`, and `uiHost()` (the UI's frame hooks,
preview rect and canvas size).

### Order

Built-ins register first, plugins after (in `RUNTIME_PLUGINS` order), and `after` constraints keep today's order:

| Phase | Built-in | Plugins (constraints) | Run order |
|---|---|---|---|
| content | — | sprites; tilemaps `after: ["sprites"]`; meshes `after: ["sprites", "tilemaps"]` | sprites, tilemaps, meshes |
| lighting | lights `after: ["sky"]`, fog, environment | sky | sky, lights, fog, environment |
| effects | — | particles | particles |
| capture | probes | — | probes |
| surfaces | — | water | water |
| overlay | — | ui | ui |

`RUNTIME_PLUGINS` lists sprites before tilemaps and meshes; the constraints hold in any order (a test registers them
shuffled). UI's `owns` (UI Components and Text) is the only overlap, and it's the only overlay feature.

### Manifests

- `myco.sprites`, `myco.meshes`, `myco.ui`, `myco.water`: `server: true`. Scripts read SpriteRenderer and UI
  Components on the server; MeshCollider builds from the sibling MeshRenderer's mesh; Buoyancy reads WaterSurface.
  Their features never load there (no renderer).
- `myco.environment`, `myco.post-processing`: `server: false` (drawing only).
- No plugin depends on another. Physics reads MeshRenderer and WaterSurface from core, as before.

### Editor halves

Asset kinds move out of the built-in tables into contributions. `AssetKindContribution` gains two policies 0133 named:

- **`codeEditor: true`**: opens in the Code panel (`uidocument`, `stylesheet`); replaces their `CODE_KINDS` entries.
- **`addToScene`**: `{ prepare?(path), nodes(doc, path, position) }`: the node entries a drop or + creates (`model`:
  the model's node tree, after `prepare` loads it); replaces the `model` branches of `canAddToScene`, `nodeForAsset`,
  `addAsset` and `prepareAssets`.

| Plugin | Kind | Extensions | Policies |
|---|---|---|---|
| myco.meshes | `model` | `.obj .fbx .gltf .glb` | preview `model`, `referencedAs: ["model", "mesh"]`, `addToScene` |
| myco.environment | `environment` | `.hdr .exr .dds .env` | preview `environment`, Inspector view, `referencedAs: ["environment"]` (`envmap` keeps its `.env` rule) |
| myco.environment | `cubemap` | `.cubemap.json` | preview `environment`, Inspector view, `referencedAs: ["environment"]` |
| myco.post-processing | `lut` | `.cube` | `referencedAs: ["lut"]` |
| myco.ui | `uidocument` | `.ui.xml` | `codeEditor`, `referencedAs: ["uidocument"]` |
| myco.ui | `stylesheet` | `.css` | `codeEditor` |

The model kind's import settings (the shared sidecar Inspector of images, audio and models, ADR 0040) stay in the
editor shell until an importer contribution point exists; it keys on the kind id `model`, which the plugin keeps.

## Alternatives considered

- **Move the Component classes into the plugins too.** Needs a renderer-neutral host per feature (0136's pattern) so
  the adapters stop reading the classes. Sprites and meshes have no neutral logic to lift; the hosts would mirror
  Babylon one-to-one. Left for the second backend, which will define what those hosts must say.
- **Make lights and fog plugins too.** Lights feed shadows into the frame graph and the sky drives the sun through
  them; the fog feeds the frame plan and every material. Disabling either would leave a half-working renderer, which
  0133's "shared render services stay core" rules out.
- **Move the environment render feature into the Environment plugin.** Its sync sets the default studio lighting for
  every World and is how the Sky plugin's bake reaches the scene; disabling the plugin would go dark and break Sky.
- **Generic capability members on `BabylonFeature`** (`casters?`, `loaded?`, `ownerOfDrawn?`) queried over all slots.
  More general, but every member has exactly one implementer, and `drawn` merges would collide. Named APIs match
  `ParticlesFeatureApi`.

## Consequences

**Positive**
- `BabylonRenderer` builds only the lighting rig, probes and its core; every Component-drawing feature (sprites,
  tilemaps, meshes, particles, water, UI, sky) comes from a plugin through the same registration.
- Disabling Sprites, Meshes, Water or UI removes their Components and never loads their drawing code; a UI-less game
  already didn't download it (0083), and now a 3D game without sprites doesn't build a sprite batcher.
- Six built-in asset kinds leave the editor's shared tables; the model kind's add-to-scene logic sits with Meshes.

**Negative / costs**
- Component classes stay in core, so `src/engine/` still holds sprite, mesh, water and UI Components; only their
  registration moves. Game builds carry them (as 0135 accepted for small classes).
- The renderer core knows three named feature APIs (sprites, meshes, ui) besides particles'.
- `BabylonFeatureHost` grows by the services the moved adapters need.
- The eager sprites and meshes features now load through a dynamic import before the renderer starts (like Sky and
  Tilemaps): one more small chunk fetch at start-up.

## Deprecates

- `BabylonRenderer`'s fixed feature list keeps only lights, fog, environment and probes (0135's deprecation, done for
  everything that draws a plugin's Component).
- `SPRITES_SPEC`, `MESHES_SPEC`, `WATER_SPEC` and `UI_SPEC` in `render/babylon/` (they move to the plugins' runtime
  halves); `render/babylon/uiSpec.ts` is removed.
- The `environment`, `cubemap`, `lut`, `uidocument`, `stylesheet` and `model` entries of the built-in kind tables.

## Open questions

- Renderer-neutral hosts for sprites and meshes, so their Components can move into the plugins (with a second backend).
- Whether Lights and Fog get a plugin that only claims their Components while the rig stays core (like Environment).
- The importer contribution point the model kind's import settings need.

## References

- `src/engine/render/babylon/BabylonRenderer.ts`, `feature.ts`, `features.ts`, `sprites.ts`, `meshes.ts`,
  `waterFeature.ts`, `uiFeature.ts`; `src/engine/render/renderFeatures.ts`, `sortOrder.ts`
- `src/plugins/{sprites,meshes,water,ui,environment,post-processing}/`; `src/plugins/sky/runtime/` (the pattern)
- [0130](0130-render-features-declare-ownership-phase-and-loading.md), [0133](0133-features-are-plugins-over-an-engine-and-editor-sdk.md), [0135](0135-runtime-contribution-points-and-plugin-activation.md), [0136](0136-tilemaps-plugin-draws-through-a-quad-batch-host.md)
