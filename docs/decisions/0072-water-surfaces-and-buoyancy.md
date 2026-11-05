# 0072. Water surfaces with Gerstner waves, sampled the same on the CPU for buoyancy

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0043, 0045, 0047, 0050, 0052, 0053, 0071

## Context

Ocean games need a moving water surface that looks good and that objects float on. With the shader graph (0047/0048), a Gerstner wave sum can be written in Vertex Offset. But a script has to compute the same height for buoyancy, and keeping the two in step by hand breaks the moment someone edits one. Crest foam, normal detail, depth colour and Fresnel reflection are also the same in every water game. So water is engine work, not a sample's.

## Decision

- **Component** `WaterSurface` (`src/engine/render/water/`). It draws a square grid of `size` world units centred on its node, in the node's XZ plane, with `resolution` vertices per side (tier-scaled: Low ×0.5).
  - `waves`: up to 8, each with `direction` (degrees), `wavelength`, `steepness` 0–1 and `speed` (0 means the deep-water speed √(g·L/2π)).
  - `waveScale`: multiplies every wave's amplitude. A storm raises it at runtime.
  - Colours: `deepColor`, `shallowColor`, `foamColor`.
  - `foamAmount`: crest foam comes from the waves' Jacobian, so foam forms where crests fold.
  - `normalDetail`: scrolling procedural ripples (two noise normal layers) on top of the waves.
  - `roughness`, `opacity`, `reflectivity`.
- **Shading.** The surface uses a `MeshPhysicalMaterial` patched in `onBeforeCompile`. Vertices are displaced by the Gerstner sum and its analytic normal. Colour mixes deep to shallow by view angle and wave height. Fresnel reflects the World's environment (0053) and reflection probes (0054). It takes fog (0071), receives shadows, and is treated as opaque by default (`opacity` < 1 switches it to transparent).
- **CPU sampling.** `WaterSurface.sample(x, z)` returns `{ height, normal }` in world space from the same wave set, `waveScale` and time, by a few fixed-point iterations of the Gerstner inverse (horizontal displacement), so it matches the drawn surface. `Water.sample(x, z)` uses the World's first enabled surface. The maths lives in one file (`water/gerstner.ts`) that both the shader generator and the sampler use. The shader's GLSL is generated from the same constants.
- **Time.** The water clock is the World's scaled time. In a networked World it's `Time.network.tick / tickRate`, using the server tick on clients, so a server and its clients see the same waves within a frame.
- **Buoyancy** component (`src/engine/physics/Buoyancy.ts`):
  - `points`: local sample points. Default: four corners of `size`.
  - `mode: "physics" | "kinematic"`. Physics adds an upward force per submerged point, proportional to depth × `strength`, plus `drag` and `angularDrag` while submerged, to the node's 3D `RigidBody`. Kinematic sets the node's height to the mean height of its points, and its pitch and roll to the fitted plane, eased by `follow` (for scripted ships and props).
  - `submerged`: the fraction of points under water, read-only.
  - It runs in a fixed-step system after scripts and before the physics push.
- **Headless.** Sampling and buoyancy need no renderer, so servers float objects identically.
- **Editor:** Create > 3D > Water, with a preset of four waves. Waves are an inspector list (0042).

## Alternatives considered

- **FFT ocean (Tessendorf).** It looks best, but needs float render targets and several GPU passes per frame, and the CPU can't sample it cheaply without reading back. Too much for the Low tier and for headless servers.
- **Leave it to the shader graph.** Flexible, but every game would rewrite the same waves twice (GLSL and TypeScript) and keep them in step by hand.

## Consequences

**Positive**
- Good-looking water and objects that float on it, with one parameter set, the same on server and client.
- Storms: one field (`waveScale`) changes both the look and the physics.

**Negative / costs**
- Gerstner waves repeat. Eight waves hide it from a ship-game camera, but not from close up.
- No shoreline foam or depth fade against geometry (that needs a depth texture). Shallow colour is driven by view angle and height, not by real water depth.
- No refraction or underwater rendering.

## Deprecates

- Nothing.

## Open questions

- Depth-based shoreline foam, when a depth pre-pass exists outside post-processing.
- Large oceans by camera-following LOD rings instead of one grid.

## References

- GPU Gems ch. 1, "Effective Water Simulation from Physical Models" (Gerstner waves)
- `src/engine/render/shaderGraph/threeMaterial.ts` (`onBeforeCompile` patching), `src/engine/physics/Physics3DWorld.ts`
