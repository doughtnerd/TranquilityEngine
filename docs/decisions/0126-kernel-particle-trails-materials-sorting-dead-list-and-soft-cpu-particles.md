# 0126. Kernel particles gain trails, material assets, sorting and a dead list; CPU particles go soft; custom shaders get a height-fog hook

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0057, 0060, 0080, 0094 (amends: spawning and counts on WebGPU and JavaScript), 0095, 0096 (amends: soft particles on CPU systems), 0109, 0110

## Context

The particle records left these gaps open (implementation status, 2026-11-07):

- **0094:** kernel outputs can't draw trails or material assets (they draw quads with the texture and report it), transparent kernel particles draw unsorted, and kernel spawning writes into a ring over the capacity, so a full system replaces its oldest particles and `particleCount` is estimated from the spawn history.
- **0096:** soft particles fade only on kernel outputs. CPU emitters drawn by Babylon's `ParticleSystem` can't read a depth texture; the record named "our own mesh draws" as the way to add it. Height fog (0110) lives in a PBR material plugin (`heightFog.ts`) whose state is private, so the kernel draws (`ShaderMaterial`s) and the CPU draws (Babylon particle systems and the unlit `StandardMaterial`) get no height fog.
- **0095:** the Particle Graph shows a Sub-graph node without ports, and the editor can't create sub-graph or custom block assets.
- **0080:** kernel systems are warmed only as their CPU draw; their compute pipelines, simulation programs and instanced draws compile on first play.

What exists: one simulation IR with three executors (WebGPU compute, WebGL2 textures, JavaScript closures) and one KSL source for the shaders (`kernelShader.ts`); every material asset is a Babylon `PBRMaterial` (built-in material assets and shader graphs, which are PBR plus a plugin, ADR 0047); Babylon material plugins can add uniforms, samplers and code but not storage buffers.

The owner chose (2026-11-07): sort automatically when an output is alpha-blended; a dead list on WebGPU and JavaScript, with WebGL2 keeping the ring.

## Decision

**Soft CPU particles (amends 0096).** A CPU emitter whose output has `softness > 0` draws with our own mesh draws (`QuadDraw` for billboard, stretched, horizontal and vertical; `InstanceDraw` and trails as today) instead of a Babylon particle system. A `MycoSoftParticlePlugin` (material plugin, `render/babylon/softParticles.ts`, WGSL and GLSL) fades the fragment's alpha by `(sceneDepth − fragmentDepth) / softness` with the shared scene depth (0109) through 0096's `SceneDepth`, bound per camera. It goes on the unlit particle material, and on a per-draw clone of a material asset (the asset itself is shared and stays untouched). `ParticleRenderer.softness` carries the setting from the graph to the CPU model. The same routing applies to CPU billboards while the scene has height fog, since Babylon's particle shader has no hook for it either.

**Height fog for custom shaders (`heightFog.ts`).** The module exports `heightFogOn(scene)`, the shader functions (`heightFogShader("wgsl" | "glsl")`: declarations and a `mycoApplyHeightFog(color, worldPos, eye)` function, under `MYCO_HEIGHT_FOG`), and `useHeightFog(material: ShaderMaterial, scene)`, which keeps the material's define in step with the scene (toggling it recompiles once, as the plugin does) and binds the two uniforms each draw. The PBR plugin registers for `StandardMaterial` too (the unlit particle material and other standard materials). Kernel draws call `useHeightFog`; shader assets and graphs already fog through the PBR plugin. Particles fog by their own alpha (fog mixes colour, not alpha), as lit materials do.

**Dead list (amends 0094), WebGPU and JavaScript.** A kernel system that isn't a GPU-event child keeps a free-slot stack (`kdead`, u32 × capacity) and counters (`kcount`: free count, alive count; i32 atomics on WebGPU). The update pass pushes a slot when its particle finishes (the frame after "died this frame"), and counts survivors; a separate spawn pass (dispatch of the CPU spawner's count) pops slots and initialises them. When the stack is empty the rest of that frame's spawns are dropped: **a full system stops spawning instead of replacing its oldest particles** (VFX Graph's behaviour). A new particle's seed hashes its spawn number (not its slot), so seeded runs still repeat. The alive count is exact: on JavaScript at once, on WebGPU through an asynchronous read-back of `kcount` (two staging buffers, never awaited by the frame), so `particleCount` is one or two frames late; until the first read it falls back to the estimate. WebGL2 has no atomics: it keeps 0094's ring and estimate, so a full system behaves differently there (documented). GPU-event children keep 0094's fixed slot mapping on every executor.

**Sorting.** Outputs gain `settings.sort`: `"auto"` (default, not written), `"on"`, `"off"`. Auto sorts outputs with alpha blending and leaves additive and premultiplied ones unsorted (their order doesn't change the result, or barely). A sorted output draws its instances through an index list sorted back to front by view depth for the active camera (split-screen views share the first camera's order):
- WebGPU: a key pass writes (depth, slot) pairs, then a bitonic sort over the next power of two in compute (one dispatch per stage, log₂n·(log₂n+1)/2 dispatches; 136 for 65 536 particles);
- WebGL2: the same network as full-screen passes over an RG32F texture pair;
- JavaScript: a typed-array sort of the keys.
Dead slots sort last and collapse as before. Several outputs of one system sort separately only when their order differs (in practice the one sort is shared).

**Trails on kernel outputs.** A system with a trail output keeps a position history: `trailLength` points per slot (at most 64; capacity × points at most 4 M, larger trails are capped and reported), a ring indexed by frame, each point `(position, tag)` where the tag is the particle's seed (`A3.w`). WebGPU and JavaScript write it in the update; WebGL2 in a second pass into this frame's block of a history texture. The trail draw is an instanced strip of `points` × 2 vertices per slot; its vertex shader finds how many points belong to the current particle with a binary search on the tag (points written before its birth carry another tag), clamps to that, and builds a camera-facing ribbon `size × widthOverLength(u)` wide (u 0 at the head), coloured by the output stage, U along the ribbon, V across the flipbook tile, as the CPU's `QuadDraw` trails. The Width over Length output block bakes to a look-up row (constant or curve; a wired graph value is reported and uses its inline value).

**Material assets on kernel outputs.** A kernel output with a material asset draws a clone of it (per output) carrying `MycoKernelParticlePlugin`, which in the material's own vertex shader reads the particle from textures (state ks0–ks3, uniforms, look-up table, and the sort index), runs the output stage and the orientation (0094's `k_orient`), and replaces the vertex position, normal (facing the camera; turned for mesh outputs) and vertex colour (so the shader graph's Particle Color node, 0096, sees the particle's colour). On WebGL2 and the JavaScript executor the state already lives in textures; on WebGPU the storage buffers are copied into RGBA32F textures each frame (`copyBufferToTexture`) for these draws only. Lights, shadows' receiving, fog and the frame graph's effects apply as for any PBR material. Trail outputs with a material asset draw with the texture and are reported (open question).

**Warm-up (0080) of kernel emitters.** `BabylonParticles.warmDraws` plans the effect as the World does; each kernel system gets a run stepped once with no spawn (compiling its compute pipeline or simulation program, and the sort and trail passes it uses) and its draws (instanced quads, trails, material clones), returned to the warmer as meshes like the CPU mesh draws. Disposing the warm draws disposes the runs.

**Editor (0095's open questions).** A Sub-graph node takes its ports from its asset (`inputs`, `outputs`, with types and rates, so wires validate as for any node) and shows "missing asset" when it can't; a Custom block shows its asset's inputs inline. The Assets menu gains **New Particle Sub-graph** and **New Particle Block** (templates with one input and one output, or one Set Attribute block), and both kinds open in the Particle Graph as documents of their own. "Save selection as sub-graph" moves selected operator nodes into a new asset and replaces them with a Sub-graph node wired as before.

**Found while building (2026-11-07).**
- Babylon draws a mesh with `forcedInstanceCount` as hardware instancing and multiplies by per-instance world matrices it has no buffer for, so the material plugin also sets the world position at `CUSTOM_VERTEX_UPDATE_WORLDPOS`.
- Babylon shares compiled effects between materials whose defines match, so the plugin's define carries a hash of its code (two kernel outputs would otherwise draw with one shader).
- Babylon asks a plugin for its injection points inside `MaterialPluginBase`'s constructor, before subclass fields exist: the height-fog plugin's standard-material code never reached the shader until it read the material type from the material itself.
- Babylon unregisters every registered material plugin when its last engine is disposed; height fog registers again then.
- Shader graph materials can't be cloned (Babylon can't recreate their plugin), so the renderer hands out copies (`BabylonParticleHost.materialCopy`: a new graph material for graphs, a clone otherwise), also used by soft CPU particles with a material asset.
- The WebGPU alive count lags further while the GPU queue is behind (each read waits for the work before it); paced frames get it a frame or two late.
- The Particle Graph's live preview draws kernel material-asset outputs with the texture (it has no material copies).

## Alternatives considered

- **Soft CPU particles through a custom Babylon particle effect** (`createEffectForParticles` with our own fragment shader). Keeps Babylon's particle draw, but needs GLSL and WGSL copies of Babylon's particle fragment shader and its includes, re-checked on every Babylon upgrade; our mesh draws already exist and take any material.
- **Dead list everywhere, emulated on WebGL2** (a GPU stream compaction with no atomics: prefix sums over the alive flags each frame). Same behaviour on every executor, but log₂n extra passes every frame and a far larger WebGL2 path, for the fallback renderer.
- **Exact counts with the ring kept everywhere.** Same spawning on all executors, but a full system keeps cutting its oldest particles short, which is the visible problem.
- **Sorting on by default for every blending, or opt-in only.** Additive particles don't need it; opt-in leaves alpha-blended smoke wrong until someone notices.
- **Material assets by generating a kernel `ShaderMaterial` from the shader graph.** Would skip the texture copy on WebGPU, but loses Babylon's lighting and the physical layers, and doesn't cover built-in material assets.
- **Trails as one ribbon per particle built on the CPU from a read-back.** A read-back stalls or lags; the history stays on the GPU.

## Consequences

**Positive**
- Every particle gap the 0057, 0060, 0094, 0095 and 0096 rows list is built or answered.
- Full kernel systems behave like VFX Graph's on WebGPU; `particleCount` is exact on WebGPU (a frame or two late) and JavaScript.
- Height fog reaches particles and any `ShaderMaterial` through one hook.

**Negative / costs**
- WebGL2 kernel systems differ from WebGPU and JavaScript when full (ring vs dead list), and their counts stay estimates.
- Sorting costs log² passes per sorted output per frame; trails cost `trailLength` × 16 bytes per slot; material-asset outputs on WebGPU cost a buffer-to-texture copy per frame and a material clone per output.
- Soft CPU emitters (and CPU billboards under height fog) lose Babylon's particle system draw, building quads in our code instead (about the same CPU cost).
- More generated shader code to keep in step (sort, trail and plugin variants of WGSL and GLSL).

## Deprecates

0094's ring spawning and estimated counts on WebGPU and JavaScript (kept on WebGL2 and for GPU-event children); 0094's "trail outputs and material-asset outputs are reported"; 0096's "kernel outputs only" for soft particles. Nothing is removed.

## Open questions

- Material assets on kernel trail outputs.
- Per-camera sort order for split screen.
- Lossless GPU events with a dead list (children still use the slot mapping).

## References

- `src/engine/render/babylon/softParticles.ts`, `heightFog.ts`, `gpuParticles.ts`, `particles.ts`, `particleDraw.ts`, `particleMeshes.ts`
- `src/engine/render/particles/gpu/` (`kernelShader.ts`, `kernelJs.ts`, `webgpuRun.ts`, `webgl2Run.ts`, `spawner.ts`, `kernelEffect.ts`), `src/engine/scene/particleKernel.ts`
- `src/editor/particleGraph/`, `src/editor/ui/particleGraph/`
- Unity VFX Graph (dead list, output sorting, strips)
