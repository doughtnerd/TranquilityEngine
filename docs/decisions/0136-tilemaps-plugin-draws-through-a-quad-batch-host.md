# 0136. The Tilemaps plugin owns tile data and drawing logic; the renderer core gives it a renderer-neutral quad-batch host

- **Status:** Accepted
- **Date:** 2026-11-08
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0014, 0075, 0103, 0105, 0119, 0127, 0130, 0133, 0134, 0135

## Context

ADR 0133 makes Tilemaps a first-party plugin (`myco.tilemaps`), and 0135 gives runtime halves a context to register Components, systems, World services and (internally) render features. The tile code can't move yet:

- **Tile data** lives in `src/engine/tilemap/` (~1,250 lines): `Tilemap.ts` (the Component, layers, chunked cells), `tileset.ts`, `format.ts`, `autotile.ts`, `brushes.ts`, `collision.ts` (tile collision shapes, ADR 0105) and `mesh.ts` (chunk quads, ADR 0103).
- **Drawing** is `BabylonTilemaps` (`render/babylon/tilemaps.ts`, 218 lines), wrapped by `TilemapsFeature` with `TILEMAPS_SPEC` (`render/babylon/features.ts`) and built in `BabylonRenderer`'s constructor. It mixes three jobs: resolving tile frames (tileset → sprite → texture size, slices, anchors), tracking which chunks changed (cell versions, frame invalidation when a texture loads or a sidecar changes), and making Babylon meshes and materials (one unlit, alpha-blended, no-depth PBR material per layer and texture; `alphaIndex` from the sorting layer, ADR 0014; frozen world matrix).
- **Two tests block a plain move.** Babylon may only be imported under `render/babylon/` (ADR 0075), and `src/engine/` may not import `src/plugins/` (`plugins.test.ts`, 0135). `BabylonTilemaps` needs `Tilemap`, the mesh builder and the tileset, so it can't stay in the renderer once those move, and it can't move with them.
- **Consumers outside the plugin:** Physics 2D's `TilemapCollider2D` and `tilemapPhysics2D.ts` read a sibling `Tilemap` and call `buildTileShapes`. The editor's painting (`src/editor/tilemap/`), `TilePalettePanel`, `TileThumb`, `TilemapInspector`, `TilesetInspector` and `tilesetAssets.ts` read the tileset and cells; none of them renders through the engine (`TileThumb` crops the image in CSS). `meshes.ts`'s `MESHES_SPEC` has `after: ["sprites", "tilemaps"]`.
- **Sky's precedent** (0135): `src/plugins/sky/runtime/skyFeature.ts` imports `BabylonSky` from `render/babylon/` but no Babylon module, and is loaded by a factory the plugin registers. That works for Sky because `BabylonSky` needs only engine types. Tiles are different: the drawing logic is tile-specific and needs the plugin's types.
- The partial `myco.tilemaps` plugin being added on the plugin-enabling branch registers the `tileset` asset kind (editor half) and claims the `Tilemap` Component (runtime half).

## Decision

We will split tile drawing at the point where it stops being about tiles (design A, a quad-batch host): **the plugin turns tile layers into textured quads; the renderer core draws batches of textured quads.**

**1. A renderer-neutral quad-batch host in core** (`src/engine/render/quadBatches.ts`, types only, no Babylon):

```ts
/** @internal Sorted, unlit, alpha-blended textured quads in a node's space (ADR 0136). */
export interface QuadBatchHost {
  /** A new, empty, hidden batch. `name` is for debugging (`tilemap:Ground:0:0,0`). */
  createBatch(name: string): QuadBatch;
  /** A texture's authored size in pixels, or null while it loads (`onLoad` runs once it has; ADR 0119). */
  textureSize(path: string, onLoad: () => void): readonly [number, number] | null;
  /** Draw order for a sorting layer and order in layer (ADR 0014): the value sprites use. */
  sortOrder(sortingLayer: string, orderInLayer: number): number;
}

export interface QuadBatch {
  /** Replace the geometry: 4 corners × xyz positions, 4 × uv (v up), 6 indices per quad. */
  setQuads(texture: string, positions: Float32Array, uvs: Float32Array, indices: Uint32Array): void;
  /** Column-major 4×4 node-to-world matrix (the layout `World.worldMatrix` gives). */
  setMatrix(m: ArrayLike<number>, offset?: number): void;
  setOrder(order: number): void;
  /** `#rrggbb` (sRGB) and opacity 0..1. */
  setTint(color: string, opacity: number): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}
```

- **The Babylon adapter** is `BabylonQuadBatches` (`render/babylon/quadBatches.ts`, about 100 lines): a `Mesh` per batch, materials shared per (texture, tint, opacity) with today's settings (unlit PBR, `ALWAYS` depth, no depth write, alpha blend, alpha from texture), `alphaIndex` = order, frozen world matrix. It knows nothing of tiles, chunks or tilesets.
- `BabylonFeatureHost` (0135) gains `quads: QuadBatchHost`. Its other members stay; the tile feature uses only `quads`.
- Sprites keep their own batching (`spriteBatches.ts`); moving them onto this host is a later, separate choice.

**2. The Tilemaps plugin owns everything tile-specific** in `src/plugins/tilemaps/runtime/`:

- The data files move from `src/engine/tilemap/` unchanged except for import paths: `Tilemap.ts`, `tileset.ts`, `format.ts`, `autotile.ts`, `brushes.ts`, `collision.ts`, `mesh.ts`.
- `tilemapRenderer.ts` (from `BabylonTilemaps`, minus the Babylon parts): frame resolution, chunk and frame versions, sidecar watching, one `QuadBatch` per (layer, chunk, texture). It imports no Babylon module and no `render/babylon/` code, so it is unit-tested against a fake `QuadBatchHost`, without a GPU or Babylon's NullEngine.
- `tilemapsFeature.ts`: the `BabylonFeature` (`sync`, `release`, `dispose`) built by `createTilemapsFeature: BabylonFeatureFactory = (host) => new TilemapsFeature(new TilemapRenderer(host.quads))`. Like Sky's, it imports `render/babylon/feature` types only.
- `index.ts` activates the plugin: `registerComponents([Tilemap])` and `registerRenderFeature({ spec: TILEMAPS_SPEC, load: () => import("./tilemapsFeature").then((m) => m.createTilemapsFeature) })`, with `TILEMAPS_SPEC = { name: "tilemaps", phase: "content", types: [Tilemap], lazy: false, after: ["sprites"] }`.
- `src/myco.ts` re-exports the names `src/engine/index.ts` exports today (`Tilemap`, `TilemapChanges`, `TileChange`, `FLIP_*`, `TilemapLayerData`, the tileset types, `TileCollisionMode`), so `import { Tilemap } from "myco"` keeps working. `src/engine/index.ts` drops them.

**3. Ordering among render features stays as today** through 0135's `after` constraints, not list position. Plugin slots are appended after the built-in ones; `byPhase` then orders the `content` phase as sprites → tilemaps (`after: ["sprites"]`) → meshes (`MESHES_SPEC` keeps `after: ["sprites", "tilemaps"]`; the name is ignored when Tilemaps is disabled). Draw order itself comes from `alphaIndex`, not sync order, so it doesn't change. A test pins the resulting `content` order.

**4. 2D colliders are not bound to tilemaps, and Tilemaps names no physics** (0133; amended on acceptance). A 2D collider can sit on anything that collides in two dimensions (a sprite, a 3D model, a tilemap), so the coupling runs through a generic, engine-level shape source instead of a Physics 2D ↔ Tilemaps link:

- **Core** gets `src/engine/physics/shapeSource2D.ts` (no Rapier, no tile types): `CollisionShapeSource2D`, a Component that offers 2D collision shapes — `collisionSignature()` (changes whenever its shapes would) and `collisionShapes(merge)` → `CollisionShapes2D` (`unit` = one shape unit in the node's local space, `boxes`, `loops`, `polygons`, `oneWay`, `oneWayPolygons`) — and `findShapeSource2D(node)`, which returns the first Component on the node that implements it.
- **Tilemaps** implements it on `Tilemap` (its shapes come from the tileset's per-tile collision and `buildTileShapes`). It imports nothing from Physics 2D, declares no dependency on it, and requires no collider: a Tilemap without a collider simply never has its shapes asked for.
- **Physics 2D** keeps `TilemapCollider2D` (the Component id `engine.TilemapCollider2D` stays, so scenes load unchanged) and `tilemapPhysics2D.ts`, but the collider reads whatever shape source is on its node (`source`, replacing the `tilemap` getter) and imports nothing from Tilemaps, not even types. With no source on the node it builds nothing. Any future Component that offers shapes (a polygon sprite outline, a procedural level) works with it the same way.
- A new rule in `plugins.test.ts`: a plugin may import another plugin only through its `runtime/index.ts`, and only `import type` unless its manifest lists that plugin under `dependencies`. Today no plugin imports another.

**5. The editor consumes the runtime half's public module.** The painting tools, the Tile Palette panel, `TileThumb`, the inspectors and `tilesetAssets.ts` import from `src/plugins/tilemaps/runtime` instead of `src/engine/tilemap/` (the editor core may import runtime halves). Moving them into the plugin's editor half (a panel contribution, 0134, plus a viewport-tool hook for painting) is a follow-up step that needs a viewport tool contribution point first. Thumbnails need nothing from the renderer: `TileThumb` crops the image in CSS.

**Build order:** (1) the quad-batch host and its Babylon adapter, with `BabylonTilemaps` rewritten on it while still in core, so the screenshot and e2e checks compare like with like; (2) move the data files and the tile renderer into the plugin and register the feature; (3) the 2D shape source and the import rule; (4) editor imports; later, the editor half.

## Alternatives considered

- **Design B — a tile-layer host** (core types `TileLayer { cells per chunk, chunk versions, frames: id → {texture, uv, size, anchor}, cellSize, sorting layer, order, tint, opacity, matrix }`; the Babylon adapter keeps chunk diffing and mesh building). Fewer files move, but the adapter must understand cells, flip flags, anchors and chunk keys, `mesh.ts` must stay in core (or be duplicated) for the adapter to use, and the tile logic is only testable through Babylon. It also describes one feature's data in core, which 0133 says belongs to the plugin.
- **Move `BabylonTilemaps` into the plugin and widen the Babylon-folder rule to `src/plugins/*/runtime/*Feature.ts`.** Smallest change, but it breaks ADR 0075's one-folder rule and invites every plugin to import Babylon, which makes a future backend impossible to scope.
- **Keep the tile data in core** (only the Component moves). Physics 2D and the editor keep working untouched, but the plugin would be a shell, and the engine would still carry autotile, brushes and tileset parsing for games without tiles.
- **Physics 2D depends hard on Tilemaps** (manifest `dependencies`, value imports). Simple and explicit, but enabling 2D physics would force Tilemaps on, and Tilemaps could never be disabled in a physics game. 0133 names exactly this case as one for optional coupling.
- **Tilemaps publishes a World service with the tile shapes.** World services start asynchronously and independently, so Physics 2D could start before it and see no tiles; the data it would carry is already on the Component.
- **Physics 2D looks up `engine.Tilemap` by id and reads it through a type-only `TileCollisionSource`** (the proposed version of this record). Optional, but it still binds the 2D collider to tilemaps and makes Tilemaps describe itself in physics terms; the owner rejected it on acceptance in favour of the generic shape source.

## Consequences

**Positive**
- `src/engine/` no longer contains tile code; disabling Tilemaps leaves no tile Components and no tile feature.
- Tile drawing logic becomes testable without Babylon (fake `QuadBatchHost`).
- The quad-batch host is reusable by other 2D plugin features (text in world, decals) without each adding a Babylon file.
- Physics 2D and Tilemaps don't know each other; both meet at a small core interface any Component can implement, and a test checks cross-plugin imports.

**Negative / costs**
- One extra layer between tile chunks and Babylon meshes; the per-frame cost stays one `setVisible`/`setOrder` per batch, as today.
- Materials move from per (layer, texture) to shared per (texture, tint, opacity): same visual result, but a regression risk to check with the tile e2e screenshots.
- `myco.ts` grows another re-export block, kept in step by hand (as for Sky).
- `TilemapCollider2D` keeps a tile-specific name although it now takes any shape source; renaming it (with an alias for the old id) is left open.

## Deprecates

- `src/engine/tilemap/` (moved into the plugin), `render/babylon/tilemaps.ts`'s `BabylonTilemaps`, and `TilemapsFeature`/`TILEMAPS_SPEC` in `render/babylon/features.ts` (replaced by the plugin's feature and spec). Removed in the same change; no shims.
- The tile exports of `src/engine/index.ts` (they move to `src/myco.ts`).

## Open questions

- Whether `TilemapCollider2D` is renamed (for example `ShapeCollider2D`, keeping `engine.TilemapCollider2D` as an alias) now that it takes any `CollisionShapeSource2D`.

- Animated tiles: tilesets have no animation frames today. When they do, the plugin advances frames and rewrites UVs through `setQuads`; whether the host needs a cheaper UV-only update is decided then.
- Whether the tile feature should load lazily (`lazy: true`, `holdsFirstFrame: true`) so games without tiles skip its chunk; eager keeps today's behaviour and is the start.
- The viewport-tool contribution point the painting tools need to move into the editor half.

## References

- `src/engine/render/babylon/tilemaps.ts`, `features.ts`, `BabylonRenderer.ts`, `feature.ts`, `meshes.ts`
- `src/engine/tilemap/*`, `src/engine/render/renderFeatures.ts` (`byPhase`)
- `src/plugins/sky/runtime/` (the pattern), `src/plugins/runtimeContext.ts`, `src/plugins/plugins.test.ts`
- `src/plugins/physics2d/runtime/TilemapCollider2D.ts`, `tilemapPhysics2D.ts`
- `src/editor/tilemap/`, `src/editor/ui/TilePalettePanel.tsx`, `TileThumb.tsx`
