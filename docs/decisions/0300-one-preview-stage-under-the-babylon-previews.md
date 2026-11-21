# 0300. One preview stage under the Babylon previews, with the thumbnail orbit convention

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0061 (thumbnails and the Inspector preview), 0075 (stage 7, the Babylon previews), 0164 (left-handed, +Z forward), 0244 (the engine factory), 0277 (the default light rig)

## Context

Four Babylon previews in `render/babylon/previews/` each started their own engine: `MaterialPreview` and
`NodePreviewRenderer` (shader graphs), `ParticleEffectPreview` and `ThumbnailRenderer`. Each repeated `createEngine`,
the "disposed while the engine was starting" check, the scene, the default lights, a camera, a render loop and resizing.
The orbit had three conventions:

- **Material preview:** yaw 0 at −Z, `yaw + dx·0.01`, pitch ±1.4.
- **Particle preview:** yaw 0 at −Z, `yaw − dx·0.01`, pitch ±1.4, wheel zoom 0.5..60. Dragging the material and the
  particle preview the same way turned them opposite ways (confirmed).
- **Thumbnails' Inspector preview:** `thumbnailMath` (`orbitPosition`: yaw 0 at +Z; `MAX_PITCH` ≈ 1.52).

Only thumbnails listened for GPU context loss, and the material preview's drag listened for `pointerup` only, so a
cancelled pointer left the drag attached.

## Decision

We will have one **preview stage** (`render/babylon/previews/previewStage.ts`, `PreviewStage`) that owns, for a canvas:

- **Start-up:** the engine from `createEngine` (ADR 0244), started at construction; `ready` resolves true once up, false
  when no engine started or the stage was disposed first (the late engine is then disposed). `onUp` runs before the
  first frame. A failed start warns once under the preview's name.
- **The scene:** made by the stage, transparent, lit by the default rig (ADR 0277) unless asked for `"unlit"`; or none,
  for the thumbnails, which make a scene per asset on the stage's engine.
- **One orbit model:** `thumbnailMath`'s `Orbit` (yaw about +Y, 0 at +Z; pitch within `MAX_PITCH`; distance). A stage
  with an orbit has a perspective camera aimed at its target, turned by dragging the canvas with
  `draggedOrbit` (drag right: the front of what is shown follows the pointer, the camera's yaw grows; drag down: the camera
  rises; 0.01 rad per pixel) and zoomed by the wheel between its distance limits. The drag ends on `pointerup`,
  `pointercancel` or `lostpointercapture`.
- **Loop, resize, context loss:** an animation-frame loop calling the preview's `frame(dt)` while the canvas is shown;
  the drawing buffer fitted to an element at the World surface's pixel ratio; on context loss the loop pauses, `lost`
  is set and `onContextLost` listeners run; on restore the loop resumes.

The previews keep only what they put on stage: the material preview its mesh, graph material and studio room; the node
previews their quad and orthographic camera; the particle preview its grid, background and effect player; the
thumbnails their scenes, matting, capture and the Inspector preview (which keeps its `ThumbnailPreview` interface and
uses the same orbit model). The material and particle previews' starting views keep their place in the new convention
(yaw π − 0.6); their pitch limit becomes `MAX_PITCH`.

## Alternatives considered

- **A shared start-up helper only** — removes the copies of `createEngine` and the dispose check but leaves three orbit
  conventions and context loss in one preview.
- **Keep the −Z convention of the two live previews** — the thumbnail one is already tested and used by the Inspector,
  and matches what `frameView` returns.

## Consequences

**Positive**
- One start-up, one orbit, one place for context loss; every preview survives a lost context the same way.
- The orbit model is tested once (`thumbnailMath.test.ts`), the stage's lifecycle once (`previewStage.test.ts`).

**Negative / costs**
- The material preview now turns the other way when dragged (as the particle preview and the Inspector preview do),
  and both live previews may look a little further up or down (1.52 rad instead of 1.4).

## Deprecates

The engine start-up, camera, loop, resize and drag code inside `MaterialPreview`, `NodePreviewRenderer`,
`ParticleEffectPreview` and `ThumbnailRenderer`: removed, moved onto the stage.

## Open questions

None.

## References

`src/engine/render/babylon/previews/previewStage.ts`, `src/engine/render/thumbnailMath.ts`; review card 6 and small
fixes 4 and 5 of the 2026-11-21 architecture review.
