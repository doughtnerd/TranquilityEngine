# 0090. Game builds carry each model baked into a `.mycomesh` file, which the engine loads instead of parsing the model

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040, 0041, 0044, 0081, 0088, 0089

## Context

Every start of a game parses its model files with three.js's loaders (0044, 0088): the loader chunk is downloaded, FBX parsing is slow and memory-heavy for big files (0044's first cost), the meshes are transformed and converted to the engine's neutral data, and only then drawn. In a game build (0041) the files and their import settings never change, so that work gives the same result every time. 0044 rejected an import-time baked format for the editor (a pipeline and cache to keep in sync, and the browser editor has nowhere to run converters) but left it open for game builds.

Both exporters (the Node CLI and the editor's Build / Export) already run in places that can load models: the Node exporter reads projects with the dedicated server's reader, which loads models headless, and the editor loads them in the browser.

## Decision

- **What's baked:** a model as `loadModel` returns it — each mesh's vertices (positions, normals, UVs, second UVs, vertex colours), indices, index groups, node path (0088) and surfaces (0088's `SurfaceInfo`), already baked into model space with the model's import settings.
- **Format** (`scene/bakedModel.ts`, internal): one little-endian binary file per model, `<model>.mycomesh` beside it (`models/robot.fbx.mycomesh`): the magic `MYCOMESH`, a version (1), a JSON header (the import settings it was baked with, meshes with offsets into the data, surfaces, embedded images), then the data with every array 4-byte aligned, so loading makes typed-array views of the file without copying. Shared materials stay shared (one surface per material, so one slot, 0089).
- **Textures** are kept by project path (the build copies the image files anyway), or as their bytes when the model file holds them (GLB images, `data:` URIs). One that is neither (an image the loader decoded from somewhere else) is left out and named in the export log. To know paths, model loading now records the project path of each texture it resolves, also headless, where OBJ and FBX textures used to be blank and are now kept as URL and path.
- **Exporting:** after planning a web build, both exporters bake every model the build copies (`withBakedModels` in `export/webBuild.ts`, with `bakeModelFile` from `scene/models.ts`), add the baked files under `project/` and list them in the manifest's `files`. A model that fails to bake is logged and loads from its file. The model files themselves stay in the build (the dedicated server and anything reading them still can).
- **Loading:** `loadModel` uses `<path>.mycomesh` when the assets have it and it was baked with the model's current import settings; otherwise (other settings, a bad or newer file) it warns once and parses the model file. The editor never makes baked files, so projects behave as before; only builds have them.
- **No loader on that path:** a game whose models are all baked never downloads the OBJ, FBX or glTF loader chunks (or the Draco decoder). three.js's core classes still load (`ModelMesh.geometry` is a three.js `BufferGeometry`, made over the baked arrays without copying).

## Alternatives considered

- **Baking at import, in the project** (a cache in `.myco/`, used by the editor too). Faster editor loads, but a cache to invalidate on every file and sidecar change and to keep out of version control; the browser editor would also have to bake in the page. Builds are where the work is repeated with nothing changing.
- **glTF as the baked format** (export every model as GLB). A standard file other tools can open, but the engine would still need the glTF loader at runtime and would rebuild the neutral data from it; the point is to skip both.
- **Dropping the model files from builds.** Smaller builds, but the dedicated server, mesh colliders in another World kind and scripts may still read them; can come later behind an export option.
- **Compressing the baked data** (meshopt or Draco on the arrays). Smaller downloads for big meshes, at the cost of a decoder at runtime; left open.

## Consequences

**Positive**
- Game builds load models without parsing: one fetch and typed-array views, no loader chunk, no FBX parse, no Draco decode.
- The same baked data serves rendering and physics, as the parsed model did.
- A stale baked file can't show the wrong model: the import settings are checked, and a mismatch falls back to the model file.

**Negative / costs**
- Builds are larger: each model's file plus its baked copy (the baked copy of the playground's samples: crate 0.5 KB → 1.7 KB, robot 1.8 KB → 2.7 KB, lamp 8.5 KB → 6.0 KB; uncompressed float arrays are bigger than a compact source and smaller than a padded one).
- Export takes longer by one model load per model.
- Baked files don't keep data the neutral model drops (0088's skins and animations); the animation design will need a version 2.
- No measurement yet on a large model; the speed-up is expected (no parse), not benchmarked.

## Deprecates

Nothing. 0044's open question "a baked mesh format for game builds" is answered here.

## Open questions

- An export option to leave model files out of builds.
- Compressing baked arrays (meshopt) for big models.
- Benchmarking load time on large FBX and glTF files, baked and not.

## References

- `src/engine/scene/bakedModel.ts`, `src/engine/scene/models.ts` (`bakeModelFile`, the baked branch of `parseModel`), `src/export/webBuild.ts` (`withBakedModels`), `src/export/node.ts`, `src/editor/exportBuild.ts`.
- Tests: `src/engine/tests/bakedModel.test.ts`, `src/export/export.test.ts` (the 3D Playground's models baked).
