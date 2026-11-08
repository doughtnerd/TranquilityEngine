# 0129. A renderer-neutral frame plan decides each frame's views; the editor sets render policy through its viewport handle

- **Status:** Accepted
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0022, 0026, 0051, 0056, 0057, 0071, 0076, 0108, 0109, 0111, 0128

## Context

Each frame, `BabylonRenderer.render()` (`render/babylon/BabylonRenderer.ts`, 1,374 lines) decides which cameras
draw, in what order, where, with which clear colour and post-processing, and which view gets the UI and the
editor overlay. Those rules are written inline and have no tests:

- UI goes on view 0 when editor tools exist, otherwise on the last view (ADR 0076). The overlay goes only on view 0.
- An editor World's view 0 previews the first camera's PostProcessing minus depth of field (`scenePostSettings`, ADR 0051).
- An editor World's view 0 with no background and no post shows the editor background as a backdrop, not tone mapped (ADR 0111).
- `layerMask = fill ? 0xffffffff : 0x0fffffff` decides whether a view sees editor-only meshes.
- Render-texture cameras draw after canvas cameras (ADR 0109). The camera-preview inset draws last, never when its camera
  already draws, and an orthographic preview takes the inset's aspect ratio (ADR 0022).
- Fog's `affectsSkybox` blends the clear colour (ADR 0071).

The background, fog-blend and post-resolution code is copied three times: canvas cameras, render-texture cameras
and the preview (`previewView`). `diagnostics().cameras` (ADR 0128) works the camera list out again separately.

Editor state also decides runtime behaviour. The renderer keeps a private `fill` flag, true for an editor World
(`BabylonSurface`, `kind === "editor"`). It sets the layer mask, the scene-post preview and the backdrop, makes the UI
non-interactive (`UICore({ interactive: !fill })`), builds a second UI core for the preview inset, and puts particles
into preview mode (`editor: fill`, where script commands are ignored, only selected systems or Simulate All play, at
the preview speed). Whether sprites batch (ADR 0108) is `fill || tools !== null || toolsLoading !== null`, so it
depends on whether the editor tools have started loading. Commit 42f2858 had to fix editor play mode because of
this. Every game build carries these paths behind booleans. The editor helpers (`editorContext.ts`) also read the
renderer's private `sprites` and `meshRenderers` maps.

The owner's standing goal (ADR 0010, 0128): a future renderer switch, or a home-grown renderer, must need only a
thin backend adapter. Today a new renderer would have to work all of these rules out again from Babylon code.

## Decision

**1. A pure frame plan, `render/framePlan.ts`.** We add `planFrame(input: FrameInput): PlannedView[]`. It imports
no backend types.

- **`FrameInput`:**
  - the World's cameras: each `Camera` component with its viewport rectangle, `targetTexture`, `depth`, background,
    PostProcessing settings (`PostSettings | null`), projection, orthographic size, and whether it's in edit mode (ADR 0026);
  - `clearColor` and `skyFog` (`{ color, amount } | null`), as sRGB numbers;
  - the quality tier;
  - `overlay`: whether the renderer has an editor overlay to draw;
  - `policy: RenderPolicy` (part 2), and the preview inset's rectangle as canvas fractions (measured by the renderer
    from the DOM; null when there's none).
- **`PlannedView`**, in draw order:
  - `camera: Camera`;
  - `output`: `{ kind: "canvas", rect }`, `{ kind: "texture", texture }` (the asset path) or `{ kind: "preview", rect, aspect }`;
  - `clear: Rgb | null` and `backdrop: Rgb | null`;
  - `post: ResolvedPost`, from `resolvePostEffects` (`render/postEffects.ts`, already pure);
  - `ui: "screen" | "preview" | null` and `overlay: boolean`;
  - `editorContent: boolean`: the view sees editor-only content. A flag, never a layer mask.
- **It owns** every rule listed in Context except the Babylon mapping, including which cameras are view cameras
  and which are target cameras (`viewCameras`/`targetCameras` move into it).
- **The renderer maps and runs.** `BabylonRenderer.render()` builds the input, calls `planFrame`, and maps each view
  to a frame-graph `CameraView`: the camera's `TargetCamera`, `editorContent` to a layer mask, `Rgb` to `Color4`, a
  texture path to its render target, the preview aspect to `orthoLeft`/`orthoRight`. `cameraPasses` in
  `frameGraph.ts` stays the tested step after it.
- **Diagnostics read the last plan.** `diagnostics().cameras` lists the last plan's views (`canvas`, `texture`,
  `preview`), so the report can't disagree with what drew.

**2. `RenderPolicy`: renderer-neutral settings, in `render/renderPolicy.ts`.**

| Setting | Meaning | Game default |
|---|---|---|
| `sceneView: boolean` | The view sees editor-only content, previews the scene camera's post-processing, shows the backdrop; UI clicks select rather than press buttons | `false` |
| `drawPolicy: "batched" \| "perObject"` | `"perObject"` keeps a mesh per sprite (for picking and outlines); `"batched"` lets plain sprites batch (ADR 0108) | `"batched"` |
| `cameraPreview: { camera, frame } \| null` | An extra view the caller contributes: a camera drawn into an inset, with its screen UI laid out at the inset's size | `null` |
| `particlePreview: { selected(node: GameObject): boolean } | null` | Particles in preview mode (ADR 0057): script commands ignored, only systems on selected nodes play (all with Simulate All), at the preview speed |\| null` | Particles in preview mode: script commands ignored, only systems where `shown` is true play, at the preview speed (ADR 0057) | `null` (game rules) |

The renderer reads only this, never `fill`. `fill` stays on `BabylonSurface`, which uses it only for canvas sizing.

**3. The editor sets the policy through its viewport handle, not through new `RenderSurface` members.** ADR 0128
cut `RenderSurface` to 12 members, and this keeps it there. `BabylonSurface` gives `ViewportHandle`
(`render/editorViewport.ts`) a policy port when it creates the handle. The port works at once, before the editor
tools have loaded.

- **Per-object meshes on request.** When anything first asks for the viewport (an editor World at once; editor play
  mode when it reaches into the game World), the handle sets `drawPolicy: "perObject"`. Batching then depends on an
  explicit request, not on load timing.
- **Scene view.** An editor World's handle (the eager one) also sets `sceneView` and `particlePreview`.
- **No waiting for the tools.** `setCameraPreview`, `setParticlePreview`, `restartParticlePreview` and `setSelection` (which feeds `particlePreview.selected`) go to
  the port immediately. The adapter (`ViewportAdapter`) keeps only what the editor tools draw: grid, outlines,
  overlays, gizmos and queries.
- **Test fake.** `fakeViewport.ts` gets a fake port so `ViewportHandle` tests check the policy it sets.

**4. Editor helpers read drawn meshes through a query.** The Babylon mesh and sprite code exposes iterators of
drawn meshes and sprites (an engine Component paired with its Babylon meshes). These stay inside `render/babylon/`.
`editorContext.ts` reads them instead of the renderer's private maps.

*Done by ADR 0130 (2026-11-07):* `editorContext.sprites()`/`meshes()` read the sprite and mesh features' iterators (`babylon/sprites.ts`, `babylon/meshes.ts`).

*Built 2026-11-07 (before 0130):* the sprite and mesh maps still live in `BabylonRenderer` itself (there is no separate mesh or
sprite module to host the query yet), and `editorContext.sprites()`/`meshes()` are already iterators the renderer
supplies, so nothing outside the renderer reads the maps. Moving them behind a feature's own query belongs to
follow-up C (render features behind one shape). The e2e specs that still read the private `meshRenderers` map
need `diagnostics().drawn` to report material identity and readiness first; that remains a loose end.

## Alternatives considered

- **Keep `fill`, and make sprite batching read only `fill`.** This fixes the cause of 42f2858 in one line, but editor
  rules stay in every game build, the frame rules stay untested, and editor play mode loses per-object sprite
  meshes, which its picking needs.
- **Put the policy on `RenderSurface`.** This is direct, but it grows the seam ADR 0128 just cut, and the Engine
  itself never sets these.
- **Pass the policy only when the surface is created.** Editor play mode attaches to a game surface that already
  exists, so the policy has to be settable later.
- **Put the frame plan under `render/babylon/`.** This is less moving, but the rules aren't about Babylon, and a new
  renderer would have to rewrite them (ADR 0010).
- **Have the frame plan return Babylon cameras or layer masks.** That saves a mapping step, but backend values
  would cross the seam.

## Consequences

**Positive**
- The frame rules are unit-tested in-process with plain components, without WebGL. Examples: play mode puts the
  screen UI over the last view; render-texture cameras never see editor content; fog tints every clear colour.
- The copied background, fog and post code exists once. `diagnostics().cameras` matches what drew.
- Sprite batching depends on an explicit policy. A test covers "batches in a game, per-object meshes once the
  editor asks for the viewport".
- A game World never asked for its viewport runs only game rules: no editor branches in its frame.
- A new renderer reuses `framePlan.ts` and `renderPolicy.ts` as they are, and writes only the view-to-camera mapping.

**Negative / costs**
- There is one more module, and a mapping step per view per frame. That is a handful of objects; the renderer
  reuses the plan's arrays to avoid per-frame allocation.
- `ViewportHandle` gains a second dependency (the policy port) beside the adapter.
- The particle host's `editor` and `selected` arguments change to `particlePreview`, so `particles.ts` and its
  NullEngine tests change.

## Deprecates

- The renderer's private `fill` flag and the `spriteMeshes` rule based on tool loading. Both are removed.
- `previewView`, `postSettings`, `scenePostSettings`, `viewCameras` and `targetCameras` in `BabylonRenderer.ts`
  move into the frame plan. `previewRect` stays as the DOM measurement that feeds it.
- The `setSelected` and `setCameraPreview` routes through `ViewportAdapter`/`BabylonEditorContext.renderer` move
  to the policy port.
- The note in `implementation-status.md` about the sprite-batching exception (ADR 0108) is updated.

## Open questions

- Should the overlay's placement (view 0) also become a policy setting, for a future multi-view editor layout?
  Not needed today.
- Should a game World that the editor never asked for its viewport ever switch back to `"batched"` (for example
  when editor play mode stops reaching into it)? Today the World is thrown away when play mode stops, so no.

## References

- Plan: [docs/plans/2026-11-frame-plan-and-editor-policy.md](../plans/2026-11-frame-plan-and-editor-policy.md);
  review handoff: [docs/plans/2026-11-architecture-followups.md](../plans/2026-11-architecture-followups.md) (A and B).
- Code: `render/babylon/BabylonRenderer.ts` (`render`, `previewRect`, `previewView`, `syncUI`, `syncPreviewUI`,
  `loadParticles`, `spriteMeshes`, `editorContext`, `diagnostics`), `render/babylon/frameGraph.ts` (`CameraView`,
  `cameraPasses`), `render/postEffects.ts`, `render/editorViewport.ts`, `render/fakeViewport.ts`,
  `render/babylon/BabylonSurface.ts`, `render/babylon/editorContext.ts`, `render/babylon/editorTools.ts`,
  `render/babylon/particles.ts`.
- Tests to extend: `src/engine/tests/babylonFrame.test.ts`, `babylonEditorViewport.test.ts`, `spriteBatching.test.ts`.
- Commit 42f2858 (the editor play-mode batching fix).
