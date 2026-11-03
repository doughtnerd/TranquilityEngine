# 0043. Meshes, lights and material assets: a default lit material and default lighting

- **Status:** Proposed
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010, 0013, 0014, 0022, 0040, 0044

## Context

ADR 0004 names `MeshRenderer` and `Light` as engine components that three.js backs, and 0010 keeps three.js out of the public API. Until now the engine drew sprites and text only: no meshes, lights or materials (implementation status, 0004 row). Imported models (0044) and built-in shapes need something to draw them with, and a default look that works with no setup, the way a new Unity scene does.

Constraints: materials must be editable in the editor's Inspector and saved as data (0013), with no three.js types in what game code sees; the editor themes its own colours but not the game's; the Tauri webview baseline means WebGL2 (0003).

## Decision

We will add two render components and a material asset, all engine-native:

- **`MeshRenderer`** (`engine.MeshRenderer`): `mesh` (an `AssetRef`: a model, one mesh of a model with `#name` (0044), or a built-in mesh `builtin:cube | sphere | capsule | cylinder | plane | quad`, Unity's sizes), `material` (an `AssetRef` to a material asset; empty uses the model's own materials, or the default material), `castShadows`, `receiveShadows`. Meshes are depth-tested; sprites keep drawing over them in sorting order (0014).
- **`Light`** (`engine.Light`): one component with a `type` of `directional | point | spot | ambient` (Unity's single Light component, with ambient folded in), `color`, `intensity`, `range` (point and spot), `spotAngle` and `spotSoftness` (spot), `castShadows` and `shadowArea` (a directional light's shadow box, in metres around its node). Directional and spot lights shine down the node's -Z axis, as cameras look. Intensities are three.js's physical ones: 1 is full brightness for a directional light; point and spot lights fall off with the square of distance.
- **Material assets**, `*.material.json` (`"format": "myco.material@1"`): `shader` (`lit`, the default physically based material, or `unlit`), `color` (`#rrggbb` or `#rrggbbaa`; alpha below 1 is see-through), `texture` and `normalMap` (asset paths), `tiling`, `metalness`, `roughness`, `emission`, `doubleSided`. Only values that differ from the defaults are written. Bad values warn and use the default; another format is refused. The public type is `MaterialSettings`.
- **The default material** is the lit one, white, roughness 0.5. Materials that come with a model (Phong, Lambert…) are converted to it on import, so every mesh is lit the same way.
- **Default lighting:** a World with no enabled `Light` gets a soft ambient light and a sun from above, so meshes never draw black; adding any Light turns them off. Lit materials also reflect a soft studio environment (three.js's `RoomEnvironment`, loaded with the first mesh) at low intensity, so metals and glossy surfaces look right without a skybox.
- **Shadows** are three.js shadow maps, switched on the first time a Light casts shadows.
- **Editor:** the Hierarchy's Create menu adds Cube, Sphere, Capsule, Cylinder and Plane (each with a matching collider, as in Unity, 0045) and Directional, Point, Spot and Ambient lights; the Empty 3D project template has a sun and an ambient light. The Assets panel's New Material writes a default material; selecting one shows a material editor in the Inspector that saves each change to the file, and every mesh using it updates. Lights show icons in the scene view (clickable, like camera icons) and wireframes: a directional light's direction, a spot light's cone, and a selected point light's range. Selected meshes get a box outline; picking, framing (F) and box selection see meshes.

Everything three.js stays inside the render backend; scene data holds only ids, paths and numbers.

## Alternatives considered

- **Materials as fields on MeshRenderer.** Simpler, but every renderer would carry its own copy and nothing could share a look; Unity's material assets are what users expect, and the asset can grow a custom shader (0004's `Shader` assets) later.
- **Separate DirectionalLight / PointLight / … components.** Godot-style; more classes for the same fields, and changing a light's kind would mean replacing the component. One `Light` with a `type` matches Unity.
- **Ambient light as a project or scene setting.** Unity keeps it in lighting settings, but a component needs no new settings UI and lives in the scene like the other lights.
- **No default lighting.** Correct but hostile: a new model would draw black until the user found the Light component.
- **Raw three.js materials through an escape hatch.** Ruled out by 0010.

## Consequences

**Positive**
- Models and shapes draw lit and shadowed with no setup, in the editor, Play mode and game builds.
- Materials are plain JSON assets, shared, diffable, and edited live in the Inspector.
- The component shapes follow Unity's, so scripts and expectations carry over.

**Negative / costs**
- Physical light units make point lights look dim at intensity 1 beyond a metre; the docs say so.
- A directional light's shadows cover a fixed box around its node (`shadowArea`), not the camera's view (no cascaded shadow maps yet).
- Sprites always draw over meshes (sprites don't depth-test); mixing them in one scene needs care.
- The default environment adds a small texture and a one-off render when the first mesh appears.

## Deprecates

Nothing.

## Open questions

- Custom shaders as `Shader` assets (0004) and how a material names one.
- Several materials on one renderer (one per geometry group); today a material asset replaces all of a model's.
- Skyboxes and environment maps as assets, replacing the built-in studio environment.
- Cascaded shadows for large outdoor scenes; baked lighting.
- Instancing many copies of one mesh.

## References

- three.js `MeshStandardMaterial`, lights and shadows: https://threejs.org/docs/
- Unity Light component and materials, for the field names.
