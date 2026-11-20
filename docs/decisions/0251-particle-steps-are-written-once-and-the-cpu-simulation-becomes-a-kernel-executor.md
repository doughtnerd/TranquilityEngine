# 0251. Particle steps are written once, and the CPU simulation becomes a kernel executor

- **Status:** Accepted
- **Date:** 2026-11-20
- **Deciders:** Chris Carlson
- **Supersedes:** 0094 in part (its clause "the legacy CPU simulation stays for what the kernel doesn't cover")
- **Related:** 0057, 0094, 0096, 0126, 0185, 0250

## Context

Each particle behaviour existed three times: in the legacy CPU simulation (`render/particles/simulation.ts`,
1,515 lines: shapes, behaviours, trails, sub-emitters), in the JavaScript kernel executor
(`render/particles/gpu/kernelJs.ts`: shapes and steps as closures) and in KSL (`kernelShader.ts`: the same
steps for WGSL and GLSL). The simulation also copied `kernelMath.ts`'s hashes and noise line for line. Neither
side could do everything, so users got warnings both ways: the CPU skipped per-particle operators, Set
Attribute, extra outputs and depth collision (`particleCompile.ts`), and the kernel skipped collision with the
World's colliders (`particleKernel.ts`). Trails, soft fade and sorting were built for both draw pipelines
(`particleMeshes.ts` and the kernel draws). The JavaScript and KSL steps were compared only in a browser
bench (`npm run bench:particles`).

## Decision

We will write each particle step once per language in one catalogue, run every system on a kernel executor,
and retire the CPU simulation.

- **One steps catalogue.** `render/particles/gpu/kernelSteps.ts` holds every built-in step (`KBuiltin`: age,
  gravity, force, point gravity, turbulence, limit speed, integrate, noise, orbit, plane, spin, place, the
  spawn shapes) as a `KernelStep { ksl, js }`, side by side, plus the step globals, helpers, shape samplers and
  depth collision in KSL. `kernelShader.ts` takes the KSL (its generated WGSL and GLSL are byte-identical to
  before) and `kernelJs.ts` dispatches to the JavaScript; neither keeps a copy. A unit test
  (`kernelSteps.test.ts`) runs each step's KSL as JavaScript (0250's third output) against its JavaScript on
  random particles and uniforms, so a step can't change in one language only.
- **Why not generate the JavaScript from KSL.** 0250's JavaScript output is a closure interpreter that
  allocates a vector per operation: measured, `k_noise3` runs about 25× slower than `kernelMath.noise3`
  (200,000 calls: 824 ms against 33 ms) and a vector orbit about 1.9 µs a call. The executor runs every step
  per particle per frame, so it keeps hand-written JavaScript and the test holds it to the KSL.
- **The JavaScript executor ray casts.** Collision with colliders compiles to two JavaScript-only steps
  (`collidersStart` keeps the world position before the particle moves, `colliders` casts to the new one and
  bounces, with friction and radius, or kills), using the World's ray cast through `EffectHost.raycast` and the
  kernel host. `KernelSystem.jsOnly` lists such blocks: `"auto"` runs those systems on the JavaScript executor,
  and a system run on the GPU warns that it skips them (use Collide with depth buffer there).
- **Every system runs on a kernel executor** (the target): `"cpu"` means the JavaScript executor, `"auto"`
  picks it unless the system needs a GPU kernel, and `"gpu"` the best GPU executor. Then
  `render/particles/simulation.ts`, the emitter-settings lowering of behaviours and outputs in
  `particleCompile.ts` (only spawn and timing settings stay, for the spawner) and the CPU branch of the one
  draw factory (0185: `SystemDraw`, `InstanceDraw`, `QuadDraw` trails) are deleted, and the CPU-only warnings
  with them.

## Alternatives considered

- **Generate the JavaScript steps from KSL at runtime** — one text instead of two, but 25× slower per step
  (measured above); worth revisiting with a code-generating output, which the player's strict CSP rules out.
- **Keep the CPU simulation as a peer backend** — keeps two sets of draws and three copies of every
  behaviour, and warnings in both directions.
- **Retire the JavaScript executor instead** — the CPU simulation can't run per-particle operators or several
  outputs, which the kernel IR already does on all three executors.

## Consequences

**Positive**
- A new block is one step in one module, in two languages that a unit test keeps in agreement.
- Collider collision no longer forces a system off the kernel.
- Once the CPU simulation is gone: one draw pipeline, about 1,500 fewer lines, and CPU/GPU parity as unit tests.

**Negative / costs**
- The JavaScript executor's state is uploaded to the GPU each frame, where Babylon's particle system drew the
  CPU simulation's list directly.
- Systems moving from the CPU simulation to a kernel change behaviour at the edges: a full kernel system stops
  spawning instead of replacing its oldest particle (0126's dead list), sub-emitters become 0094's GPU events
  (fixed slots per parent particle), and seeded runs draw different random numbers (the same look, not the
  same particles).

## Deprecates

`render/particles/simulation.ts` (`EffectSimulation`), the CPU emitter draws in `render/babylon/particleDraw.ts`
and `particleMeshes.ts`, the behaviour and renderer lowering in `scene/particleCompile.ts`, and the CPU-only
problem reports. Built so far (2026-11-20): the steps catalogue and the JavaScript executor's collider
collision; `simulation.ts` imports the kernel's hashes and noise instead of copying them. The rest is open below.

## Open questions

- **Not built yet: routing every system to a kernel and deleting the CPU simulation.** Found while building:
  - **Material assets on trail outputs (the blocker).** The CPU draws a trail with a material asset
    (`QuadDraw`); kernel trails draw with the texture and warn (0126's open question). Retiring the CPU path
    first needs `MycoKernelParticlePlugin` to place trail strips (the history in a texture on every executor,
    `k_trail` in the material's vertex code), or the owner's agreement to drop the combination (no sample uses
    it).
  - **The spawner reads lowered emitter settings.** `KernelEffect` and `KernelSpawner` take `ParticleProgram.effect`
    (emission, bursts, duration, looping, prewarm, capacity and their live bindings), so the lowering can shrink to
    those fields but not go.
  - **Tests to move.** Switching `"cpu"` and plain `"auto"` systems to the JavaScript executor fails 32 tests
    that assert the CPU draws (Babylon particle systems, thin instances, mesh quads and trails, the warm-up's
    one-particle state, seeded repeats of the CPU's random sequence): `babylonParticles`, `effectPlayer`,
    `particleSoftCpu`, `warmUpVariants`, `babylonPreviews` and `babylonKernelParticles`. They need rewriting
    against the kernel draws, with the samples' effects (campfire, rain, fog cloud) compared on numbers
    (spawn counts, lifetimes, positions over time) between the two paths before the switch.
- Whether `"cpu"` should stay a choice at all once it means "the JavaScript executor".

## References

- `src/engine/render/particles/gpu/kernelSteps.ts`, `kernelJs.ts`, `kernelShader.ts`, `kernelEffect.ts`;
  `src/engine/scene/particleKernel.ts` (`jsOnly`, `chooseBackend`); `render/babylon/gpuParticles.ts`
  (`BabylonKernelHost`'s ray cast); `render/babylon/effectPlayer.ts`
- Tests: `kernelSteps.test.ts`, `particleColliders.test.ts` (the JavaScript executor's block), `particleKernel.test.ts`
- Bench: `npm run bench:particles`
