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
- **Every system runs on a kernel executor**: `"cpu"` means the JavaScript executor, `"auto"` picks it
  unless the system wants a GPU (`KernelSystem.needs`: per-particle chains, Set Attribute, several
  outputs, GPU events, depth collision, 4096 particles or more; collider collision keeps it on
  JavaScript), and `"gpu"` the best executor. Each system runs on its own executor (`KernelEffect`'s
  `executor`), an event child on its parent's. `render/particles/simulation.ts`, the emitter-settings
  lowering of behaviours and outputs in `particleCompile.ts` and the CPU branch of the one draw factory
  (0185: `SystemDraw`, `InstanceDraw`, `QuadDraw`) are deleted, and the CPU-only warnings with them.
- **Trails draw material assets** (the owner's decision, 2026-11-20, as Unity's Trails module draws with
  the Renderer's Trail Material): a trail output with a PBR material asset (built-in assets and shader
  graphs) draws the strip `KernelDraw` draws, instanced, with an unshared copy of the material whose
  `MycoKernelParticlePlugin` places each vertex on the ribbon through the particle's history
  (`k_trail`, read from a history texture every executor provides in the state layout), facing the
  camera, with the soft fade on the copy and the sort the other outputs have.
- **The program is the kernels plus the spawn settings.** `ParticleProgram` carries each system's kernel
  (`kernels`, compiled once with it, its problems in `problems`) and its `SpawnSettings` (rate, rate over
  distance, bursts, duration, looping, delay, prewarm, and the lifetime for the alive estimate), which
  `KernelSpawner` reads; bindings exist only for spawn inputs (the kernels evaluate their own).
- **`"cpu"` stays a choice**: a project that says `"cpu"` loads and runs as before, on the JavaScript
  executor, and the editor's Simulation setting keeps its three values.

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
- One draw pipeline, about 2,500 fewer lines (the simulation, the CPU draws and mesh draws, the lowering),
  and every block, output type and material runs on every system: no warnings either way.
- The JavaScript executor steps the samples' effects faster than the CPU simulation did (measured below).

**Negative / costs**
- The JavaScript executor's state is uploaded to the GPU each frame, where Babylon's particle system drew the
  CPU simulation's list directly.
- Systems moving from the CPU simulation to a kernel change behaviour at the edges: a full kernel system stops
  spawning instead of replacing its oldest particle (0126's dead list), sub-emitters become 0094's GPU events
  (fixed slots per parent particle), and seeded runs draw different random numbers (the same look, not the
  same particles). A system's capacity no longer grows when `emissionScale` × the tier's scale goes over 1
  (the CPU draws grew to the particle limit × the scale); emission still scales. The thumbnails frame only
  particles the executor keeps on the CPU (a GPU-run system's aren't read back). Babylon's own particle
  system is no longer used, so flipbooks read their cells from the quad's UVs and every particle texture
  loads flipped like other textures (the `sheet` texture use is gone).

## Deprecates

`render/particles/simulation.ts` (`EffectSimulation`), the CPU emitter draws in `render/babylon/particleDraw.ts`
and `particleMeshes.ts`, the behaviour and renderer lowering in `scene/particleCompile.ts`
(`ParticleProgram.effect`), the CPU-only problem reports (`GraphProblem.cpuOnly`, `KernelSystem.unsupported`),
the warm-up's Babylon particle systems (`WarmParts.systems`) and the `sheet` texture use. All removed
(2026-11-20).

## Building it (2026-11-20)

- **The samples compared on numbers before the switch.** A scratch Vitest script (not committed) played
  the three sample effects (the pirates' fog cloud: Body, Rim; rain; the Playground's campfire: Flames,
  Smoke, Sparks) on the old `EffectSimulation` and on `KernelEffect` with the JavaScript executor, 20 seeds
  each, 1/60 s steps, sampled at 0.5, 1, 2, 4 and 8 s: per system the particles alive and their mean
  position, spread (standard deviation), speed, drawn size, alpha and age, averaged over the seeds. They
  agree within the seeds' noise: alive counts within 2% (Rain 1,680 against 1,690; Body 141 against 141;
  Flames 51.4 against 51.9), mean heights within 0.02 m (Sparks, 14 particles a run, within 0.1 m), speed,
  size, alpha and age within 3%. The one difference past the noise is the Rim's vertical spread, 0.069 m
  against 0.061 m (its value noise). After the switch the same script through `EffectPlayer` gave the
  whole effects 199 (fog cloud), 1,694 (rain) and 93 (campfire) particles, the kernel numbers.
- **Performance** (the same script, Node, 600 steps after 240 to fill): the CPU simulation against the
  JavaScript executor, per frame of stepping: fog cloud 0.25 against 0.19 ms, rain (1,690 alive of 3,000)
  0.25 against 0.14 ms, campfire 0.12 against 0.09 ms. The executor's state upload each frame (the
  capacity × 64 bytes, repacked into four textures on WebGL2) replaces the CPU draws' copy into Babylon's
  particle list; it wasn't measured in a browser (`npm run bench:particles`' page reads a player member
  that no longer exists, before this change too).
- **A seeded restart repeats exactly** on kernels: `KernelEffect.restart` counts spawns from 0 again (the
  seeds hash the spawn number) and resets its clock and frame.

## Open questions

- The Particle Graph's dashed "needs the GPU backend" wires (`problems.ts`' `gpuWires`, `Wires.tsx`,
  `BlockView.tsx`) no longer show: the compiler reports a per-particle chain only on a Spawn input, where no
  executor can run one, with other words. Removing that UI touches `GraphEditor.tsx`, left for after the
  Particle Graph's editor work in flight.
- Trails, material or not, still take one colour and size per particle (0126).

## References

- `src/engine/render/particles/gpu/kernelSteps.ts`, `kernelJs.ts`, `kernelShader.ts` (`materialVertexCode`'s
  trails), `kernelEffect.ts`, `spawner.ts`; `src/engine/scene/particleKernel.ts` (`jsOnly`, `chooseBackend`),
  `particleCompile.ts` (`SpawnSettings`); `render/babylon/gpuParticles.ts` (`BabylonKernelHost`'s ray cast,
  each run's history texture), `kernelMaterial.ts`, `particleDraw.ts`, `effectPlayer.ts`
- Tests: `kernelSteps.test.ts`, `particleColliders.test.ts` (the JavaScript executor's block), `particleKernel.test.ts`,
  `particleCompile.test.ts`, `particleKernelMaterials.test.ts` (material trails), `babylonParticles.test.ts`,
  `babylonKernelParticles.test.ts`, `effectPlayer.test.ts`, `particleSoft.test.ts`, `warmUpVariants.test.ts`,
  `babylonPreviews.test.ts`, `particleSeed.test.ts`
- Bench: `npm run bench:particles`
