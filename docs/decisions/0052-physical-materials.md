# 0052. A physical material and graph target for clearcoat, sheen, transmission, iridescence and anisotropy

- **Status:** Accepted; how the backend draws physical graphs restated for Babylon.js on 2026-11-07 (see the note under Decision)
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

**Note (2026-11-07), on Babylon.js (0075, 0081).** The three.js mechanics above are gone; the decision holds with Babylon's PBR material in place of `MeshPhysicalMaterial`. The graph material switches on the PBR layers a physical graph uses (clear coat, sheen with its roughness, sub-surface refraction for transmission, iridescence), and the graph plugin replaces those layers' uniform reads in the fragment shader with the graph's values: clear coat and its roughness, sheen colour and roughness, transmission (refraction intensity) and thickness, IOR (the base layer's F0 and the refraction's IOR), iridescence (intensity; its IOR and thickness range keep Babylon's defaults), and specular intensity (the metallic workflow's F0 factor). As with built-in physical materials, transmission refracts the scene's environment, so it shows only where there is one. Physical graphs need WebGPU, as all graphs do (0081).

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
- Graph inputs for anisotropy, iridescence IOR and specular colour (built-in physical materials have them; graphs don't yet).

## References

- three.js `MeshPhysicalMaterial`; `ShaderLib.physical` (meshphysical.glsl.js), `lights_physical_fragment`, `transmission_fragment`.
