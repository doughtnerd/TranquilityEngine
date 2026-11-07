# 0094. Particle systems compile to per-particle kernels that run on WebGPU compute, WebGL2 textures or JavaScript

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0057, 0060, 0075, 0081, 0095, 0096; resolves open question O16

## Context

ADR 0060's particle graph already holds what a VFX-Graph-style backend needs: operators, several outputs per system and events. The only runtime is the CPU simulation in `render/particles/simulation.ts` (ADR 0081 removed three.quarks), driven by `particleCompile.ts`, which lowers each system to 0057's emitter settings. That model has no place for per-particle maths: an operator chain over per-particle values is reported "needs the GPU backend" and replaced by the input's inline value, extra outputs are dropped, and every particle is a JavaScript object stepped on the main thread (around 10 000 particles before a frame costs several milliseconds).

The Babylon renderer (`BabylonRenderer.create`) makes a `WebGPUEngine` when `WebGPUEngine.IsSupportedAsync` says so and falls back to a WebGL2 `Engine`; previews do the same. So WebGPU is the main path today, and WebGL2 (no compute shaders) the fallback. Babylon 9.32 ships `ComputeShader` and `StorageBuffer` for WebGPU, `EffectRenderer`/`EffectWrapper` and multiple render targets for full-screen passes, and `Mesh.forcedInstanceCount` for drawing N instances of one quad without per-instance buffers. Headless Chromium runs both WebGL2 and WebGPU (SwiftShader, with `--enable-unsafe-webgpu --enable-features=Vulkan`), so both paths can be tested in a browser.

The owner chose (2026-11-07) to build both GPU backends now, as backends of 0060's compiled programs.

## Decision

We will compile each particle system into a small renderer-neutral **kernel program** and run it on one of three executors, chosen per system with fixed fallback rules. The legacy CPU simulation stays for what the kernel doesn't cover.

**Kernel program (`scene/particleKernel.ts`).** `compileParticleKernels(graph, program)` turns each system into:
- an **init** stage (the Initialize context, plus the spawn shape) and an **update** stage (the Update context), lists of statements over an expression IR: constants, uniform slots, particle attributes, stable per-particle randoms (`hash(seed, salt)`), baked curve/gradient look-ups, and the operator nodes (maths, trigonometry, vectors, colour, noise);
- one **output** stage per Output context (0060's first output plus `extraOutputs`), run when drawing: colour, size and flipbook tile are computed from the simulated attributes there, so several outputs share one simulation and each has its own appearance blocks;
- **uniform bindings**: every wired sub-expression that doesn't read a particle is evaluated once per frame on the CPU with 0060's `compileUniform` and written to a uniform slot (so everything a script or property drives is live, with no rebuilds);
- a **look-up table**: every curve and gradient (inline values, Curve/Gradient nodes, curve and gradient properties) baked to 128 samples, one row each.

**Particle state** is 16 floats per particle in four vec4 slots, the same on every executor:
`A0` position.xyz, age · `A1` velocity.xyz, lifetime · `A2` start colour (linear RGBA) · `A3` start size, rotation (radians), start tile, seed. A slot is alive while `lifetime > 0` and `age < lifetime`; a particle that dies writes `lifetime = -lifetime` for one frame ("died this frame", read by death events), then 0. Birth is `age == 0`.

**Spawning stays on the CPU** (`render/particles/gpu/spawner.ts`): rate, rate over distance, bursts, periodic bursts, start delay, duration, looping and prewarm give a count per frame; new particles take the next slots of a ring over the capacity (a full system replaces its oldest slots). The executors only initialise the slots in `[spawnStart, spawnStart + spawnCount)`. The alive count is estimated on the CPU from the spawn history and the largest possible lifetime (no read-back), so `ParticleSystem.particleCount` is approximate for kernel systems.

**GPU events** (Trigger Event wired to another kernel system's start) use a fixed slot mapping instead of atomics, so they work on WebGL2 too: a child with capacity `C` and a parent with capacity `P` gives each parent slot `k = max(1, floor(C / P))` child slots; child slot `i` belongs to parent `floor(i / k)`. Each frame the child's kernel reads its parent's state: when the parent particle was born (birth), died (death) or is alive (frame) and passes the probability test, the first `n` dead slots of its group initialise from the parent's position (and velocity, with Inherit velocity), where `n` is the child's constant burst count (birth, death) or `rate × dt` rounded stochastically (frame). Events that find no free slot are dropped.

**Executors:**
- **WebGPU compute** (`render/babylon/gpuParticles.ts`): the kernel compiles to WGSL; state lives in two storage buffers (read, write; swapped each frame) and the look-up table in a third; one `ComputeShader` dispatch per system per frame, workgroup size 64.
- **WebGL2 textures**: the kernel compiles to GLSL ES 3.0; state lives in two sets of four `RGBA32F` textures (ping-pong), written by one full-screen pass with four render targets; needs `EXT_color_buffer_float` (the WebGL2 engine checks it; without it the system uses the JavaScript executor).
- **JavaScript** (`render/particles/gpu/kernelJs.ts`): the same IR run by closures over `Float32Array`s (no `eval`, so it works under a strict CSP). It's the reference the GPU executors are tested against and the fallback when neither GPU path is available (headless Worlds, NullEngine, missing float render targets); its state is uploaded each frame to the draw's texture or storage buffer.

All three draw the same way: one mesh per output (a quad, or the model mesh for mesh outputs) with `forcedInstanceCount = capacity` and a shader material whose vertex stage reads instance `gl_InstanceID` / `instance_index` from the state, runs the output stage, and collapses dead particles to nothing. WGSL on the WebGPU engine, GLSL on WebGL2.

**Choosing a backend per system.** `SystemSettings.simulation` is `"auto"` (default), `"cpu"` or `"gpu"`:
- `"cpu"` uses the legacy simulation, reporting kernel-only features as today;
- `"gpu"` uses a kernel executor: WebGPU compute when the engine is WebGPU, else WebGL2 textures, else JavaScript;
- `"auto"` uses a kernel executor when the system needs one (a per-particle operator chain, a Set Attribute block, several outputs, a GPU event, depth collision) or its capacity is 4096 or more, and every block it has is one the kernel supports; otherwise the CPU.
A kernel system with a block the kernel doesn't support (below) skips the block and reports it.

**What each backend supports:**

| Feature | CPU (legacy) | Kernel (WebGPU, WebGL2, JavaScript) |
| --- | --- | --- |
| Spawn: rate, distance, bursts | yes | yes (counted on the CPU) |
| Initialize blocks, eight shapes | yes | yes (Grid's loop/ping-pong modes use the slot index) |
| Update: gravity, forces, point gravity, noise, turbulence, orbit, limit speed, speed/colour/size/rotation/frame over life and by speed, plane collision | yes | yes |
| Per-particle operators, Particle attribute nodes, Set Attribute (0095) | reported | yes |
| Several outputs per system | first only | yes |
| Events: sub-emitters / GPU events | yes (to CPU systems) | yes (kernel to kernel); to a CPU system: reported |
| Trail outputs, material-asset outputs | yes | no (reported; mesh and quad outputs only, drawn with the texture) |
| Collision with colliders (0096) | yes | no |
| Depth-buffer collision (0096) | no | WebGPU, WebGL2 (needs a scene depth texture) |
| Soft particles (0096) | yes | yes |
| Very large counts | ~10⁴ | 10⁶ on GPU executors |

**Deterministic runs.** Kernel randoms are hashes of the particle's seed, which is a hash of its slot, the spawn frame number and the system's seed (0096's `seed`), so the same seed on the same executor gives the same particles. The three executors agree to float precision, not bit for bit (GPU `sin` and `pow` differ slightly).

## Alternatives considered

- **Babylon's `GPUParticleSystem`.** Transform feedback on WebGL2, compute on WebGPU, but a fixed feature set (no operators, no events between systems, one output) and Babylon's own emission model: it would cap the graph at what Babylon ships, the problem 0058 had with quarks.
- **WebGPU only, CPU elsewhere.** Half the work, but WebGL2 machines (and WebKit's partial WebGPU) would lose every per-particle feature. The texture backend costs one more code generator; the IR is shared.
- **Atomics and dead lists for spawning and events (VFX Graph's way).** Exact counts and no lost events, but WebGL2 has no atomics, so the two GPU paths would behave differently. The ring and slot mapping behave the same everywhere; WebGPU could add a dead list later behind the same IR.
- **Read back alive counts.** Exact `particleCount`, but a GPU→CPU read stalls or lags a frame; the estimate is enough for the editor overlay and `isAlive`.
- **Generate JavaScript source with `new Function` for the JS executor.** Faster, but blocked by a strict content security policy in Tauri builds; closures are fast enough for a fallback.

## Consequences

**Positive**
- Per-particle operators, several outputs and GPU events work, on every machine (slowly in JavaScript, fast on a GPU).
- Up to millions of particles on WebGPU and WebGL2; uniform bindings make every property and script-driven value live.
- One IR, three executors: the JavaScript one tests the semantics in Vitest; a browser test compares the GPU ones against it.

**Negative / costs**
- Two simulations to maintain (legacy CPU and kernel) and three code generators (WGSL, GLSL, JavaScript closures) to keep in step.
- Ring spawning can replace live particles when a system is full; GPU events can be dropped when a parent's group is full; particle counts are estimates.
- The kernel doesn't draw trails or material assets yet, and can't collide with physics colliders.
- WebGL2 needs float render targets; without them kernel systems run in JavaScript.

## Deprecates

0060's "per-particle operator chains are reported as needing the GPU backend" for systems that run on a kernel executor; the CPU still reports it for `"cpu"` systems. Nothing is removed.

## Open questions

- A dead list with atomics on WebGPU for exact counts and lossless events.
- Trails and shader-graph materials on kernel outputs.
- Sorting transparent kernel particles back to front (today they draw unsorted, as additive or alpha-tested looks need).

## References

- `src/engine/scene/particleKernel.ts`, `src/engine/render/particles/gpu/`, `src/engine/render/babylon/gpuParticles.ts`
- ADR 0060 (the graph format), 0057 (effects and ParticleSystem), 0075 (Babylon backend)
- Unity VFX Graph (GPU events, output contexts); Babylon.js `ComputeShader`, `EffectRenderer`, `Mesh.forcedInstanceCount`
- Benchmarks: `bench/particles/` (frame time against particle count per backend)
