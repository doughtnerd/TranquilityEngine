# 0054. Reflection probes capture local environment maps for the meshes inside them

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0043, 0049, 0050, 0052, 0053

## Context

Lit and physical materials reflect one environment: the Environment component's map or the built-in studio room (0053). Indoors, or anywhere the surroundings differ from the sky, reflections look wrong: a metal sphere in a red room reflects a blue sky. Unity and Godot place reflection probes that capture the scene around a point into a cubemap and give it to nearby objects. three.js has `CubeCamera`, `WebGLCubeRenderTarget` and `PMREMGenerator.fromCubemap`, and lets each material carry its own `envMap`.

## Decision

- A **`ReflectionProbe`** component (`engine.ReflectionProbe`) captures the scene around its node:
  - `size`: a `Vector3`, metres, default 10×10×10. It sets the box of influence, centred on the node.
  - `intensity`: default 1.
  - `refresh`: `onLoad` (the default; captured once after the scene's meshes and textures load) or `everyFrame` (recaptured continuously, round-robin across probes, one face set per frame).
  - Scripts call `probe.capture()` to recapture on demand.
- A mesh whose bounds centre lies inside one or more probe boxes reflects the smallest of them; others reflect the global environment. There's no blending between probes in this version.
- **Rendering.** The backend gives such meshes their own material copies, as for per-renderer properties (0049), with the probe's prefiltered map as `envMap` and its intensity. Captures render the scene from the probe's position with a `CubeCamera`. Editor helpers and the probe's box are hidden; everything else is captured, including the meshes inside the probe (a room's walls belong in its reflection), as in Unity. The result is prefiltered with PMREM.
- **Quality tiers** (0050) gain `reflectionProbes`: `off` (probes ignored, global environment only), `low` (128 px faces), `medium` (256) or `high` (512). Defaults: Low off, Medium low, High medium, Ultra high. Changing it recaptures.
- **Editor.** A probe shows its box as a wireframe when selected. The Hierarchy's Create menu adds a Reflection Probe.

## Alternatives considered

- **Box-projected (parallax-corrected) reflections.** These look right near the walls of a room, but need a shader patch on every material. They can be layered on later; plain probes are the common baseline.
- **Blending the nearest probes.** Smoother transitions between probes, but needs several environment maps per material, which three's materials don't support.
- **Light probes (diffuse spherical harmonics).** A separate feature for diffuse lighting; three's `LightProbe` could add it later.

## Consequences

**Positive**
- Rooms, caves and interiors reflect their surroundings; metals and glass (0052) look right indoors.

**Negative / costs**
- Each capture is six scene renders plus prefiltering; `everyFrame` probes cost that continuously.
- Meshes inside probes get their own material copies (uniforms only; programs are shared).
- Moving meshes don't move between probes until their bounds centre crosses into another box (checked each frame, which is cheap).

## Deprecates

Nothing.

## Open questions

- Box projection; blending; baking captures into assets for builds.
