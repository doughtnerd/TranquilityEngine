# 0187. The Babylon editor viewport is the adapter itself, drawing through a guides module and an icons module

- **Status:** Accepted
- **Date:** 2026-11-16
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0022, 0043, 0075 (stage 8), 0128 (amends its Babylon adapter), 0138, 0142

## Context

ADR 0128 put the editor viewport behind `ViewportHandle` (written once) and the `ViewportAdapter` seam, with
two adapters: Babylon's and an in-memory fake. The Babylon adapter, `BabylonEditorTools`
(`babylon/editorTools.ts`, 123 lines), did no work of its own. Each method forwarded to one of three
helpers, usually as `world ? this.queries.x(world, …) : []`. Its `overlays`, `queries` and `gizmo`
members were public, and a test reached through them (`tools.overlays.isOutlined`). Below it:

- `editorQueries.ts` had picking and canvas queries. Each took a `World` that most ignored, it took the icon
  hit test as a callback, and it had `pointOnPlaneZ` and `pointOnPlane`, which only its tests called.
  `ViewportHandle` derives plane hits from the ray.
- `editorOverlays.ts` (1,079 lines) mixed the grid and axes, selection outlines, the editor overlay
  (lines, handles, segment groups), camera, light and particle icons, the icon painter, `LineBatch`, a
  private handle `QuadBatch` and icon picking. It had three near-identical icon sync loops, unused
  `_world` parameters, and test-only members (`cameraGizmoCount`, `particleGizmoCount`,
  `pickOverlayHandle`, which `ViewportHandle` also does).

Deleting `editorTools.ts` would not move any complexity elsewhere. It was a pass-through.

## Decision

We will implement `ViewportAdapter` directly, in one Babylon module, and split the drawing by what it
draws:

- **`babylon/editorViewport.ts`: `BabylonEditorViewport implements ViewportAdapter`.** It answers picking,
  rays, projection, screen bounds and mesh bounds itself, taking the World from `BabylonEditorContext`. It
  draws through the three modules below and reaches renderer-level features through
  `BabylonEditorContext.renderer`. Its only members beyond the seam are `sync(world)` and `dispose()`,
  which the renderer calls. `BabylonRenderer.editorTools()` and `loadEditorTools()` return it. The modules
  it composes are private.
- **`babylon/editorGuides.ts`: `BabylonEditorGuides`** draws the grid and axes, selection outlines and
  the editor's overlay (with its own `HandleBatch` for handles). It also keeps the count of overlay objects
  drawn. It provides the `IconStyle` the icons read: colours, `isOutlined`, `countDraw`.
- **`babylon/editorIcons.ts`: `BabylonEditorIcons`** draws camera, light and particle system icons and the
  camera and light wireframes. One sync loop runs over a table of icon kinds (`ICON_KINDS`). The module
  also holds the software icon painter and `emitLightSegments`/`lightSegments`.
- **`babylon/editorBatches.ts`** holds what both drawing modules use: `LineBatch`, `partOfMesh`,
  `overlayMaterial`, the colour helpers, `OVERLAY_GROUP`, and the view frame (`readView`).

Behaviour does not change. Tests go through the adapter's interface: `drawn()`, `lightIcons()`,
`overlayHandles()`, `pick()` and `grid()`, plus the Babylon scene the test owns. Plane hits are tested
through `ViewportHandle.pointOnPlane`.

## Alternatives considered

- **Keep `BabylonEditorTools` and only split `editorOverlays.ts`.** This leaves a module whose interface is
  as large as its implementation, plus a fourth class to read on every change.
- **Make each helper implement part of `ViewportAdapter`, with a factory that merges them.** That is still
  forwarding, only harder to see, and the World-or-nothing rule would still be spread across helpers.
- **One icon module per kind.** The three kinds differ only in data: picture, size and wireframe.
  Separate modules would bring back the duplicated loop.

## Consequences

**Positive**
- One module fewer, and no forwarding layer. A query reads top to bottom in the module that answers it.
- Adding an icon kind means adding a table entry, not a fourth loop.
- Test-only members are gone. Tests check what the editor sees.

**Negative / costs**
- `BabylonEditorViewport` still forwards its setters to the guides and gizmo. These are one-line calls, and
  the module also does real work (picking and queries).

## Deprecates

Removed: `babylon/editorTools.ts` (`BabylonEditorTools`), `babylon/editorQueries.ts` (`BabylonEditorQueries`,
`pointOnPlaneZ`, its `pointOnPlane`), `babylon/editorOverlays.ts` (`BabylonEditorOverlays`,
`cameraGizmoCount`, `particleGizmoCount`, its `pickOverlayHandle`, the unused `_world` parameters). Their code
moved to the four modules above.

## Open questions

None.

## References

- `src/engine/render/babylon/editorViewport.ts`, `editorGuides.ts`, `editorIcons.ts`, `editorBatches.ts`
- Tests: `src/engine/tests/babylonEditorViewport.test.ts`, `babylonEditorDrawing.test.ts`, `babylonEditorPicking.test.ts`, `lightGizmo.test.ts`
