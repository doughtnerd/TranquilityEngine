# 0021. Particles with three.quarks

- **Status:** Superseded by [0081](0081-remove-the-threejs-render-backend.md) (three.quarks was removed with the three.js backend; effects run on the engine's own simulation, drawn by Babylon.js, ADR 0075)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0010

## Context

0004 makes three.js the renderer and lists particles as a plugin to confirm. Options are three.quarks (a mature three.js particle library with Unity-like emitter settings and batched rendering) or a custom GPU particle system.

## Decision

- Particles use **three.quarks**, wrapped as an engine `ParticleSystem` component with Unity-like modules (emission, shape, lifetime, velocity/size/color over lifetime, renderer settings).
- The render backend owns one quarks batched renderer per World and registers emitters as `ParticleSystem` components are enabled.
- `ParticleSystem` follows the node's world transform through render sync (0010). Simulation space (`local` / `world`) is a component setting.
- Particle system definitions serialize as component data in scene files (0013).

## Alternatives considered

- **Custom GPU particles.** Full control and potentially faster for huge counts, but substantial work for v1.
- **Defer particles.** Particles are part of the intended render pipeline; a wrapper is cheap.

## Consequences

**Positive**
- Rich effects early, with batching.

**Negative / costs**
- Another three.js-version-sensitive dependency to keep compatible.
- Particle collisions with physics, if needed, are engine work (quarks doesn't know about Rapier).

## Deprecates

- Nothing.

## Open questions

- Whether the editor (0022) gets a dedicated particle editing view in v1.

## References

- https://github.com/Alchemist0823/three.quarks
