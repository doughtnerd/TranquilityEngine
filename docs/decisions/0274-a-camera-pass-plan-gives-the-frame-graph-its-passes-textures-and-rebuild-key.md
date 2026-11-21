# 0274. A camera's pass plan gives the frame graph its passes, textures and rebuild key

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0051, 0075, 0109, 0111, 0129

## Context

Three things described a camera's pass layout on the Babylon backend, and they disagreed:

- `stackKey` (`render/postEffects.ts`) keyed tone mapping, colour grading (`grade`), the vignette (`vig`), and SMAA
  and FXAA apart.
- `cameraPasses` (same file) listed the passes: grading, the vignette and tone mapping are values of the finish pass
  (`finishShader.ts` uniforms), and SMAA and FXAA build the same FXAA pass.
- `BabylonFrame.render` (`render/babylon/frameGraph.ts`) built its own JSON key from `stackKey`, then called
  `cameraPasses` twice per view (once for the textures, once for the tasks) and re-derived texture choices inline
  (no multisampling with ambient occlusion, normals for AO, an 8-bit texture before FXAA).

So ticking Vignette, changing the tone mapping curve or moving brightness off 0 rebuilt the whole frame graph, and
`BabylonRenderer` shows the clear colour on a rebuilding frame: a visible flash. `postEffectsKey.test.ts` pinned that
over-eager key, because the key was a pure function pulled out of the module that knows what gets built.

Separately, `BabylonRenderer.frameCameras` handed the frame plan `{ ...postProcessing, enabled: true } as unknown as
PostSettings`: an unchecked double cast (a renamed component field would compile and silently read `undefined`) and a
copy of the component per camera per frame.

## Decision

- **One pass-plan module**, `render/passPlan.ts` (pure, renderer-neutral): `planCameraPasses(effects, depth)` takes a
  camera's resolved effects (`PostEffects | null`, from `resolvePostEffects`) and whether anything asked for the
  scene depth (ADR 0109), and returns a `CameraPassPlan`:
  - `passes`: the ordered `PassKind`s (`clear`, `geometry`, `render`, `ao`, `dof`, `bloom`, `ca`, `finish`, `fxaa`);
  - the textures they need: `geometry` (depth with its own depth buffer, `normals` when AO reads them), `multisample`
    (false with AO), `aoRatio` (AO's resolution share, a build-time choice), `finishToLdr` (FXAA follows);
  - `key`: built from those members only, so values that are uniforms or task properties (tone mapping, exposure,
    grading, vignette, the LUT, every effect's strength, AO sample counts) never change it. SMAA and FXAA give one key.
- **The frame graph builds from the plan.** `BabylonFrame.render` plans each view once per frame; `viewTargets` and
  `viewTasks` read only the plan for what to build, and the frame's rebuild key holds each view's plan key beside
  what only the frame knows (camera, size, clear or blend-over, target, overlay/UI flags, shadows, sample count).
  Effect values are set each frame in `update`, the finish pass's uniforms and LUT path included.
- **`stackKey` and `cameraPasses` are deleted**; `PassKind` moves to `passPlan.ts`. Their tests are replaced by
  `passPlan.test.ts` (pass order, textures, "a uniform-only change keeps the key", "SMAA and FXAA are one pass") and a
  `babylonFrame.test.ts` case that drives `BabylonFrame.render` on a NullEngine and checks which changes add tasks.
- **`PostSettings` is derived from the component**: `Pick<PostProcessing, …>` of the fields `resolvePostEffects`
  reads plus `enabled`, and `ToneMappingName` is `PostProcessing["toneMapping"]`. The renderer passes the live
  component (`p.isActiveAndEnabled ? p : null`); the frame plan reads it and keeps only resolved copies.
- **Found while building:** `update` set AO's `ssao.samples` every frame, and Babylon's setter recompiles the effect
  and draws a new random sample kernel, so AO noise shimmered frame to frame. It is now set only when it changes.

## Alternatives considered

- **Drop the effect names from `stackKey`** — fixes the flash, but leaves three descriptions of the layout that can
  drift again, and a key tested apart from what is built.
- **Make the frame graph tolerate any change without a rebuild** (build every pass, disable unused ones) — costs
  passes and textures on every camera to avoid rare rebuilds of real layout changes.
- **Keep `PostSettings` as an interface and check it with `satisfies`** — still two lists of field names to keep in
  step by hand.

## Consequences

**Positive**
- No flash when editing tone mapping, exposure, grading, the vignette or the LUT, or when the composer turns on for
  finish-pass-only effects (a camera with no composer plans the same passes).
- The layout rule lives once; the test checks the rule the frame graph uses.
- AO low and medium (both half resolution) switch without a rebuild.
- A renamed or retyped PostProcessing field fails to compile in `postEffects.ts`; no per-frame component copy.

**Negative / costs**
- `postEffects.ts` imports the `PostProcessing` type from `render/components.ts` (type only).
- Test fixtures of `PostSettings` must list `lut` and `lutIntensity` (no longer optional).

## Deprecates

`stackKey`, `cameraPasses` and `PassKind` in `render/postEffects.ts` (removed); `tests/postEffectsKey.test.ts`
(removed); the cast in `BabylonRenderer.frameCameras` (removed). Amends 0129's note that `cameraPasses` stays the
tested step after the frame plan: the pass plan is that step.

## Open questions

None.

## References

- `src/engine/render/passPlan.ts`, `src/engine/render/babylon/frameGraph.ts`, `src/engine/render/postEffects.ts`
- `src/engine/tests/passPlan.test.ts`, `src/engine/tests/babylonFrame.test.ts`
- Architecture review, 2026-11-21, candidate 2.
