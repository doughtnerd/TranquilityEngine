# Frame plan and editor policy (follow-ups A + B), then C, D and loose ends

Builds on ADR 0127 and 0128 (both **Accepted** 2026-11-07). Source: [2026-11-architecture-followups.md](2026-11-architecture-followups.md), whose rules (renderer neutrality, ADRs, testing on this machine, delegation) apply here unchanged.

A and B are one piece of work and one ADR (**0129**, to be written and accepted before any code). They share `BabylonRenderer.render()` and the camera preview code, and B's knobs are the editor half of A's input.

## What the code does today (read 2026-11-07, `master` at `1128ab6`)

`BabylonRenderer.ts` (1,374 lines) holds a private `fill` flag, passed in by `BabylonSurface` for `kind === "editor"`. It decides:

| Where | Rule |
|---|---|
| `render()` | view 0 of an editor World previews `scenePostSettings` (first camera with PostProcessing, minus depth of field) |
| `render()` | `layerMask = fill ? 0xffffffff : 0x0fffffff` (editor-only meshes) |
| `render()` | editor `backdrop` on view 0 when it has no background and no post (ADR 0111) |
| `render()` | `ui` on view 0 when `this.tools`, else the last view; `overlay` on view 0 when `this.tools` |
| `render()` / `previewView()` | target cameras after canvas cameras; the preview inset last, never if its camera already draws; ortho aspect from the inset |
| `render()` ×3 | background + `skyFog` lerp, and `resolvePostEffects`, copied for canvas, target and preview cameras |
| `spriteMeshes` | `fill \|\| tools !== null \|\| toolsLoading !== null`: sprite batching (ADR 0108) depends on editor-tool load timing (the 42f2858 bug) |
| `syncUI` | `UICore({ interactive: !fill })` |
| `syncPreviewUI` | a second UI core for the preview inset, only when `fill` |
| `loadParticles` | `editor: fill`, `selected: selectedNodes.has(...)` |
| `editorContext` | `sprites()`/`meshes()` iterate the private `sprites`/`meshRenderers` maps |
| `diagnostics()` | re-derives `cameras` from `viewCameras`/`targetCameras`/`cameraPreviewDrawn` |

`resolvePostEffects` (`render/postEffects.ts`) is already pure and renderer-neutral; the frame plan calls it. `cameraPasses` in `frameGraph.ts` stays the tested downstream piece.

## ADR 0129 (draft outline — write it first, then ask for acceptance)

**Title:** "A renderer-neutral frame plan decides each frame's views; the editor sets renderer policy through its viewport handle."
Related: 0010, 0022, 0051, 0056, 0057, 0071, 0076, 0108, 0109, 0111, 0128.

1. **`render/framePlan.ts`, pure.** `planFrame(input: FrameInput): PlannedView[]`. Engine types only.
   - `FrameInput`: the World's enabled cameras (with their viewport rect, `targetTexture`, `depth`, background, `PostSettings | null`, projection and ortho size), which ones are in edit mode, `clearColor` (sRGB `[r,g,b]`), `skyFog` (`{ color, amount } | null`), the quality tier, and `policy: RenderPolicy` (below) plus `previewRect` (fractions of the canvas, or null) and `overlay` (the renderer has an overlay to draw).
   - `PlannedView`: `camera: Camera`; `output: { kind: "canvas", rect } | { kind: "texture", texture: string } | { kind: "preview", rect, aspect }`; `clear: Rgb | null`; `backdrop: Rgb | null`; `post: ResolvedPost`; `ui: "screen" | "preview" | null`; `overlay: boolean`; `editorContent: boolean` (a flag, never a layer mask).
   - It owns every rule in the table above that isn't Babylon: ordering, view/target selection (`viewCameras`/`targetCameras` move here), UI/overlay placement, scene-post preview, backdrop, fog tint, preview inset and its aspect.
   - `diagnostics().cameras` comes from the last plan (canvas / texture / preview), so it can't drift from what drew.
2. **`RenderPolicy`, renderer-neutral knobs** in `render/renderPolicy.ts`:
   - `sceneView: boolean` — the view sees editor-only content, previews the scene post, shows the backdrop, UI doesn't press buttons;
   - `drawPolicy: "batched" | "perObject"` — "keep per-object meshes" for sprites (ADR 0108);
   - `cameraPreview: { camera, frame } | null` — the camera-preview inset contributed by the caller (the scene-post preview is `sceneView`);
   - `particlePreview: { shown(c): boolean } | null` — null in games (game rules); the editor's predicate is selection or Simulate All.
   Default is a game: `{ sceneView: false, drawPolicy: "batched", cameraPreview: null, particlePreview: null }`.
   **Written up as [ADR 0129](../decisions/0129-renderer-neutral-frame-plan-and-editor-render-policy.md); the ADR wins where they differ.**
3. **Who sets it.** Not new `RenderSurface` members (0128 kept it at 12). `BabylonSurface` gives `ViewportHandle` a policy port at construction, live at once (not after the tools load). The handle sets `drawPolicy: "perObject"` the moment anything asks for the viewport, `sceneView` for an editor World, and forwards camera preview and selection to the port directly. The renderer loses `fill`; `BabylonSurface` keeps it only for canvas sizing.
4. **Drawn-mesh query.** The mesh and sprite code exposes `drawnMeshes()` / `drawnSprites()` iterators (engine Component → its Babylon meshes, inside `babylon/` only). `editorContext` reads those, not the renderer's private maps.

Alternatives to record: keep `fill` but make `spriteMeshes` read only `fill` (fixes 42f2858's cause, leaves editor rules in every game build, no tests); put the knobs on `RenderSurface` (regrows the seam 0128 just cut); a policy object passed at surface creation only (editor play mode attaches to an existing game surface, so it must be settable later).

Consequences to record: frame rules become unit-testable without WebGL; a new renderer reuses the plan and writes only the mapping; batching no longer depends on load timing; cost is one more module plus a mapping step per view per frame (a handful of objects, no allocation in steady state if `PlannedView`s are reused).

## Build plan

The renderer file has one writer at a time. Worktrees from `master` (check the merge-base).

**Wave 0 — coordinator.** Write ADR 0129, add its README row (Proposed), ask for acceptance.

**Wave 1 — parallel, disjoint files.**
- **1a (Sonnet):** `src/engine/render/framePlan.ts` and `src/engine/tests/framePlan.test.ts`, new files only, to the contract above (the coordinator pastes the exact types into the brief). Tests, with plain component objects: play mode puts screen UI over the last view camera; with an overlay the UI and overlay go on view 0; render-texture cameras come after canvas cameras and never see editor content; the preview inset is last, skipped when its camera already draws, and carries the inset aspect for orthographic cameras; fog tints the clear colour of canvas, target and preview views alike; the scene view previews the first camera's PostProcessing minus depth of field; backdrop only on an editor view 0 without background or post; edit-mode cameras never draw.
- **1b (Sonnet):** `src/engine/render/renderPolicy.ts` (types and the game default) and the `ViewportHandle` side in `editorViewport.ts` plus `fakeViewport.ts` and `babylonEditorViewport.test.ts`: the handle takes a policy port, sets `perObject` on first ask and `sceneView` when eager, forwards preview and selection at once. No renderer edits.
- **1c (Haiku), loose end:** move `tests/e2e/shadergraph.spec.ts`, `shadersubgraph.spec.ts`, `shaderassets.spec.ts` off `render.renderer.meshRenderers` to `diagnostics().drawn` (extend `DrawnMaterial` with the material name only if a spec needs it — then that one-line change is the coordinator's, in wave 2).

**Wave 2 — coordinator (Opus), the single renderer writer.**
- `BabylonRenderer.render()` builds `FrameInput`, calls `planFrame`, maps each `PlannedView` to a `CameraView` (TargetCamera, `editorContent → layerMask`, `Rgb → Color4`, texture path → `renderTextures.target`). Delete `previewView`, `postSettings`, `scenePostSettings`, `viewCameras`, `targetCameras` and the copied background code; `previewRect` stays as the DOM measurement feeding the plan.
- Replace `fill` with the policy: `spriteMeshes` reads `drawPolicy`; `UICore` interactivity and the preview UI core read `sceneView`/`cameraPreview`; the particle host takes `particlePreview` instead of `editor` + `selected` (adjust `particles.ts` and its NullEngine tests).
- `BabylonSurface` wires the port into `ViewportHandle`; `editorContext` uses the drawn-mesh query.
- New test in `spriteBatching.test.ts`: "batches in a game; per-object meshes once the editor asks for the viewport" (on NullEngine), replacing the load-timing dependence.

**Wave 3 — checks and merge.** Fresh-agent review against ADR 0129 and the neutrality rule (no Babylon import in `framePlan.ts`/`renderPolicy.ts`). `npm run typecheck`, `npm test`, then (not at the same time) `E2E_SOFTWARE_GL=1 npx playwright test --project=chromium` and the WebKit project; compare any failure to the known-failing list, and to a master worktree on `E2E_PORT=4190` if new. Manual check in `npm run dev`: editor scene view (grid, backdrop, scene post preview, camera preview inset with UI), editor play mode with sprites (picking and outlines), a sample game. Docs: 0129 row in `implementation-status.md`; update rows 0022, 0051, 0057, 0108 (drop the batching exception note). Ask before pushing to master.

## After A + B

- **C — render features behind one shape** (own ADR, 0130). Starts after A + B merge: it reshapes `sync`/`release`/`dispose` in the same file. Plan it then, against the post-A+B renderer; model on `BabylonParticleHost`. Warm-up (0080) asks each feature for warm content; keep on-demand loading (0083).
- **D — field metadata on the Component declaration** (own ADR, public API: `@field(AssetRef, { kind, hidden })` and an Inspector-sections registry). Touches no renderer file, so it can run now in its own session and worktree, in parallel with A + B.
- **Loose ends.** Playstats: give `playStats.ts` a cheap stats getter instead of the full `diagnostics()` (small, can ride with wave 2 or go alone). Overlay port cost (renderer-neutral line/shape lists from `editorOverlays.ts`): later, its own ADR. Delete merged branches `claude/material-library-306b29` and `claude/render-surface-split-373326` and their worktrees (ask first).
