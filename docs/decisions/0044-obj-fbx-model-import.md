# 0044. OBJ and FBX models import through three.js's loaders, as meshes in model space

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010, 0013, 0031, 0040, 0041, 0043, 0045

## Context

3D games need models made elsewhere (Blender, Maya, asset stores). OBJ (with MTL material libraries) and FBX are the two formats most tools export and most free assets come in; glTF is the web's own format but was not asked for first. Models must work wherever assets work: the editor (desktop and browser, read-only samples), Play mode, game builds (0041) and the headless dedicated server, where a mesh collider (0045) still needs the mesh's triangles. 0010 allows "content imported as a unit" to keep its own three.js subtree but keeps three.js out of the public API.

## Decision

- **Loaders:** `.obj` files load with three.js's `OBJLoader`, using `MTLLoader` for the `mtllib` they name when the project has it; `.fbx` files (binary and ASCII) load with `FBXLoader`. They come from `three/examples/jsm`, are imported on first use (games without models don't load them), and are internal (`scene/models.ts`). No new package: they ship with `three`.
- **Meshes in model space:** a model loads into its meshes, each a copy of its geometry with its place in the file and the model's import settings baked in, and a unique name (the file's mesh or node name; `_2`, `_3`… for repeats). Skinning, animation, cameras and lights in the file are ignored for now. A model loads once per path and is shared by every World and by rendering and physics; it loads again when its file or sidecar changes.
- **References:** `asset:models/robot.fbx` is every mesh of the model; `asset:models/robot.fbx#Body` is one mesh (the same `#` syntax as sprite slices, 0040). `MeshRenderer.mesh` and `MeshCollider.mesh` take either.
- **Materials:** a model's own materials (MTL, FBX) convert to the default lit material (0043) with their colours and textures; textures are found among the project's assets beside the model, by name, or in a `textures/` folder there (missing ones draw white, with one warning). A renderer's material asset replaces them.
- **Import settings** go in the model's sidecar `<model>.meta.json` (0040), as three new keys of `ImportSettings`: `scale` (default 1; 0.01 turns centimetres into metres), `upAxis` (`"y"`, the default, or `"z"` for Z-up tools), and `normals` (`"import"`, calculated when the file has none, or `"calculate"`). The public types `ModelUpAxis` and `ModelNormals` name the choices.
- **Loading:** scene loads preload the models they reference (and the textures of their material assets), as they preload images. Headless (Node), textures are left blank and `file:` URLs are read from disk, so the dedicated server builds mesh colliders.
- **Editor:** `.obj`, `.mtl` and `.fbx` are project assets (desktop, browser folders, samples, exports). Models show as "Model" in the Assets panel and drop into the scene (viewport, Hierarchy, or the + button) as a node with a `MeshRenderer` drawing the whole model, or, for a model of several meshes, an empty node with one child per mesh (each drawing `#name` at the parent's origin, since meshes are in model space), so parts can be hidden or given their own material or collider. In the 3D view a viewport drop lands on the ground (y = 0). Selecting a model shows its import settings (Scale, Up Axis, Normals) in the Asset Inspector, applied to its sidecar.
- **Samples:** the 3D Playground (`samples/playground3d/`) has an OBJ crate with an MTL and a hand-written ASCII FBX robot of two meshes.

## Alternatives considered

- **glTF first.** The better runtime format (PBR materials, compact, animation), and three.js's best-supported loader; but the request was OBJ and FBX, which is what most source assets come in. glTF can be added through the same layer later.
- **Converting models to an engine format on import** (a baked JSON or binary mesh beside the file). Faster loads and no loaders at runtime, but an import pipeline and cache to keep in sync with the sidecar, and the editor in a browser has nowhere to run converters. Possible later for game builds.
- **Keeping the file's node hierarchy as engine nodes** (child Transforms as in the file, meshes in their own space). Closer to Unity's model prefabs and gives each part its own pivot, but the nodes go stale when the import scale or up axis changes. Baking into model space keeps the sidecar the single source of truth; the cost is that parts turn about the model's origin.
- **A three.js subtree per model (0010's exception).** Not needed until skeletal animation; flat meshes keep picking, outlines and physics simple.

## Consequences

**Positive**
- Common source formats load with no conversion step, in every place assets load, including headless.
- Import settings live beside the file, as for images and audio, and changes apply live.
- One loaded model serves rendering and physics in every World.

**Negative / costs**
- FBX parsing is slow and memory-heavy for big files, and happens at load time on every start.
- No animation or skinning yet; skinned meshes draw in their bind pose.
- Parts of a multi-mesh model share the model's origin as their pivot.

## Deprecates

Nothing.

## Open questions

- glTF/GLB, and animation (three.js `AnimationMixer`, 0004) with the 0010 subtree exception.
- A baked mesh format for game builds.
- Per-mesh material slots in the sidecar, and mapping a model's materials to material assets.
- Thumbnails for models in the Assets panel.

## References

- three.js loaders: `OBJLoader`, `MTLLoader`, `FBXLoader` (`three/examples/jsm/loaders/`).
- ADR 0040 for the sidecar format and the `#` reference syntax.
