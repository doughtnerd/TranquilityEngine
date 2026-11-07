# 0096. Soft particles, collisions, deterministic seeds and shader-graph particle colour

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0057, 0060, 0094, 0047, 0075, 0081

## Context

ADR 0057 and 0060 listed particle features still missing: soft particles (they need a scene depth texture), shader-graph particle materials, a deterministic `seed` (the CPU simulation used `Math.random`), physics collisions (only a horizontal plane), and importing quarks.art files. ADR 0094 adds kernel backends that can read a depth texture on the GPU but can't reach the physics world; the CPU simulation is the opposite. No render code had a scene depth texture; another work stream may add one later.

## Decision

**Soft particles.** Outputs gain `settings.softness` (metres; 0 or absent is off). A soft output fades a particle's alpha by `(sceneDepth − particleDepth) / softness`, clamped to 0–1, so quads don't cut hard lines into geometry. The depth is the engine's shared scene depth (ADR 0109: the frame graph's geometry pass writes linear view depth for every camera while something asks for it with `requestSceneDepth`): `SceneDepth` (`render/babylon/gpuParticles.ts`) asks for it on first use and binds each camera's own depth while that camera draws. Scenes no frame graph draws (the Particle Graph preview, the benchmark page) fall back to Babylon's depth renderer storing camera-space Z, the same quantity. Kernel outputs only for now; CPU systems draw through Babylon's particle system, which has no depth fade.

**Collisions.**
- `update.collisionDepth` (*Collide with depth buffer*, kernel backends): each frame a particle is projected into the camera; when it is behind the depth texture's surface by less than `thickness`, it steps back and its velocity reflects (scaled by `bounce`), or it dies (`kill`). Only what the camera sees collides.
- `update.collisionColliders` (*Collide with colliders*, CPU simulation): each particle casts a ray from its previous to its new position through `SimulationOptions.raycast`, which the renderer provides from the World's 3D physics (`physics3D.raycast`); a hit places it at the point (plus `radius` along the normal) and reflects its velocity (normal part × `bounce`, tangential × 1 − `friction`), or kills it. One ray per particle per frame, so meant for modest counts. Without 3D physics it does nothing.
The plane collision stays on both.

**Deterministic seed.** `ParticleSystem.seed` (number, default 0): 0 is a new random sequence each play; any other integer gives the same particles on every play and restart. The CPU simulation and the graph's random nodes draw from a seeded generator (`render/particles/random.ts`, mulberry32) recreated on restart. Systems may set their own `settings.seed` in the graph; kernel backends use it per system (mixed into each particle's seed, 0094), while the CPU simulation uses one generator for the effect and ignores per-system seeds. Runs repeat on the same backend, not across backends (0094).

**Shader-graph particle materials.** The shader graph gains a *Particle Color* node (`particleColor`: rgba, rgb, a) reading the mesh's vertex colour times its instance colour (white when it has neither). CPU particles drawn with a material asset already carry their colour per vertex (trails, quads) or per instance (mesh particles, material quads, which now also keep the instance alpha), so a graph material can tint and fade per particle. Kernel outputs don't draw material assets yet (0094).

**quarks.art import is dropped.** three.quarks is no longer a dependency (ADR 0081 removed it with the three.js backend), and its editor's files describe quarks systems, which nothing plays any more.

**Smaller items** from the same lists, no decision needed: the effect preview and thumbnails resolve material assets; Play Time is per system (each binding's own system duration); the Particle Graph saves collapsed systems in `graph.editor.collapsed`; particle nodes are picked in the scene view by an editor icon.

## Alternatives considered

- **Soft particles on CPU systems** by replacing Babylon's particle system draws with our own mesh draws. More draw code to keep for one feature; kernel outputs already draw themselves. Revisit if CPU soft particles are wanted.
- **Depth collision on the CPU** by reading the depth texture back. A GPU→CPU read stalls or lags a frame.
- **Colliders on the GPU** (uploading collider shapes to the kernel). Possible for spheres and boxes later; arbitrary meshes and heightfields aren't, so the depth buffer is the general GPU answer.
- **A seeded generator per emitter on the CPU.** Would make per-system seeds work there, but changes the sequence every existing seeded effect sees; not worth it before anyone needs it.

## Consequences

**Positive**
- Every particle item the 0057 and 0060 rows listed as missing is built or answered.
- Seeded effects repeat exactly, for replays, tests and lockstep play.

**Negative / costs**
- Soft particles and depth collision keep the frame graph's depth pass on every camera while they're in use (shared with AO and depth of field when those are on).
- Collider collisions cost a physics ray per particle per frame.
- Depth collisions only see what the camera sees.

## Deprecates

0057's planned quarks.art import (dropped). Nothing else.

## Open questions

- Height fog (ADR 0110) on kernel particles: `heightFog.ts` keeps its state private and offers no hook for custom shaders yet.
- Particle pipelines in the scene warm-up (ADR 0080): `warmUp.ts` has no hook for particle materials yet.
- Soft particles for CPU systems.

## References

- `src/engine/render/babylon/gpuParticles.ts` (`SceneDepth`, soft fragment code), `render/particles/gpu/kernelShader.ts` (`k_depthCollide`), `render/particles/simulation.ts` (`collisionColliders`), `render/particles/random.ts`, `render/shaderGraph/nodes.ts` (`particleColor`)
- Tests: `particleColliders.test.ts`, `particleSeed.test.ts`, `babylonKernelParticles.test.ts`, `babylonGraphMaterial.test.ts`, `babylonParticles.test.ts`, `shaderGraphWgsl.test.ts`
