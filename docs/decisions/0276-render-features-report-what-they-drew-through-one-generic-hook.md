# 0276. Render features report what they drew, their shadow casters and whether they have loaded through generic hooks; no feature is reached by name

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** — (amends 0140: the renderer no longer reads the `sprites` and `meshes` features by name; completes 0154)
- **Related:** 0014, 0069, 0117, 0128, 0136, 0140, 0153, 0154, 0189

## Context

ADR 0154 made the renderer ask render features through optional hooks iterated over every loaded feature
(`describe`, `warm`, `diagnostics`, `uiCore`, `settled`). It kept ADR 0140's two by-name exceptions:
`SpritesFeatureApi` and `MeshesFeatureApi` (`render/babylon/feature.ts`), which `BabylonRenderer` found with
`feature<F>("sprites")` / `feature<F>("meshes")` for eight jobs: shadow casters, "content loaded" (first frames,
probes), the editor's picking, screen bounds and outlines (`editorContext.sprites()` / `meshes()`), thumbnail
framing (`contentMeshes`), sprite sizes (`spriteSize`) and `RenderDiagnostics.drawn` (`{ meshes, sprites }`).

Every other content feature was invisible to those jobs. Tile layers, water surfaces and world-space UI canvases
could not be picked, box-selected, framed (F) or outlined in the scene view, were left out of prefab-thumbnail
framing, and didn't appear in the diagnostics. Screen-space Text, which the UI feature draws (`render/babylon/ui.ts`),
was wired to an empty list (`texts: () => [] // Text draws from stage 9`), so it could not be clicked in the scene
view either, although the viewport's picking code already handled text rectangles.

## Decision

**Three more optional hooks on `BabylonFeature`**, iterated like the others over every loaded feature:

- `drawn(): Iterable<DrawnNode>`: what it drew now (visible and loaded), per Component. A `DrawnNode` has the
  `component` (its node is what is picked and framed), a `shape`, a pick `order`, optional `materials` (engine terms,
  for the diagnostics), optional `size` (a flat drawing's size in node units: a sprite's, what a collider fits) and
  optional `pickable: false`. Shapes (`DrawnShape`): `quad` (a mesh of its own that is a unit quad, both faces: a
  sprite), `meshes` (meshes of its own, picked against their triangles), `quads` (quad batches drawn through the
  renderer-neutral `QuadBatchHost`, ADR 0136, which the renderer resolves to its meshes, so the Tilemaps plugin names no
  Babylon type), `rect` (a canvas rectangle in CSS pixels), or null (drawn inside a shared batch: counted, not picked).
  Pick orders: layered 2D content uses its draw order (sorting layer × 10000 + order, ADR 0014);
  `PICK_ORDER.depthTested` (below every layer, nearest first) and `PICK_ORDER.screen` (above everything) for the rest.
- `casters(out)`: add this frame's shadow-casting meshes.
- `loaded()`: whether what it draws has loaded; `FeatureSyncContext.ready` (first frames, probe captures) and the
  thumbnail's `contentReady` wait for every loaded feature's.

**Who answers what.**

| Feature | `drawn` | `casters` | `loaded` |
|---|---|---|---|
| sprites | `quad` per own mesh (scene view, sliced, tiled), null when batched; draw order; `size` | — | — (its textures are the material library's, which the renderer checks) |
| meshes | `meshes` (none in a thin batch); depth-tested; drawn materials | renderers with `castShadows`, thin batches' sources | every model loaded |
| tilemaps | `quads` per visible layer; the layer's draw order | — | — |
| water | `meshes` (its grid); depth-tested | — | — |
| ui | world canvas planes, `pickable: false`; shown screen Text as `rect`, `PICK_ORDER.screen` | — | — |

**Shadows stay as they were.** Only the meshes feature casts. Sprites and tiles are flat, unlit layered quads; water
is transparent; world canvases are flat UI. None cast today, and casting would change the look of existing scenes.
A feature that should cast later answers `casters`.

**UI picking keeps its own route.** The UI core picks canvases and elements by ADR 0117's rules (painted elements
before scene hits, bare containers and canvases after), so world canvases are `pickable: false`: framed, box-selected,
outlined and reported, but not in the renderer's pick list. Screen Text is not a UI-core element and is picked here.

**The renderer and editor read one list.** `BabylonRenderer` keeps no by-name lookup: `feature<F>()`,
`spritesFeature()`, `meshesFeature()` and `spriteSize()` are removed. `BabylonEditorContext.drawn()` (with quad
batches resolved, `EditorDrawn`) replaces `sprites()`, `meshes()` and `texts()`; `BabylonEditorRendererHooks.spriteSize`
goes, and the viewport adapter answers `spriteSize` from the drawn `size`. The editor viewport's picking, screen
bounds (now the union of everything drawn for a node), outlines and world box read it. `ViewportAdapter.meshBounds`
becomes `drawnBounds` (the box around everything drawn for the node in the world: meshes, sprite quads, tile layers,
water, world canvases), so F frames those too. Thumbnails frame `contentMeshes()`, now every drawn quad and mesh.

**One diagnostics shape.** `RenderDiagnostics.drawn` becomes `{ node, feature, materials }[]`: each node once per
feature that drew it, by the feature's spec name, with the materials it was drawn with (MeshRenderers report theirs).
It replaces `{ meshes, sprites }`; the e2e specs that read it filter by `feature: "meshes"`.

## Alternatives considered

- **Keep the by-name APIs and add one per feature** (`TilemapsFeatureApi`, `WaterFeatureApi`…) — every feature grows
  the renderer and the editor context again; plugins can't answer for their own content.
- **Separate hooks per job** (`editorItems`, `pickables`, `diagnosticsNodes`, `spriteSize`) — the jobs read the same
  facts (what was drawn, where, in what order); one list keeps them consistent.
- **Let the Tilemaps plugin hand over Babylon meshes** — the plugin is renderer-neutral by design (ADR 0136); the
  `quads` shape keeps it so and the renderer, which owns the batches, resolves them.
- **Pick world canvases here too** — it would put canvases ahead of the scene hits behind them, against ADR 0117.
- **Keep `drawn: { meshes, sprites }` and add more keys** — a key per feature in core diagnostics is what ADR 0154
  removed for `sky`, `water` and `particles`.

## Consequences

**Positive**
- Tile layers, water and world canvases can be framed, box-selected and outlined; tile layers, water and screen Text
  can be clicked (fixing Screen Text's empty list); all appear in the diagnostics and in prefab-thumbnail framing.
- The renderer names no render feature; a new plugin answers for its own content.
- One diagnostics shape for every feature.

**Negative / costs**
- `RenderDiagnostics.drawn` changed shape (internal, but the e2e specs read it: updated).
- A sprite's size is known only while it's drawn: a hidden sprite (or one whose texture is loading) answers no
  size, and the editor falls back to its `size` field or its origin, as it already did while loading.
- Screen Text has no outline: outlines are drawn in the 3D overlay scene, and a canvas rectangle isn't there.
- Screen-space UI elements still report no rectangle here; the UI core answers for them (`uiElementBox`).

## Deprecates

`SpritesFeatureApi`, `MeshesFeatureApi` (removed); `EditorSprite`, `EditorMesh`, `BabylonEditorContext.sprites/meshes/texts`,
`BabylonEditorRendererHooks.spriteSize`, `BabylonRenderer.spriteSize` and its by-name `feature()` lookups (removed);
`BabylonSprites.editorSprites/spriteSize/drawnNodes`, `BabylonMeshes.editorMeshes/drawn()` as diagnostics (replaced by
`drawn()`), `BabylonMeshes.ownerOf` (now private); `ViewportAdapter.meshBounds` (renamed `drawnBounds`);
`RenderDiagnostics.drawn.meshes/sprites` (replaced by the flat list).

## Open questions

- Whether screen-space UI elements should also report their rectangles here (box selection by area rather than origin).
- An outline for screen rectangles (a 2D overlay).

## References

- `src/engine/render/babylon/feature.ts` (`DrawnNode`, `DrawnShape`, `PICK_ORDER`, the hooks), `BabylonRenderer.ts`
  (`drawn()`, casters, readiness, `contentMeshes`, diagnostics), `editorContext.ts` (`EditorDrawn`), `editorViewport.ts`,
  `editorGuides.ts`, `quadBatches.ts` (`meshOf`), `sprites.ts`, `meshes.ts`, `water.ts` / `waterFeature.ts`, `ui.ts` /
  `uiFeature.ts`, `src/plugins/tilemaps/runtime/{tilemapRenderer,tilemapsFeature}.ts`.
- Tests: `engine/tests/renderFeatureDrawn.test.ts`, `babylonEditorPicking.test.ts`, `babylonEditorDrawing.test.ts`,
  `babylonEditorViewport.test.ts`, `uiFeature.test.ts`, `spriteBatching.test.ts`, `instancing.test.ts`,
  `thumbnailRenderFeatures.test.ts`; e2e `three-d`, `shadersubgraph`, `shaderassets`, `selection` (clicking a screen Text).
