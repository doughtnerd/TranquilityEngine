# 0057. Particle effects are assets in our own format, played by a ParticleSystem component on three.quarks

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0021 (where particle definitions are stored)
- **Related:** 0004, 0010, 0013, 0021, 0043, 0047, 0050, 0058

## Context

0021 chose three.quarks for particles, wrapped as a `ParticleSystem` component with Unity-like modules, with definitions stored as component data in scenes. Nothing is built yet. Since then the engine has gained material assets (0043), shader graphs (0047), quality tiers (0050) and post-processing with bloom (0051). We now want a particle graph editor (0058). Each of these raises a question 0021 left open: where an effect lives, how it is described, what it draws with, and how tiers scale it.

three.quarks 0.17 (MIT, `three` ≥ 0.182 as a peer, `quarks.core` as its one dependency) offers:
- a `BatchedRenderer` that batches every system sharing a material and render mode;
- `ParticleSystem` objects with emitter shapes (point, sphere, hemisphere, cone, circle, grid, mesh surface);
- behaviours: colour, size, rotation and speed over lifetime, forces, noise and turbulence, orbit, flipbook frames, sub-emitters, and others;
- value generators: constants, random ranges, piecewise Bézier curves, colour ranges and gradients;
- render modes: billboard, stretched billboard, mesh and trail;
- a JSON format of its own, written by its web editor (quarks.art) and read by `QuarksLoader`.

The renderer stays `WebGLRenderer` on WebGL2 (0004). A GPU-simulated, Unity-VFX-Graph-style system is out of scope here (see Open questions).

## Decision

**Effects are assets, in our format.**
- A particle effect is a project asset `*.particles.json` with the format tag `myco.particles@1`, parsed and formatted like other engine formats and versioned with migrations (0013).
- An effect holds one or more **emitters**, each a system in quarks' terms: a firework is a rocket emitter with a burst emitter as its sub-emitter.
- The format describes emitters with Unity-like modules, in our own words and types. It is not quarks' JSON. Saved effects don't depend on quarks' schema, and quarks stays out of the public API and file formats (0010).
- The backend translates an effect into quarks objects when it loads it.

**Modules per emitter**
- **Main:** duration, looping, prewarm, start delay, start lifetime, speed, size, rotation and colour, gravity modifier, simulation space (`local` / `world`), max particles.
- **Emission:** rate over time, rate over distance, bursts (time, count, cycles, interval, probability).
- **Shape:** point, sphere, hemisphere, cone, circle, box or grid, mesh surface (a model asset), each with its own transform.
- **Over lifetime:** an ordered list of behaviours mapped onto quarks' (colour, size, rotation, speed, force, gravity, noise or turbulence, orbit, flipbook frame, limit speed, and the by-speed variants).
- **Sub-emitters:** another emitter of the same effect, triggered on birth or death.
- **Renderer:** billboard, stretched billboard, horizontal or vertical billboard, mesh (a model asset), or trail; a material; blending (alpha, additive, premultiplied); flipbook tiles; sorting order; soft particles.

**Values**
- Any numeric module field takes one of four values: a constant, a random range, a curve (piecewise Bézier over normalized lifetime), or a random range between two curves.
- Colours take a constant, a random range, or a gradient.
- The format stores these as tagged objects (`{ "curve": [...] }`), so the inspector and the graph (0058) edit the same data.

**ParticleSystem component**
- `engine.ParticleSystem` references an effect asset (`effect`), or embeds one in the same schema for quick one-offs. The editor can turn an embedded effect into an asset.
- Per-instance fields: `playOnAwake` (default true), `seed`, `timeScale`, `tint`, `emissionScale`, and values for the effect's exposed properties (0058).
- It follows its node's world transform through render sync (0010), as 0021 says.
- Scripts call `play()`, `pause()`, `stop({ clear })`, `clear()`, `emit(count)`, `restart()`, and read `isPlaying`, `isAlive`, `time` and `particleCount`.
- A non-looping effect can destroy its node when it finishes (`destroyOnFinish`), the usual one-shot pattern.

**Rendering**
- The render backend owns one quarks `BatchedRenderer` per World. It is created on demand by a dynamic import the first time a World has a ParticleSystem, as post-processing is (0051), so games without particles don't download quarks.
- Simulation runs in the render step with the World's scaled delta time, so pausing time pauses particles.
- Particles are transparent and are drawn after opaque meshes. Bloom (0051) makes additive particles glow with no extra work.

**Materials**
- v1 particle materials are ordinary material assets (0043) with `unlit` or `lit` shaders (texture, colour, blending), handed to quarks, which builds its batched shaders from them.
- A shader graph target for particles waits for a spike (see Open questions).

**Quality tiers (0050)** gain:
- `particles`: `low`, `medium` or `high`, scaling every emitter's emission and max particles by 0.25, 0.5 or 1. Defaults: Low low, Medium medium, High and Ultra high.
- `softParticles`: on or off. Defaults: off on Low, on above.
- Changing the tier applies at once, without a reload.

**Editor**
- An effect asset opens in the particle graph (0058).
- A ParticleSystem's inspector shows the referenced effect's modules for quick edits: the same data, written back to the asset.
- In the scene view, a selected ParticleSystem simulates with a small overlay: Play, Pause, Restart, speed, elapsed time and particle count. A "Simulate all" toggle runs every system, as Unity's does. Nothing simulates unselected by default.
- The Hierarchy's Create menu adds a Particle System node with a new embedded effect.

**Not in v1**
- Collision with physics: quarks doesn't know about Rapier, so this is engine work. A plane-collision behaviour (bounce or kill against a world plane) is enough for v1.
- Particles are cosmetic: never replicated, simulated on each client (multiplayer, 0034).

**Dependencies:** `three.quarks` (MIT), pinned to an exact 0.17.x after a compatibility check against three 0.187, and imported only in `src/engine/render/particles/`.

## Alternatives considered

- **Store quarks' own JSON** (and author in quarks.art). Zero translation, but the saved format would follow quarks' schema changes and leak a library type into project files (0010). An importer for quarks.art files can come later.
- **Effects as component data in scenes only** (0021 as written). Simple, but one effect can't be reused across prefabs and scenes without copying. A graph editor also edits files, as the shader graph does. Embedded effects keep the convenience.
- **Our own CPU simulator.** Full control, no version coupling with three, but weeks of work quarks has already done, including batching.
- **GPU simulation (VFX-Graph-style) now.** Deferred by the owner. WebGL2 has no compute shaders, so it means a texture-based simulator or a move to WebGPU (see Open questions).

## Consequences

**Positive**
- Reusable effects, scripted like Unity's, scaled by quality tiers, glowing through bloom, with no cost to games that don't use them.
- The format is ours: quarks can be upgraded or replaced behind the translator.

**Negative / costs**
- A translator between our modules and quarks' classes to maintain. Every module we add needs a quarks mapping or a custom quarks behaviour.
- quarks is sensitive to three.js versions, so each three upgrade needs a particle check.
- The inspector needs curve and gradient editors, which the editor doesn't have yet. The particle graph (0058) needs them too.

## Deprecates

0021's "definitions serialize as component data in scene files" becomes "effects are assets, optionally embedded in a component". The rest of 0021 stands.

## Open questions

- **Shader graph particle target.** quarks builds its own batched shaders from a material's properties. A graph material would need quarks' billboard vertex code combined with our compiler's output, plus particle nodes (particle colour, normalized age, lifetime, velocity, flipbook UV). It needs a spike before it gets a record.
- **Importing quarks.art JSON** into `myco.particles@1`.
- **Collision with Rapier colliders**, through scene queries or a depth-buffer approximation.
- **GPU particles / a VFX Graph** (millions of particles, GPU events) on WebGL2 texture simulation or WebGPU. Deferred; the particle graph's editor (0058) is meant to be reusable for it.

## References

- https://github.com/Alchemist0823/three.quarks
- 0021, 0051 (dynamic import pattern), 0047 (asset format pattern)
