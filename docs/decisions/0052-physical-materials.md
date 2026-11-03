# 0052. A physical material and graph target for clearcoat, sheen, transmission, iridescence and anisotropy

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0043, 0047, 0050

## Context

The default lit material (0043) is three.js's `MeshStandardMaterial`: metalness and roughness. High-fidelity scenes need the features of `MeshPhysicalMaterial`: clear lacquer over paint (clearcoat), cloth (sheen), glass and liquids (transmission with thickness and index of refraction), soap-bubble and beetle-shell colours (iridescence), brushed metal (anisotropy) and tinted specular. three.js switches each feature on with a shader define when its value is above zero, so unused features cost nothing.

## Decision

- **Material assets** get a third built-in shader, `"physical"`: everything `lit` has, plus `clearcoat`, `clearcoatRoughness`, `sheen` (0–1), `sheenColor`, `sheenRoughness`, `transmission`, `thickness`, `ior` (1–2.333, default 1.5), `iridescence`, `iridescenceIOR`, `anisotropy`, `anisotropyRotation` (degrees), `specularIntensity` and `specularColor`. Only values that differ from the defaults are written; all default to off. The Material inspector shows them for physical materials, grouped (Clearcoat, Sheen, Transmission, Iridescence, Anisotropy, Specular).
- **Shader graphs** get a third target, `"physical"`. Its output node adds Clearcoat, Clearcoat Roughness, Sheen Color, Sheen Roughness, Transmission, Thickness, IOR, Iridescence and Specular Intensity inputs. A feature is compiled in only when its input is connected or set above zero, so the graph pays only for what it uses. The compiler marks which features are on; the backend turns them on in the `MeshPhysicalMaterial` (setting the matching value above zero, which three needs to emit the define) and overrides three's values after `lights_physical_fragment` (and inside `transmission_fragment` for transmission and thickness).
- `setMaterialProperty` (0049) accepts the physical field names for built-in physical materials.

## Alternatives considered

- **Physical features on the lit shader.** One shader fewer, but every lit material would compile `MeshPhysicalMaterial`'s extra code paths and uniforms; three keeps them separate for the same reason.
- **Only through shader graphs.** Graphs can do anything, but glass or car paint shouldn't need a graph.

## Consequences

**Positive**
- Glass, car paint, cloth and iridescent surfaces with a material file; graphs reach the same features.

**Negative / costs**
- Transmission renders the scene behind transparent objects into an extra target, a real cost on low tiers; tier-dependent fallbacks are left to graphs' Quality Branch nodes (0050).
- Patching `transmission_fragment` ties graphs to that chunk's text, unit-tested against three's source like the other patch points.

## Deprecates

Nothing.

## Open questions

- Texture maps for the physical fields (clearcoat maps, sheen maps, transmission maps).
- Dispersion and diffuse roughness (new in three r17x+).

## References

- three.js `MeshPhysicalMaterial`; `ShaderLib.physical` (meshphysical.glsl.js), `lights_physical_fragment`, `transmission_fragment`.
