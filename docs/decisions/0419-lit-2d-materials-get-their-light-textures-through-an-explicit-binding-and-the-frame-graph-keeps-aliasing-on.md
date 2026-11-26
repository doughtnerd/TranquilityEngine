# 0419. Lit 2D materials get their light textures through an explicit binding, and the frame graph keeps aliasing on

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0399, 0415, 0418

## Context

The lit 2D material (`Light2DPlugin.bindLights`, `render/babylon/lights2DMaterial.ts`) finds the lighting rig with
`lights2DOf(scene)` (a `rigs` WeakMap in `lights2D.ts`) and the camera's light textures with `lights2DTextures(scene,
camera)` (the `frames` WeakMap in `frameGraph.ts`), sampling them behind the frame graph's back. Commit 36ab1a75 forced
a rebind on every draw (`hardBindForSubMesh`), bound straight to `subMesh.effect`, and turned
`optimizeTextureAllocation` off for the whole graph.

The ADR 0418 spike (2026-11-26, Babylon 9.32.0) found the root cause. The camera's render task never declares the light
textures, so Babylon gives them short lifespans (`light2d_0_0_0: 200–201`, `light2d_0_1_0: 202–202` with two blend
styles and shadows) and aliases the second blend style's texture onto the first
(`frameGraphTextureManager.js` `_optimizeTextureAllocation`, ~726–770). The lit material then samples one texture for
both styles. Declaring them in the render task's `dependencies` (`frameGraphTask.d.ts:33`, read by
`_computeTextureLifespan` ~786–790) gave lifespans of `200–399` and no aliasing, with optimisation on.

Material plugin hooks get `(ubo, scene, engine, subMesh)` and nothing that names the camera
(`materialPluginBase.pure.js` ~121, 129), so a binding has to carry "this pass's textures".

## Decision

- **The frame graph declares what samples the light textures.** Each camera's `FrameGraphObjectRendererTask` gets its
  flat, directional colour, directional vector and shadow textures in `dependencies`. `optimizeTextureAllocation` is back
  on for the whole graph. Any other pass that samples them adds them to its own `dependencies`.
- **One explicit binding.** `lights2D.ts` owns a `Lights2DBinding`: the rig (batches, styles, white/black fallbacks,
  range) and `active: Lights2DTextures | null`. `frameGraph.ts` wraps each camera's textures once a build succeeds, sets
  `binding.active` in that render task's `objectRenderer.onBeforeRenderObservable` and clears it after. The 2D materials
  module (ADR 0418) puts the binding into each lit setup; `Light2DPlugin` reads it.
- **Retired:** the `rigs` WeakMap and `lights2DOf`, and `lights2DTextures` (the `frames` WeakMap stays for scene depth).
  `hardBindForSubMesh` goes if the GPU e2e passes without it: Babylon resets `mustRebind` at the start of every object
  renderer render and each camera has its own draw wrappers, so `bindForSubMesh` runs on the first draw of a material in
  every pass. The clear fix from 36ab1a75 (`clear(zero, true, false)`) stays.

## Alternatives considered

- **History textures** — exempt from aliasing, but ping-pong between frames and double the memory.
- **Keep optimisation off (today)** — every other pass loses aliasing to protect four textures.
- **Keep the scene lookups, add only `dependencies`** — fixes aliasing, but the hidden dependency stays.

## Consequences

**Positive**
- Texture aliasing on for the whole frame graph; the binding is visible in the 2D materials module's interface.
- Likely an end to the per-draw rebind cost on lit 2D draws.

**Negative / costs**
- A pass that samples light textures and forgets `dependencies` gets aliased textures again; the rule lives in
  `frameGraph.ts` beside the render task.
- Unit tests can't prove what the GPU samples, and checking lifespans would mean reading Babylon internals (not allowed in
  committed tests). The e2e specs carry it.

## Deprecates

`lights2DOf`, the `rigs` WeakMap, `lights2DTextures`, `optimizeTextureAllocation = false`, and probably
`hardBindForSubMesh` in `lights2DMaterial.ts`.

## Open questions

- Whether `hardBindForSubMesh` can go: settled by running the e2e without it.

## References

- ADR 0418 spike report (2026-11-26); commit 36ab1a75.
- Verification: `tests/e2e/lights2d.spec.ts` on Chromium and WebKit, plus new cases: two blend styles lit at once (the
  aliasing case), and two cameras at different sizes (scene view and game view in Play).
