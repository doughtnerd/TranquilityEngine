# 0089. A MeshRenderer has a material slot per material of its model, filled by `materials[i]`, then `material`, then the model's import settings

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0040, 0042, 0043, 0044, 0049, 0061, 0088

## Context

A `MeshRenderer` (0043) has one `material`. Set, it replaces every material of every mesh it draws; empty, the model's own materials draw (converted to PBR). So a car body with paint, glass and chrome can't have its glass changed without losing the paint, and a model's materials can't be edited in the editor at all: they live inside the file. 0043 and 0044 list "several materials per renderer" and "per-mesh material slots in the sidecar" as missing.

Since 0088 a glTF mesh of several primitives is one mesh with an index group per primitive, and meshes sharing a source material share one `SurfaceInfo`, so a model's materials can be counted and named.

## Decision

- **Slots:** what a `MeshRenderer` draws (every mesh of a model, or one `#mesh`) has a slot per distinct material of its meshes, in order of first use (`materialSlots` in `scene/models.ts`). A mesh without materials (built-in meshes, files without materials) adds one `Default` slot. Slots are named by the model's material; unnamed ones are named `Material N` at import, so names are stable keys.
- **`MeshRenderer.materials: string[]`** (public API, `@field([AssetRef])`): material assets by slot index. Each slot draws, in order of preference: `materials[i]`, then `material` (as today: the whole renderer), then the model's import settings (below), then the model's own material, then the default material. Property overrides (0049, `setMaterialProperty`) still apply to `material` only.
- **Model import settings:** the sidecar (0040) gains `materials`, an object of material asset paths by the model's material name: `"materials": { "Glass": "asset:materials/tinted.material.json" }`. Every renderer of the model draws them unless it sets its own. Parsed leniently (non-string values warn and are skipped; empty strings are dropped); written only when not empty.
- **Rendering:** the Babylon backend resolves each slot and gives a mesh one material when every group resolves to the same one, else a `MultiMaterial` with a submesh per group (now disposed with the mesh; before, multi-materials were never disposed). Scene loads preload the textures of the materials a model's sidecar names. Thumbnails (0061) of models and prefabs resolve slots the same way.
- **Editor:**
  - The Inspector edits `materials` as a list field (0042), suggesting material assets for each item.
  - The Asset Inspector of a model lists its slots, each with a material asset field (placeholder "The model's own"), applied to the sidecar with Apply.
  - **Extract Materials** writes each of the model's materials as `<model folder>/<model> Materials/<Name>.material.json` (colour converted to sRGB, blended alpha in the colour's alpha, metalness, roughness, emission, double sided, base colour texture and normal map; `unlit` for unlit materials, `physical` with its layers when any is set), writes textures embedded in the model as image files beside them (textures already in the project are referenced as they are), and maps every slot to its new asset in the sidecar. What a material asset can't hold yet (emission above 1, emission, metallic-roughness and occlusion maps, alpha cut-out, vertex colours) is listed in the status message.
- **Scope:** slots are per renderer and per model sidecar; there is no per-mesh slot list in the sidecar (a `#mesh` reference has the slots of that mesh's materials, so mapping by material name covers it).

## Alternatives considered

- **Slots per mesh, indexed by the mesh's groups** (Unity's `Renderer.materials` for one mesh). Exact for `#mesh` references, but a renderer drawing a whole model (the 0044 default for one-mesh models and the `Lamp` sample) has several meshes, and their per-mesh indices would collide; slots by distinct material work for both.
- **Slots keyed by name on the renderer** (`materials: { Glass: … }`). Robust to reordering, but needs an object field type the Inspector lacks (0042 has lists, not maps) and differs from Unity's familiar array; the sidecar, edited by its own UI, keys by name.
- **Extracting into the model's sidecar as inline materials.** One file fewer, but material assets are what the material editor, shader graphs and renderers already use.
- **Extending material assets with every glTF map first.** Lossless extraction, but a change to the 0043 format, the material editor and the Babylon material builder; left as an open question.

## Consequences

**Positive**
- Part of a model's look can be changed without replacing the rest, per renderer or for every use of the model.
- Model materials become editable assets in two clicks.
- Existing scenes keep their look: `material` still replaces every slot, and an empty `materials` changes nothing.

**Negative / costs**
- Slot indices follow the model's material order: re-exporting a model with materials reordered moves `materials[i]` to another material (the sidecar's name mapping doesn't move).
- Pipeline warm-up (0080) warms the renderer's `material` or the model's own materials, not `materials[i]` or sidecar mappings, so those can compile on first draw.
- Extraction loses glTF maps material assets lack.
- `setMaterialProperty` doesn't reach slot materials.

## Deprecates

Nothing.

## Open questions

- Material assets with metallic-roughness, occlusion and emission maps and alpha cut-out, so extraction is lossless.
- Per-slot property overrides (`setMaterialProperty(name, value, slot)`).
- Showing slot names beside `materials[i]` in the Inspector.

## References

- `src/engine/scene/models.ts` (`materialSlots`, `DEFAULT_SLOT`), `src/engine/scene/importSettings.ts` (`materials`), `src/engine/render/components.ts` (`MeshRenderer.materials`), `src/engine/render/babylon/BabylonRenderer.ts` (`syncMesh`), `src/engine/render/babylon/materials.ts` (`modelMaterial`), `src/engine/render/babylon/previews/ThumbnailRenderer.ts` (`slotPicker`), `src/editor/materialExtract.ts`, `src/editor/ui/AssetInspector.tsx`.
- Tests: `src/engine/tests/materialSlots.test.ts`, `src/editor/materialExtract.test.ts`.
