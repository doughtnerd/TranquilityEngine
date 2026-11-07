# 0107. Scripts change materials through engine `Material` objects, shared per asset or instanced per renderer

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0019, 0043, 0049, 0080, 0106

## Context

0049 gave `MeshRenderer` per-renderer property overrides (`setMaterialProperty`, like Unity's `MaterialPropertyBlock`) and deliberately left out two things: an editable material object, and changing a material asset at run time ("useful for global effects; can be added later"). Games want both: dim every lamp's glow at once, fade one enemy, swap a renderer to a damage material, switch a shader keyword (0106). Unity's `renderer.sharedMaterial` (the asset, shared) versus `renderer.material` (a per-renderer copy made on first access) is what most of our users know.

0010 forbids Babylon types in the public API, and `MeshRenderer.material` is already the serialized asset path (scenes and prefabs store it), so it can't become an object.

## Decision

We will add an engine **`Material`** class (no Babylon types) and these members:

```ts
// Shared: one per material asset. Changing it changes every renderer drawing that asset (runtime only, never saved).
const glow = Material.shared("asset:materials/glow.material.json");
glow.setColor("emission", Color.from("#ff8800"));

// Per renderer.
renderer.sharedMaterial;          // Material | null — slot 0's: the asset's shared Material (or the instance assigned)
renderer.materialInstance;        // Material — this renderer's own copy, made on first access (Unity's renderer.material)
renderer.sharedMaterial = other;  // draw another Material (shared or an instance)

// Material
m.setColor(name, color); m.setFloat(name, n); m.setVector(name, v); m.setTexture(name, path);
m.getColor(name); m.getFloat(name); m.getVector(name); m.getTexture(name); m.hasOverride(name); m.clear(name); m.clearAll();
m.setKeyword("RIM", true); m.setKeyword("QUALITY", "HIGH"); m.getKeyword("RIM"); m.isKeywordEnabled("RIM");
m.clone();          // an independent instance with the same asset and values
m.asset;            // the material asset's path it reads its defaults from
m.isInstance;       // false for a shared Material
new Material("asset:materials/base.material.json"); // an instance not tied to any renderer yet
```

Rules:
- A Material is **the asset plus runtime values**: names are the asset's properties (a graph's or shader asset's property names, or the built-in fields `color`, `emission`, `metalness`, `roughness`, `texture`, `normalMap`, and the physical fields), and keywords (0106). A value it doesn't set reads the asset's.
- **Shared** Materials are one per asset path for the Engine (assets are Engine-wide), and every World's renderer applies their values to the asset's Babylon material in place. They are reset when the editor leaves play mode (`Material._resetShared()`), so play never leaks into editing; a game never writes them to disk.
- **Instances** (`materialInstance`, `clone()`, `new Material`) are copies made at that moment: later changes to the shared Material don't reach them. The renderer draws an instance with its own Babylon material (a graph or shader asset copy shares the compiled program, a built-in copy is a clone), so an instance breaks GPU instancing for that renderer (0108), as in Unity.
- 0049's `setMaterialProperty` stays: it layers on top of whichever Material the renderer draws, per renderer, without making a Material object.
- Setting `renderer.material` (the path) drops an assigned instance; assigning a shared Material sets `renderer.material` to its asset.
- Material changes are runtime state: not saved, not replicated (as 0049).

### Material slots (composes with 0089)

0089 (branch `claude/gltf-import`) gives a renderer a material slot per material its model uses, with `MeshRenderer.materials: string[]` (a material asset per slot, falling back to `material`, then the model's import settings, then the model's own material). The Material API is slot-indexed to match, Unity-style:

```ts
renderer.getSharedMaterial(slot = 0); renderer.setSharedMaterial(slot, m);
renderer.getMaterialInstance(slot = 0);       // Unity's renderer.materials[i] (a copy on first access)
renderer.sharedMaterials;                     // every slot's Material (get and set)
renderer.sharedMaterial / materialInstance;   // slot 0 (Unity's sharedMaterial / material)
```

- A slot's path is `materials[slot]` when the renderer has that list and the entry is set, else `material`. Setting slot 0 writes `materials[0]` when that entry is set, else `material` (the renderer-wide asset, which is what single-slot renderers have always used); setting another slot writes `materials[slot]`.
- Slots without an entry of their own draw the renderer-wide `material`, so for a renderer without a `materials` list (the common case) slot 0 is the whole renderer, as before.
- **Merge resolution with 0089 (applied when 0089 reached master):** keep both. In `components.ts`, `slotPath`/`setSlotPath` read the typed `materials` field directly (drop the cast and `extraSlotPaths`). In `BabylonRenderer.syncMesh`, resolve each slot's Babylon material through `drawnMaterial(r, slot)` (a slot's script Material: its instance's copy, or the slot asset's material with shared values applied) instead of `materialAsset(r.materials[i])`, keep 0089's fallbacks (renderer `material`, sidecar, model's own) for slots without one, then hand the per-group result to 0108's batches: a single material keys the batch as now; several (a `MultiMaterial`) should be cached by the tuple of slot materials per model mesh, so identical renderers still share a batch and draw instanced. 0049 overrides stay on `material` (0089 already says so).

## Alternatives considered

- **`renderer.material` as the instance, path renamed** — matches Unity's names exactly but breaks every scene, prefab and script that uses the path field.
- **Only global setters (`Materials.set(path, name, value)`)** — no object to pass around, clone or assign; keywords and instances need one anyway.
- **Expose Babylon's material** — forbidden by 0010, and ties scripts to Babylon's property names.

## Consequences

**Positive**
- Unity-shaped shared/instance semantics with engine names; global effects and per-object changes both work.
- Keywords can be switched from scripts; pairs with 0106's `variants: "all"` for hitch-free switches.

**Negative / costs**
- Two ways to change one renderer (an instance, or 0049 overrides); the docs say when to use which (overrides for per-frame tweaks that keep batching… an override also makes its own copy, so neither batches).
- Shared Materials apply values to Babylon materials in place, so a built-in material keeps an untouched copy to reset from.

## Deprecates

Nothing.

## Open questions

- Saving runtime material changes back to the asset from play mode (Unity writes `sharedMaterial` changes to disk in the editor; we deliberately don't).
- Replicating material changes in multiplayer.
- A Material made from a shader asset without a material asset (`Material.fromShader(path)`).

## References

- Unity `Renderer.material` / `Renderer.sharedMaterial`, `Material.EnableKeyword`.
- `src/engine/render/Material.ts`.
