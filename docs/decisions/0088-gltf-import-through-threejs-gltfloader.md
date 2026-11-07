# 0088. glTF 2.0 models import through three.js's GLTFLoader, baked into model space like OBJ and FBX, with the file's node tree kept for the editor

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0040, 0043, 0044, 0045, 0052, 0061, 0075, 0081, 0089, 0090

## Context

Models load from OBJ (with MTL) and FBX only (0044), through three.js's loaders in `scene/models.ts`, baked into renderer-neutral meshes (`MeshData`, `SurfaceInfo`) that the Babylon backend (0075, 0081) and 3D physics (0045) read. glTF 2.0 is the format most free assets, Blender exports and asset stores now ship, and the only one with a standard PBR material; 0044 left it as its first open question.

glTF brings things OBJ and FBX loading doesn't have to deal with:

- **Files:** `.gltf` is JSON whose buffers and images are embedded (`data:` URIs) or external files beside it; `.glb` is a binary container. In the editor every project file is a blob URL, so a relative `uri` can't be resolved against the model's URL; headless (the dedicated server) files are `file:` URLs Node's `fetch` can't read.
- **Compression extensions:** Draco (`KHR_draco_mesh_compression`), meshopt (`EXT_meshopt_compression`, often with `KHR_mesh_quantization`) and KTX2/Basis textures (`KHR_texture_basisu`) each need a decoder.
- **Materials:** metallic-roughness PBR with textures (base colour, metallic-roughness, normal, occlusion, emissive), alpha modes, and extensions (emissive strength, clearcoat, sheen, transmission, volume, IOR, specular, iridescence, unlit, texture transforms). The engine's material system (0043, the `physical` shader of 0052) already covers those layers on Babylon's PBR material.
- **Structure:** a node tree, meshes of several primitives (one material each), GPU instancing, skins, morph targets, animations, cameras and lights.

Candidates for the parser, measured on the installed packages:

| | Babylon `@babylonjs/loaders` (glTF 2) | three.js `GLTFLoader` | Own parser |
| --- | --- | --- | --- |
| New dependency | yes (Apache-2.0; 7.4 MB unpacked package) | no (MIT, in `three`, which 0081 keeps for loaders) | no |
| Output | Babylon meshes in a Babylon `Scene` (needs an engine; headless means `NullEngine`) | three.js objects, which `bakeMeshes` already turns into neutral data | neutral data directly |
| Size | the glTF loader and its extensions, plus a scene per load | 46 KB minified (13.6 KB gzipped) plus the meshopt decoder 26 KB, loaded on demand | smallest, but every extension written and maintained by us |
| Decoders | Draco, meshopt, KTX2 fetched from Babylon's CDN by default | Draco and KTX2 through workers and decoder files served by URL; meshopt bundled | none |

## Decision

We will import `.gltf` and `.glb` with three.js's `GLTFLoader`, imported on first use in a new internal module `scene/gltf.ts`, and bake its output with the same `bakeMeshes` as OBJ and FBX.

- **Loader:** `GLTFLoader` from `three/examples/jsm`. Its output goes through `bakeMeshes` into `ModelMesh`es and the three.js objects are dropped, as 0081 requires for the other loaders; `threeImports.test.ts` allows `scene/gltf.ts` beside `scene/models.ts` and allows the glTF loader and meshopt decoder. Nothing reaches the public API (0010).
- **Files through the project:** a plugin placed ahead of three's own replaces buffer and image loading. External buffers are found among the project's assets relative to the `.gltf` (with `..` and `%20` resolved) and read with the engine's `fetchBytes` (`file:` from disk headless). A missing buffer fails the load with its name; a missing image warns once and draws white.
- **Images aren't decoded while parsing.** Each texture carries its image's URL (the project asset, the `data:` URI, or a blob URL of the bytes in a buffer, revoked when the model unloads) and MIME type in `TextureInfo`; the Babylon backend decodes it. Parsing works headless and costs no image decode before first use.
- **Draco** decodes in-thread with Google's pure-JavaScript Draco decoder (the glTF build three ships, 513 KB), vendored as an ES module at `scene/vendor/draco_decoder.js` (Apache-2.0, unchanged but for a header shadowing `process`, `module`, `exports` and `define`, and an `export`). It loads only for a Draco file and works in the browser, Tauri and Node without workers, wasm URLs or `eval`. **meshopt** uses three's bundled `meshopt_decoder.module.js`. **KTX2/Basis** images go to Babylon's KTX2 loader (registered on the first KTX2 texture), flipped in the texture matrix since compressed images can't be flipped on upload; Babylon fetches its transcoder from its CDN (see Consequences). WebP and AVIF go to the renderer as they are.
- **Baking:** as 0044: each mesh's world transform, the sidecar's `scale` and `upAxis`, and `normals` are baked into a copy of its geometry, converted to float first (quantized meshes would lose precision). glTF's UVs put v = 0 at the image's top, so the bake flips V to the engine's v-up; `KHR_texture_transform` is baked into the UVs first (per UV set; textures on one set with different transforms warn once and use the first). `EXT_mesh_gpu_instancing` instances are baked into one geometry.
- **One glTF mesh, one engine mesh:** the primitives of a mesh merge into one geometry with an index group per primitive, so the mesh has a material slot per primitive (0089). Primitives with different attributes stay separate meshes (`Name`, `Name_2`). Names follow the glTF node (or mesh) name, made unique as in 0044.
- **Materials:** `SurfaceInfo` grows optional fields read from glTF's materials: emissive colour (times `KHR_materials_emissive_strength`) and texture, normal map and scale, metallic-roughness texture (roughness in green, metalness in blue), occlusion texture and strength, alpha mode (`opaque`, `mask` with its cutoff, `blend`), unlit (`KHR_materials_unlit`), vertex colours (`COLOR_0`), a second UV set (`TEXCOORD_1`, chosen per texture), and the physical layers' factors (clearcoat, sheen, transmission, thickness, IOR, specular, iridescence). The Babylon backend maps them onto its PBR material (`render/babylon/materials.ts`) the way 0052's `physical` shader does. The physical layers' own textures, `KHR_materials_anisotropy`, `KHR_materials_variants` and `KHR_materials_dispersion` are not read. FBX and OBJ materials gain the emissive, normal, occlusion and alpha-test fields too where their loaders fill them.
- **Node tree:** each `ModelMesh` records `path`, the names of the nodes above it in the file. The editor's drop (`modelNodeEntries`) builds that tree: an empty node per group node, a mesh's own node as the parent of the nodes under it, and the levels every mesh shares left out (a file whose meshes all sit under one `Lamp` node doesn't add a `Lamp` inside the dropped `Lamp`). Meshes stay in model space (0044), so every node sits at its parent's origin and parts turn about the model's origin.
- **Ignored, for the animation design:** skins (skinned meshes bake in their bind pose: the mesh node's world transform with the joints ignored), animations, morph targets (the base shape is used), cameras, `KHR_lights_punctual` lights, and scenes other than the default. One warning per model lists what was ignored. Nothing about them is kept in the baked data; the animation design will need the parse to keep the skeleton (joint nodes, inverse bind matrices, `JOINTS_0`/`WEIGHTS_0`) and the clips, which `GLTFLoader` already produces.
- **Unsupported required extensions** fail the load naming the extension (`extensionsRequired` outside the list in `gltf.ts`).
- **Import settings:** the sidecar keys of 0044 (`scale`, `upAxis`, `normals`) apply unchanged; glTF is Y-up in metres, so the defaults fit. Material slots and extraction are 0089.
- **Editor:** `.gltf`, `.glb` and `.ktx2` are project assets (desktop, browser folders, samples, builds; `.bin` already was). glTF models list as "Model", show the Asset Inspector's model settings and preview, get thumbnails (0061; a `.gltf`'s external buffers and images are its dependencies when its text is known), and drop into the scene as the node tree above.
- **Sample:** `samples/playground3d/models/lamp.glb` (8.5 KB, CC0, made for the engine with glTF-Transform): a street lamp of four meshes in a three-level tree, a two-primitive base, an emissive bulb with emissive strength and a blended glass shade. Test fixtures `src/engine/tests/fixtures/gltf/box-draco.glb` and `box-meshopt.glb` come from `make-fixtures.mjs` beside them.

## Alternatives considered

- **Babylon's glTF loader** (`@babylonjs/loaders`). The renderer's own loader with the best extension coverage, but a new dependency whose output is a Babylon scene graph: physics and the dedicated server need the triangles headless, so every load would build Babylon meshes in a `NullEngine` scene and copy their vertex data back out, and its decoders download from Babylon's CDN by default. It also bypasses `bakeMeshes`, so the sidecar settings would be applied a second way.
- **Our own parser.** Smallest and exact for the neutral data, but accessors, sparse accessors, quantization, the node tree, instancing and each material extension would be ours to write and test; `GLTFLoader` already does them and three is already a loader dependency (0081).
- **three's `DRACOLoader` and `KTX2Loader`.** Both run in workers created from blob URLs and fetch decoder files by URL; that needs the decoder files served in the editor, the player, game builds and Tauri, and doesn't work headless. The in-thread JavaScript Draco decoder is slower than wasm but works everywhere with nothing to serve. KTX2 needs a GPU-format choice that only the renderer can make, so it goes to Babylon.
- **Keeping the file's nodes with their own transforms** (meshes in node space). Real pivots for parts like wheels, but the nodes go stale when the sidecar's scale or axis changes, and a whole-model reference would need per-mesh transforms in the renderer and physics (0044 weighed the same). Left as an open question.

## Consequences

**Positive**
- The most common modern format loads in every place models load, including headless and in game builds, with Draco and meshopt compression, with no new dependency.
- glTF's materials keep their look: textures, alpha modes, emission and the physical layers map onto the same PBR material the engine's material assets use.
- A multi-primitive mesh is one mesh with material slots, the shape 0089 needs.
- Parsing decodes no images, so the dedicated server and tests load glTF files without image support.

**Negative / costs**
- New on-demand chunks in the player build: `GLTFLoader` 46 KB (13.6 KB gzipped), the meshopt decoder 26 KB (7.3 KB), the engine's glTF module 8 KB (3.4 KB), loaded with the first glTF file; the Draco decoder 446 KB (105 KB gzipped), loaded only for Draco files and slower than the wasm decoder. Nothing is added to games without glTF models.
- KTX2 textures depend on Babylon fetching its KTX2 transcoder from `cdn.babylonjs.com` on first use; offline builds and strict hosts draw those textures as missing. Untested by an automated test (no KTX2 fixture; the transcoder needs the network).
- Parts still turn about the model's origin; the node tree is organisational.
- Skinned and animated models import as static meshes until the animation design lands.
- The vendored Draco decoder must be refreshed by hand when three's copy changes.

## Deprecates

Nothing. 0044's open question "glTF/GLB" is answered here; 0081's "three stays only for the OBJ, MTL and FBX loaders" is extended to the glTF loader.

## Open questions

- Node-space meshes with real pivots, as a sidecar option.
- Serving Babylon's KTX2 transcoder locally (copying `babylon.ktx2Decoder.js` and its wasm into the player) so KTX2 works offline.
- What the animation design needs kept from the parse (skeleton, clips, morph targets) and where it lives in `ModelData`.
- Importing glTF lights and cameras as engine nodes.

## References

- glTF 2.0 specification and the Khronos extension registry.
- `src/engine/scene/gltf.ts`, `src/engine/scene/models.ts`, `src/engine/render/babylon/materials.ts`, `src/editor/assetBrowser.ts` (`modelNodeEntries`).
- Tests: `src/engine/tests/gltf.test.ts`, `src/editor/collider3d.test.ts` (glTF node tree), `src/editor/thumbnails/thumbnails.test.ts`, `src/engine/tests/threeImports.test.ts`.
- three.js `GLTFLoader`, `meshopt_decoder.module.js`; Google Draco; glTF-Transform (fixtures).
