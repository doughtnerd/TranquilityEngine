# 0451. Water surfaces draw wakes in their own shader, from WaterWake components on moving nodes

- **Status:** Proposed (two ways of drawing wakes are built, switchable, for the owner to compare; one stays)
- **Date:** 2026-11-28
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0072, 0075, 0222, 0225, 0250

## Context

The pirates sample drew each ship's bow wave and stern wake as two `LineRenderer` ribbons textured with `textures/wake.png` (`samples/pirates/scripts/seaMarks.ts`). Each frame the ribbon points took `Water.sample` heights plus a 6 cm lift so the waves didn't swallow them. It read as a white decal laid on the sea. It didn't light like water or bend the surface's reflections, it clipped into crests at grazing angles, and its texture stretched as the wake grew.

The owner wants the wake to be part of the water: a sea surface disturbed by the boat, as water shaders do it (a base Gerstner sum, a wave field from the boat, normals from the combined field, Fresnel lighting). The water shader is engine code (ADR 0072, `render/babylon/water.ts`, a PBR material plugin with KSL maths, ADR 0250), so a sample can't add to it. Every boat game needs the same thing, so it belongs in the engine like the waves themselves.

The pirates water grids are 315–382 m across at 200 vertices per side: about 1.6–1.9 m between vertices. A wake's ripples are 0.5–2 m long, so vertex displacement alone can't draw them; they must be shaded per fragment.

The owner asked for two versions to compare: the per-pixel trail first proposed here, and one driven by a height field.

## Decision

**Component `WaterWake`** (`src/engine/render/water/WaterWake.ts`, exported from `myco`), added to any moving node (a boat; its +Z is the bow). Fields:
- `strength` (0–1, default 1): scales everything. A script sets 0, or `enabled = false`, to hide the wake at once (fog, sinking).
- `fullSpeed` (m/s, default 6): the node's speed at which the wake is full size; below 0.5 m/s there is none. The component's speed is measured from how its node moves (smoothed), so scripts don't feed it.
- `width` (m, default 3), `life` (s, default 2.6), `bow` and `stern` (m along +Z, defaults 2 and −2), `foam` and `ripples` (0–1, default 0.6).

**`WaterSurface.wakeMode`**: `"trail"` (default), `"field"` or `"off"`. The World's first enabled surface decides it for every surface.

**Per-World state** (`render/water/wakes.ts`, renderer-neutral): `updateWakes(world, mode, focus)` measures each wake's speed, records its stern's path (`wakeTrail.ts`' `WakePath`: up to 15 points 1.6 m apart, dropped at `life`; a jump over 8 m in a frame restarts it), and packs the frame for the shader. The water's render feature calls it once per frame with the view camera's focus: its forward ray meeting the water's plane, else the point below it. Only Worlds that draw water call it, so servers keep no wake state.

**Trail mode** (the first proposal). Up to 16 wakes, the nearest to the focus, are packed into a float texture: 20 texels per wake, a header (point count, width, foam, ripples; stem and heading; bounds; bow strength and life) and the path, the stern now first (position, age/life, strength laid at). For each wake whose bounds hold the fragment, the fragment shader finds the nearest point on the path: its signed true distance across, distance behind the stern, age and strength. It draws:
- a foam band widening with age, torn into streaks by noise stretched along the path, fading with age and tapering at the path's end;
- Kelvin waves: divergent crests about 35° off the path inside the 19.47° wedge, transverse crests nearer the path; their analytic slope and height;
- a bow wave: a V of foam and a raised crest from the stem, its arms longer the faster the boat goes.

**Field mode** (the height field). `wakeField.ts`' `WakeField` is a 256 × 256 grid over 96 m (0.375 m cells), centred on the focus and moved by whole cells. It is stepped at 60 Hz on the CPU by the damped 2D wave equation (wave speed 3 m/s, motion damping 0.2/s, height settling 0.25/s), with sponge edges so waves don't reflect. Each hull is an ellipse (stem to stern, beam 0.3 × `width`) that pulls the water under it toward a depression of up to 0.6 m. The depression pulses at 1.6 Hz: the wave equation doesn't disperse, so a steady hull would only make a smooth V front, and the pulses send out ripple trains that the hull's motion lays into a V. Its half-angle is asin(3 m/s ÷ speed), 19.5° at pirates' full sail. A foam channel is laid under the aft hull and where the water moves faster than 0.35 m/s; it spreads a little and fades over 1.3 s. Each frame the field is packed (height, ∂h/∂x, ∂h/∂z, foam) into a 256 × 256 float texture. The shader reads it bilinearly, fades it out over the field's outer tenth, raises the vertex by the height, steepens the slope 1.6× for the camera, and breaks the foam with noise.

**Shader** (`render/water/wakeShader.ts`, KSL: one source for WGSL, GLSL and the JavaScript the tests run). `mycoWakeAt(p)` returns (∂h/∂x, ∂h/∂z, foam, height) for either mode. The water plugin bends the normal by the slope after its ripples, takes the larger of its crest foam and the wake's, and lightens the water toward its shallow colour by the height (×2.5), as its own crests do. In field mode the vertex shader adds `mycoWakeHeight`. The plugin binds both textures as samplers (`mycoWakeTrail`, `mycoWakeField`), with a 1 × 1 stand-in for the mode not in use, and two vec4 uniforms (`mycoWake`, `mycoWakeArea`).

**CPU sampling is unchanged.** `Water.sample` and buoyancy see the Gerstner waves only; servers have no wakes.

**Pirates.** Ships (and the menu backdrop's) get a `WaterWake` in `seaMarks.ts`, which sets `strength` 0 while the ship is hidden in someone else's fog or sunk. **V** switches the sea between trail and field (kept across scenes). The ribbons, `seaMarkShapes.ts`, `textures/wake.png` and its generator are removed.

**After the comparison** the owner picks one; the other's code and `wakeMode` value go, and this record is amended to the chosen design before it is accepted.

## Alternatives considered

- **Keep ribbons, give them a water-like material.** Still a decal above the surface: it can't bend the sea's own reflections and still clips into crests.
- **The height field on the GPU** (a ping-pong render-target simulation). It's faster for big grids, but it needs float render targets and compute or render passes on both backends, and it's harder to test. The CPU field costs about 1.2 ms a frame (0.76 ms step + 0.47 ms pack, measured in the container) and runs the same everywhere. It can move to the GPU if field mode stays.
- **An analytic wedge from the boat's position only** (the usual shader tip: one uniform per boat). Cheapest, but the wake swings with the boat when it turns instead of staying where the boat was. Both versions keep the real path.
- **Vertex displacement alone.** Pirates grids have about 1.8 m between vertices; the ripples would alias or vanish.

## Consequences

**Positive**
- The wake is the water: lit, reflective, coloured and foamed by the same `WaterSurface`.
- Any game puts a `WaterWake` on a moving node and gets a wake; no per-frame script.
- Trail: no simulation and a small texture (20 × 16 texels). Field: wakes that cross, curve and spread on their own and raise the surface, from any number of hulls in view.

**Negative / costs**
- Trail: up to 16 wakes × 15 segments per water fragment in the worst case (bounds skip the far ones). Its ripples are a stylised Kelvin pattern, not a simulation.
- Field: about 1.2 ms of CPU and a 1 MB texture upload a frame. It only covers 96 m around the focus; wakes outside it fade out. Its waves don't disperse like real water (pulsed ripples stand in for that). A ship hidden in fog stops pressing, but the waves it already made fade over a second or two.
- Two more samplers on the water material.
- Wakes don't raise `sample()`'s surface, so a floating object doesn't bob on one; in field mode a hull's own trough is drawn but not felt.
- A bigger public API (`WaterWake`, `wakeMode`).

## Deprecates

- `seaMarks.ts`' ribbon wakes and bow waves, `samples/pirates/scripts/seaMarkShapes.ts` (`WakePath` and `wakeStrength` moved to `render/water/wakeTrail.ts`; `bowWave` removed) and its test, `samples/pirates/textures/wake.png` and its generator.
- After the comparison: the losing mode's code.

## Open questions

- Which mode stays (the owner's comparison).
- If the field stays: move it to the GPU, and let `sample()` include its height so floating objects bob in wakes.
- Wakes over more than one water surface with different modes (the first surface decides today).

## References

- `src/engine/render/water/{WaterWake,wakes,wakeTrail,wakeField,wakeShader}.ts`, `src/engine/render/babylon/water.ts`, `samples/pirates/scripts/seaMarks.ts`
- Tests: `src/engine/tests/waterWakes.test.ts`, `babylonWater.test.ts`, `piratesSample.test.ts`
- Kelvin wake pattern (half-angle arcsin(1/3) ≈ 19.47°); GPU Gems ch. 1, "Effective Water Simulation from Physical Models"
