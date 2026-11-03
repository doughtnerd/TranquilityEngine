# 0049. Scripts set material properties per MeshRenderer, like Unity's MaterialPropertyBlock

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0019, 0043, 0047

## Context

Material assets (0043) and shader graphs (0047) are data the editor writes; games had no way to change how one mesh looks at run time (flash on hit, a health colour, scrolling speed). Unity offers `renderer.material.SetFloat` (which silently copies the material) and `MaterialPropertyBlock` (per-renderer values over a shared material). three.js materials can't be exposed (0010).

## Decision

`MeshRenderer` gets per-renderer property values that override its material's, without touching the asset or other renderers:

```ts
renderer.setMaterialProperty("Tint", Color.from("#ff0000"));
renderer.setMaterialProperty("Speed", 4);
renderer.getMaterialProperty("Speed");   // 4, or undefined if not overridden here
renderer.clearMaterialProperty("Speed"); // back to the material's value
renderer.clearMaterialProperties();
```

- Values: `number`, `Vector2`, `Vector3`, `Color`, a list of 2–4 numbers, or an asset path (a texture property).
- For a shader graph material, names are the graph's property names. For the built-in lit and unlit materials, the names are the material fields `color`, `emission`, `metalness`, `roughness` and `texture`.
- The render backend gives a renderer with overrides its own copy of the material (sharing the compiled shader program, so no recompile) and updates its uniforms when a value changes. A renderer without overrides keeps sharing the material.
- Overrides are runtime state: not saved in scenes, not replicated, cleared when the component is destroyed. A name the material doesn't have is ignored with one warning.

## Alternatives considered

- **`renderer.material` returning an editable material object.** Unity's design, but it means a script-visible material type mirroring three's, and implicit copies are a known Unity pitfall.
- **Changing the material asset at run time** (`Materials.set(path, …)`). Useful for global effects; can be added later, but per-object changes are the common case.

## Consequences

**Positive**
- Common effects need no extra assets; the asset stays the editor's.

**Negative / costs**
- Each renderer with overrides holds its own material (cheap: uniforms only).
- Values aren't checked against the shader until the backend draws.

## Deprecates

Nothing.

## Open questions

- Changing material assets at run time; replicating overrides in multiplayer (0033).

## References

- Unity `Renderer.SetPropertyBlock`, `MaterialPropertyBlock`.
