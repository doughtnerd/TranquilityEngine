# 0056. Camera viewports, and post-processing on every camera

- **Status:** Accepted
- **Date:** 2026-11-03
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Amends:** 0051 (effects on the main camera only)
- **Related:** 0004, 0014, 0051

## Context

Post-processing (0051) runs for the lowest-depth camera only; other cameras and the editor's camera-preview inset draw without effects. Cameras also always cover the whole canvas, so a second camera can only overlay the first: no split screen, no minimap or rear-view mirror. Both limits come from the same place, the render loop drawing every camera full-canvas.

## Decision

- **Camera viewports.** `Camera` gains `viewportPosition` (a `Vector2`, default 0,0) and `viewportSize` (default 1,1): the camera's rectangle on the canvas, as fractions from the bottom-left, as in Unity's Viewport Rect. Each camera renders into its rectangle, with the scissor set, and its aspect ratio follows the rectangle. Cameras are still drawn in depth order. A camera with a background colour clears its rectangle; one without clears only depth (an overlay).
- **Effects on every camera.** Each camera with a PostProcessing component gets its own composer, sized to its rectangle and gated by the quality tier as before. An overlay camera's composer renders on a transparent background and blends its result over what's already drawn, so a weapon or 3D UI camera can have its own bloom without erasing the scene behind. The editor's camera-preview inset uses the previewed camera's composer, drawn into the inset.
- **Editor.** The scene view keeps previewing the scene's first PostProcessing camera, and a selected camera's preview inset shows its view with its effects.

## Alternatives considered

- **Viewports as render-to-texture** (cameras drawing into textures shown on UI). A separate feature (render textures); viewports cover split screen and minimaps directly.
- **One composer for all cameras.** Cheaper, but cameras with different effects and rectangles can't share one.

## Consequences

**Positive**
- Split screen, minimaps and picture-in-picture views; per-camera effects, including overlays.

**Negative / costs**
- Each camera with effects holds its own composer and render targets.
- Overlay composites go through blending, which can differ slightly from a single combined pass.

## Deprecates

Nothing. 0051's "main camera only" limit is lifted.

## Open questions

- Render textures (a camera drawing into a texture asset).
