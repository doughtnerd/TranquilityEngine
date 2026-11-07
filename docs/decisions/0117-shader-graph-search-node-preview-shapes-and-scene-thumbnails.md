# 0117. Shader graph search and node preview shapes; material and scene-camera thumbnails

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0046, 0048, 0061

## Context

Three gaps were listed as missing: the Shader Graph editor (0046) can't search inside a graph, its node previews (0048) are all flat quads, and the Assets panel (0061) has no thumbnail for a scene. Material thumbnails (a material on a sphere) already exist, are keyed by content and dependencies, and show in the Assets tiles (`tests/e2e/thumbnails.spec.ts`); nothing was changed for them.

## Decision

**Find in graph.** Ctrl+F (or the toolbar's Find button) opens a find box over the canvas. `shaderGraph/graphSearch.ts` is a pure matcher: case-insensitive substrings, every word must match the same item, over node titles and types, property names and other node settings, Custom Function names, sticky note text and group titles. The box lists the matches; Enter or Arrow Down goes to the next, Shift+Enter or Arrow Up to the previous (wrapping), a click picks one, Escape closes. Going to a match selects the node (a group selects its members) and frames it with the canvas's `frameAll`; a note is framed by its rectangle.

**Node preview shapes.** Node previews exist (0048), so the shape is a per-node and per-graph option, kept in the graph file as editor metadata: node `previewShape` (`quad`, `sphere` or `cube`) and graph `previewShape`, the default for nodes without their own; quads are the default and aren't written for the graph. The node's value wins, then the graph's, then quad. The toolbar has a "Previews" select (the graph default) and, with one node selected, a "Selected" select (Graph default, Quad, Sphere, Cube). `NodePreviewRenderer.draw` takes the shape; a sphere or cube is drawn on the same offscreen engine and orthographic camera as the quad (the cube turned to show three faces). The shape is not part of the shader: `nodePreviewGraph` strips it, so changing it doesn't recompile anything. **The main preview's mesh is saved too** (added 2026-11-07): graph `previewMesh` (`sphere`, `cube`, `capsule` or `plane`; spheres are the default and aren't written), set by the preview's mesh select and read when the graph opens; like the shapes it is editor metadata and never part of the shader.

**Scene thumbnails.** `*.scene.json` becomes a preview kind (`scene`) of the thumbnail renderer. `render/sceneFlatten.ts` (no Babylon) turns a scene or prefab file into a flat node list: prefab instances are expanded, including nested ones, component field overrides are applied, and inactive nodes and their children are left out. The renderer draws the meshes and sprites as prefab thumbnails do (that code is now shared), puts the scene's own lights in place of the default ones when it has any, and aims a camera like the scene's main camera (lowest depth, the first in the file on a tie): its projection, field of view or orthographic size, near and far, and its background colour as the clear colour. The thumbnail is square, so an orthographic camera shows its full height, as wide. A scene without a camera is framed like a prefab. Cache keys are unchanged in kind: SHA-256 over the format version, the kind, the scene's bytes and its dependencies' (every project file its JSON names: prefabs, materials, models, textures, sidecars, followed transitively). `THUMBNAIL_FORMAT` goes to 2 because prefab thumbnails now expand nested instances and skip inactive nodes.

### UI picking in the scene view

Scene-view clicks on UI use the UI core's layout boxes (`pickAll`: screen canvases by `sortOrder`, world canvases by ray, skipping `display:none` and hidden elements). Hits split into painted elements (a visible fill or border, non-empty text, an image, a button, or an input field with a value or placeholder) and bare layout containers. Painted UI is chosen before scene hits (colliders, then renderers). Bare containers come after them, so a transparent full-screen panel never blocks selecting what is behind it. Repeated clicks at the same spot cycle through that order. Shift/ctrl keep their meaning, using scene hits only. **Canvases are clickable too** (`UICore.pickCanvases`, `pickUICanvases` in `engine/editor`): a world canvas is a plane in the scene, so clicking anywhere in its rectangle (ray hit, nearest first) selects it; a screen canvas covers the whole view, so only an 8 CSS pixel strip along the inside of its frame (`onFrameEdge`) selects it, and its bare interior still deselects. Canvas hits join the bare tier last, after painted UI, scene hits and bare containers, so they never steal a click from content and cycle with repeated clicks like the rest. Alternatives rejected: selecting a screen canvas on any bare click (breaks click-on-empty-deselects), and an extra drawn header handle (more editor overlay for little gain; the hierarchy remains the other route). Play-mode routing (`Input.pointerOverUI`) is unaffected.

## Alternatives considered

- **Instantiate the scene in a headless World** — would give exact scenes (scripts, overrides of every kind), but scripts and the whole runtime would have to run for a still image, and a thumbnail must never run user code.
- **Match with fuzzy scoring in the find box** — more forgiving, but results would reorder as you type; graphs are small enough that substring matching in file order is predictable.

## Consequences

**Positive**
- Large graphs can be searched; node previews can show lighting-dependent patterns on a sphere or cube.
- Scene tiles show what the game camera sees, from the same cached pipeline as the others.

**Negative / costs**
- Scene thumbnails ignore scripts, post-processing, skyboxes, shadows and overrides other than component fields and `active`; a scene built by scripts at runtime shows only its saved nodes.
- Every cached thumbnail renders once more (format bump).

## Deprecates

Nothing.

## Open questions

- ~~Whether the main preview's mesh (sphere, cube, capsule, plane) should also be saved with the graph.~~ Yes, as `previewMesh` (2026-11-07).
- Whether scene thumbnails should honour sky and fog settings.

## References

- 0046 (editor), 0048 (previews), 0061 (thumbnails)
