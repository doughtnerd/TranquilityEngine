# 0118. glTF imports keep node pivots (opt-in), lights and cameras as engine nodes, the physical layers' textures and anisotropy, and material variants picked on the MeshRenderer

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0043, 0044, 0052, 0081, 0088, 0089, 0090

## Context

0088 imports glTF through three.js's `GLTFLoader`, used only as a parser, and bakes every mesh into model space. It left five gaps, listed as "Missing" in the implementation status:

- **Pivots.** Every mesh is baked in model space and every dropped node sits at its parent's origin, so a wheel turns about the car's origin, not its axle. 0088 kept model space because a whole-model reference (`asset:car.glb`, one MeshRenderer drawing every mesh) and physics need the meshes in one space, and nodes with their own transforms go stale when the sidecar's scale or axis changes.
- **Lights and cameras** (`KHR_lights_punctual`, `cameras`) are dropped with a warning. The engine has matching components: `Light` (directional, point, spot; shining down -Z like glTF; Babylon's glTF falloff, so glTF's candela and lux carry over one to one) and `Camera` (perspective or orthographic, looking down -Z).
- **The physical layers' textures** (clearcoat, clearcoat roughness, clearcoat normal, sheen colour, sheen roughness, transmission, thickness, specular, specular colour, iridescence, iridescence thickness) and volume attenuation are not read; only the factors are. `GLTFLoader` already reads them all onto `MeshPhysicalMaterial`, and Babylon's `PBRMaterial` has a slot for each (its own glTF loader uses them).
- **`KHR_materials_anisotropy`** is not read; `GLTFLoader` reads strength, rotation and texture.
- **`KHR_materials_variants`** (one file, several looks: a shoe in three colours) is listed as supported but only the default materials load; `GLTFLoader` doesn't implement it.

Animation and skinning stay out (the user deferred everything that needs an animation system).

## Decision

**Pivots are an import setting: sidecar `pivots: "model" | "node"`, default `"model"`.** Existing scenes that reference `model.glb#Part` from nodes at the origin keep working; the Asset Inspector's model settings show it as **Pivots** (Model origin / Node). It applies to every model format (`bakeMeshes` is shared; OBJ has no nodes, so it changes nothing there).

- Geometry stays baked in model space in both modes, so a whole-model reference, thumbnails and baked models are unchanged. Each `ModelMesh` records `pose`, its node's model-space pose (position, quaternion, scale, with the sidecar's scale and up axis applied), and `ModelData.nodes` records the group nodes on mesh paths, the lights and the cameras with their poses.
- With `pivots: "node"`, a reference to one mesh (`asset:car.glb#Wheel`) resolves to that mesh in its node's space: a copy of its vertices through the inverse of its pose, made once per mesh on first use (`models.ts` `selectMeshes`). Rendering, physics, navigation and editor bounds all read meshes through it, so they agree. A whole-model reference still draws model space.
- The editor's drop (`modelNodeEntries`) gives each node its local pose (its pose relative to the nearest node kept above it; the levels every mesh shares are still left out, their transforms folded into the nodes below). In `"model"` mode meshes and groups keep identity transforms as before.
- Poses are decomposed TRS: a node tree with non-uniform scale under a rotation loses its shear (as in any TRS engine); the node-space copy is made from the decomposed pose, so the mesh still lands where the file puts it.

**Lights and cameras become nodes when a model is dropped.**

- A `KHR_lights_punctual` light becomes a node with `engine.Light`: type (directional, point, spot), colour (linear in the file, sRGB in the component), intensity unchanged (Babylon's glTF falloff), range (absent: 0, no limit; times the import scale), and for spots `spotAngle` = 2 × `outerConeAngle` in degrees and `spotSoftness` = 1 − inner ÷ outer. Directional and spot lights already shine down -Z in both.
- A camera becomes a node with `engine.Camera`: perspective (`yfov` → `fieldOfView` in degrees) or orthographic (`ymag` → `orthographicSize`), `near`/`far` (times the import scale; no `zfar` → 1000). **The Camera component arrives disabled**, so dropping a model never takes over the view, and the editor logs one message per drop saying so ("model.glb: its 2 camera(s) were added with their Camera turned off; enable one to look through it").
- Lights and cameras get their pose in both pivot modes (in `"model"` mode their group parents sit at the origin, so the pose is their model-space one). Nothing lights or looks through a whole-model reference: they exist only as dropped nodes. They are no longer listed in the "not imported" warning; skins, animations, morph targets and extra scenes still are.

**The physical layers' textures and anisotropy are read into the model's own surfaces.** `SurfaceInfo.physical` gains attenuation colour and distance, the iridescence thickness range and anisotropy (strength, rotation in radians); `SurfaceInfo.layerMaps` holds the layer textures (each a `TextureInfo`, UV set and `KHR_texture_transform` handled as the base maps are). `render/babylon/materials.ts` maps them as Babylon's own glTF loader does: `clearCoat.texture` / `textureRoughness` / `bumpTexture`, `sheen.texture` / `textureRoughness`, `subSurface.refractionIntensityTexture` and `thicknessTexture` with glTF-style channels and `tintColor` / `tintColorAtDistance`, `metallicReflectanceTexture` (specular, alpha) and `reflectanceTexture` (specular colour), `iridescence.texture` / `thicknessTexture` with the thickness range, `anisotropy.intensity` / `angle` / `texture`. Colour maps (sheen colour, specular colour) are sRGB, the rest linear. Baked models (0090) carry them. `KHR_materials_anisotropy` joins the supported extensions.

**Material variants are picked on the MeshRenderer.**

- The parse reads `KHR_materials_variants`: the variant names (`ModelData.variants`) and, per mesh, the surfaces each variant puts on its slots (`ModelMesh.variantSurfaces[name]`, a full surface list where unmapped slots keep the default). Variant materials go through the same conversion as default ones (`GLTFLoader`'s `getDependency("material", i)`).
- **`MeshRenderer.variant`** (string, empty = the file's default materials) picks one. Scripts set it (`renderer.variant = "Red"`) and read the choices from `renderer.variants` (the loaded model's variant names, empty until it loads or without variants). The Inspector shows it as a dropdown of the model's variants, hidden for models without any. An unknown name warns once and draws the defaults.
- **Slot material assets win:** a variant changes only slots that draw the model's own material; a slot with a material asset (`materials[i]`, `material`, or the import settings' remap, 0089) keeps it. Material slots (0089) stay those of the default materials, so slot indices and names don't change with the variant.
- Baked models carry the variants.

## Alternatives considered

- **Node mode as the default.** Real pivots for every new drop, but every saved scene referencing `#Part` from origin nodes would draw parts in the wrong place until re-dropped. The user chose the setting with the old default.
- **Baking meshes in node space and giving whole-model references per-mesh transforms.** One geometry per mesh, but the renderer, physics, navigation, thumbnails and baked models would all need the per-mesh transform. The lazy node-space copy is confined to `selectMeshes`; it costs a second copy of the vertices only for meshes referenced one by one in node mode.
- **Importing cameras enabled** (or with a high depth). The first dropped camera would take over the game view; the user chose disabled plus a message.
- **A variant replacing every slot**, material assets included. It would make a renderer's assigned material assets silently stop applying; the user chose slot assets win.
- **Layer textures on material assets too** (so extracted glTF materials keep their maps). A larger change to the material format, editor and shader graph inputs; left open for discussion (below).
- **Babylon's glTF loader for these extensions.** Rejected in 0088 (new dependency, Babylon scene per load, headless needs); nothing here changes that.

## Consequences

**Positive**
- Hinged parts (wheels, doors, lids) turn about their own axes when a model opts into node pivots, with physics and rendering agreeing.
- Scenes authored in Blender keep their lights and cameras, ready to use, without a dropped model stealing the view.
- glTF's physical materials look as authored: textured clearcoat, sheen, transmission, specular, iridescence and brushed-metal anisotropy.
- One file can ship several looks, switched from scripts or the Inspector, without extra assets.

**Negative / costs**
- `ModelData` grows (poses, nodes, variants) and the baked model format moves to version 2 (older baked files fall back to loading the source model, as for changed import settings).
- In node mode, each mesh referenced on its own holds a second copy of its vertices.
- Variant surfaces each make their own Babylon material when first drawn; a variant switch can compile new shader variants mid-game (warm-up, 0120, doesn't cover variants).
- How glTF materials look on screen is still checked by eye, not by a test.

## Deprecates

Nothing. Answers 0088's open questions "node-space meshes with real pivots, as a sidecar option" and "importing glTF lights and cameras as engine nodes", and its "not read" list except `KHR_materials_dispersion`.

## Open questions

- **Layer textures on material assets** (raised with the user, to discuss): extracting a glTF material to a material asset (0089) keeps the layer factors but drops their maps, because the 0052 physical shader takes only a base texture and a normal map. Adding the maps means new fields, Inspector rows and shader graph physical inputs.
- `KHR_materials_dispersion` (Babylon has `subSurface.dispersion` in newer versions).
- Warming up variant materials (0120) before a switch.
- Light intensity units if the engine's Light ever stops using Babylon's glTF falloff.

## References

- Khronos glTF extensions: `KHR_lights_punctual`, `KHR_materials_anisotropy`, `KHR_materials_variants`, the physical layer extensions.
- `src/engine/scene/gltf.ts`, `src/engine/scene/models.ts`, `src/engine/scene/bakedModel.ts`, `src/engine/render/babylon/materials.ts`, `src/engine/render/components.ts` (`MeshRenderer.variant`), `src/editor/assetBrowser.ts` (`modelNodeEntries`).
- Babylon.js glTF loader extensions (`KHR_materials_*`), for the channel conventions.
