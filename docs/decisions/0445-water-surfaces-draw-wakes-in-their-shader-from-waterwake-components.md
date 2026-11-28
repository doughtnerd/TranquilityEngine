# 0445. Water surfaces draw wakes in their own shader, from WaterWake components on moving nodes

- **Status:** Proposed
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0072, 0075, 0222, 0225, 0250

## Context

The pirates sample draws each ship's bow wave and stern wake as two `LineRenderer` ribbons textured with `textures/wake.png` (`samples/pirates/scripts/seaMarks.ts`). Each frame the ribbon points take `Water.sample` heights plus a 6 cm lift so the waves don't swallow them. It reads as a white decal laid on the sea: it doesn't light like water, doesn't bend the surface's reflections, clips into crests at grazing angles, and its texture stretches when the wake grows.

The owner wants the wake to be part of the water: a sea surface disturbed by the boat, as usually done in a water shader (a base Gerstner sum plus a local wave field around the boat that decays with distance, normals from the combined field, Fresnel lighting). The water shader is engine code (ADR 0072, `render/babylon/water.ts`, a PBR material plugin with KSL maths, ADR 0250), so a sample can't add to it. Every boat game needs the same thing, so it belongs in the engine like the waves themselves.

The pirates water grids are 315–382 m across at 200 vertices per side: about 1.6–1.9 m between vertices. A wake's ripples are 0.5–2 m long, so vertex displacement can't draw them; they must be shaded per fragment.

## Decision

**Component `WaterWake`** (`src/engine/render/water/WaterWake.ts`, exported from `myco`), added to any moving node (a ship). Fields:
- `strength` (0–1, default 1): scales everything; a script sets it, or `enabled = false` hides the wake (fog, sinking).
- `fullSpeed` (m/s, default 6): the node's speed at which the wake is at full size; below `restSpeed` (default 0.5) there is none. The component measures the speed from how its node moves (smoothed), so scripts don't have to feed it.
- `width` (m, default 3): the foam band's width at the stern, widening with age.
- `life` (s, default 2.6): how long churned water lasts behind the boat.
- `bow` (m, default 0): the node-local forward distance to the stem, where the bow wave starts; `stern` (default 0): to the stern, where the trail starts.
- `foam` (0–1, default 0.6) and `ripples` (0–1, default 0.6): how white the trail is and how strongly its waves bend the surface.

**Trail recording.** An engine system (`engine.WaterWakes`, lateUpdate, render Worlds only) keeps for each wake a path of up to 16 points the stern has passed, at least 1 m apart, each with its age, dropped at `life`; a jump of more than 8 m in a frame (a respawn) starts a new path. This is `seaMarkShapes.ts`'s `WakePath`, moved into the engine. Following the real path (not an analytic straight-line wedge) keeps the wake true through turns.

**Shader.** Each frame `BabylonWater` packs the World's enabled wakes (up to 16; the nearest to the camera when there are more) into a small float data texture (RGBA32F, 17 texels per wake: a header with the bow position, heading, strength and bounds, then the path points with age and the strength they were laid at), bound to the water material as a sampler next to its uniform buffer. The fragment shader, after the existing ripples and before the colour, for each wake whose bounds hold the fragment, walks its segments and finds the nearest point on the path (distance across `d`, age `a`, distance behind the stern `s`):
- **Foam trail:** a band of half-width `width/2 · (1 + 1.5·a/life)`, broken up by the existing value noise scrolled along the path, fading as `a` reaches `life`. It adds to the water's own foam amount, so it's coloured by `foamColor` and roughened like crest foam.
- **Kelvin waves:** divergent ripples whose crests run at the Kelvin angle (19.47°) to the path, `sin(k·(|d|·cos θ − s·sin θ) − ω·t)`, inside the wedge `|d| < s·tan 19.47° + width`, decaying with `a`. Their analytic slope bends the normal (as the ripples do), so the waves light, reflect and Fresnel like the rest of the sea.
- **Bow wave:** a short V of foam and a raised crest slope from the stem, at the Kelvin angle, sized by speed.

The maths is KSL (one source for WGSL and GLSL, ADR 0250). No vertex displacement: the grid is too coarse for it (see Context).

**CPU sampling is unchanged.** `WaterSurface.sample` and `Water.sample` return the Gerstner surface only. The wake changes normals and colour, not height, so buoyancy, servers (which have no wakes) and the drawn surface still agree.

**Pirates.** Ships get a `WaterWake` in their visual setup; `seaMarks.ts` keeps only what isn't the wake: it sets each wake's `strength` (0 while hidden in someone else's fog or sunk) and creates wakes for the menu backdrop's ships. The ribbons, `textures/wake.png` and its generator in `tools/textures.mjs` are removed. Rain rings stay as they are.

## Alternatives considered

- **Keep ribbons, give them a water-like material.** Still a decal above the surface: it can't bend the sea's own reflections and still clips into crests.
- **Render wakes into a world-space "disturbance" render target the water samples** (a ping-pong height-field simulation around the camera). Real interacting waves, but two extra passes a frame, float render targets on every tier, and a camera-following window to manage; heavy for the Low tier and more than a ship game needs.
- **Analytic straight-line Kelvin wedge from the boat's position only** (the usual shader tip: one uniform per boat). Cheapest, but the wake swings with the boat when it turns instead of staying on the water where the boat was.
- **Vertex displacement of the wake.** Pirates grids have ~1.8 m between vertices; the ripples would alias or vanish.
- **Leave it to the sample with a hand-written shader (ADR 0106) on an overlay mesh.** Duplicates the water's lighting and still layers over the sea.

## Consequences

**Positive**
- The wake is the water: lit, reflective, coloured and foamed by the same `WaterSurface`.
- Any game puts a `WaterWake` on a moving node and gets a wake; no per-frame script.
- The pirates sample loses ~150 lines of ribbon code and a texture.

**Negative / costs**
- Fragment cost: up to 16 wakes × 16 segments per water fragment in the worst case; bounds checks skip wakes far from the fragment, so a typical fragment tests none or one.
- One more sampler on the water material (PBR with shadows already uses many on WebGL2; within the 16 limit).
- Wakes don't raise the surface, so a floating object in a wake doesn't bob on it.
- A bigger public API (`WaterWake`).

## Deprecates

- `seaMarks.ts`' ribbon wakes and bow waves, `seaMarkShapes.ts`' `WakePath` and `bowWave` (moved into the engine or removed; `wakeStrength` goes too, since the component measures speed), `samples/pirates/textures/wake.png` and its generator.

## Open questions

- Wake height (vertex displacement) for fine water grids, and whether `sample()` should then include it.
- Wakes on more than one water surface (each surface draws every wake over it; untested beyond one).

## References

- `src/engine/render/babylon/water.ts`, `src/engine/render/water/gerstner.ts`, `samples/pirates/scripts/seaMarks.ts`
- Kelvin wake pattern (half-angle arcsin(1/3) ≈ 19.47°)
- GPU Gems ch. 1, "Effective Water Simulation from Physical Models"
