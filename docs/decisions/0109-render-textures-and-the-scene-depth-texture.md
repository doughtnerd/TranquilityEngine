# 0109. Cameras draw into render texture assets that materials, sprites and UI sample; each camera's scene depth is available to render code

- **Status:** Proposed
- **Date:** 2026-11-07
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0040, 0051, 0056, 0057, 0075, 0081

## Context

0056 left render textures open: a camera can only draw onto the canvas (in a viewport rectangle). Security-camera
screens, mirrors, portals, minimaps shown in UI and "3D model in a UI panel" all need a camera that draws into a
texture something else samples.

Each camera already renders into its own HDR texture in the Babylon frame graph (`render/babylon/frameGraph.ts`), and
its finish pass (`finishShader.ts`) tone maps and sRGB-encodes onto the canvas. The pieces are there; what's missing is
an asset to name the texture by, and a way to point a camera's last pass at it.

Separately, the GPU particles session needs the opaque scene's depth for soft particles. The geometry pass that
feeds ambient occlusion and depth of field writes linear view depth, but only on cameras with those effects, and after
the render pass, where particles draw.

## Decision

**Render texture assets.** A `*.rendertexture.json` file describes a texture (`render/renderTexture.ts`):

```jsonc
{ "width": 512, "height": 512, "format": "ldr", "depth": true, "filter": "linear", "wrap": "clamp" }
```

- `format`: `ldr` (8-bit, tone mapped and sRGB-encoded like the screen) or `hdr` (half float, linear, no tone
  mapping: for emissive screens and values above 1).
- `depth`: whether the camera draws with a depth buffer (off for flat 2D or UI captures).
- Read leniently like other assets: bad values are reported and replaced.

**Cameras.** `Camera.targetTexture` (AssetRef, empty = the canvas) makes a camera draw into the asset instead: the
whole texture at its size, its aspect the texture's, its viewport ignored, its PostProcessing applied. Target cameras
draw **after** the canvas cameras, so whatever samples the texture shows the previous frame; this keeps every "first
camera" assumption (cascades, probes, the warm-up, pointer camera) on the canvas camera. They also draw in the
editor's edit mode, so a screen shows its picture in the scene view.

**Sampling.** Anything that names an image can name a render texture: a material's `texture` and `normalMap`,
shader graph texture inputs, `SpriteRenderer.sprite`, UI images. The renderer's texture lookup returns the asset's
shared Babylon `RenderTargetTexture` (`render/babylon/renderTextures.ts`): one per asset, resized in place when the
asset changes, replaced only on a format change. The frame graph imports its GPU texture as the camera's finish-pass
target (`CameraView.target`).

**Scene depth (internal).** The geometry pass moves **before** the render pass, so what the render pass draws last
(transparent objects, particles) can sample the opaque depth. Render code asks for it with
`requestSceneDepth(scene, consumer)` (keeps a depth pass on every camera until released; the graph rebuilds once) and
reads it each frame with `sceneDepth(scene, camera)`: a `ThinTexture` of linear view-space depth in metres (half
float, one channel), cleared to the camera's far plane, plus its size, near and far (`frameGraph.ts`, `SceneDepth`).
A camera with ambient occlusion or depth of field shares the one pass. Nothing of this is public API (0010).

**Editor.** Render Texture is an asset kind with a New Render Texture menu item and an inspector; `targetTexture`
and the material texture pickers list render textures.

## Alternatives considered

- **Render texture as a component on the camera** (Godot's `SubViewport`). Then materials can't name it as an asset,
  and two cameras can't share one texture across scenes.
- **Draw target cameras first** (no frame of latency). Every "first view camera" path in the renderer would need to
  skip them; one frame of latency is what most engines show for screens and mirrors anyway.
- **A separate depth pre-pass for particles.** The geometry pass already writes linear depth and can be shared with
  AO and depth of field; a second pass would draw the scene twice more.
- **Sampling the render pass's own depth buffer.** It's bound as the attachment while particles draw, which WebGPU
  forbids sampling.

## Consequences

**Positive**
- Screens, mirrors, minimaps and UI model views without scripts; any image slot takes a render texture.
- Soft particles (and later screen-space effects) have one documented depth source.

**Negative / costs**
- Each target camera is a full camera's frame (cull, render, finish) per frame.
- Asking for the scene depth adds a geometry pass to every camera.
- A format change makes a new texture: materials made before keep the old one until they're rebuilt.
- Clustered lighting sizes its tiles from the canvas, not the target (the split-screen caveat of 0079).

## Deprecates

Nothing. 0056's "render textures" open question is answered here.

## Open questions

- Render textures sized as a fraction of the screen; mipmaps for distant screens.
- Updating a target camera less often than every frame (`refreshRate`).
- Verify on WebGPU that sampled render textures are upright (checked on the WebGL2 fallback).

## References

- `src/engine/render/renderTexture.ts`, `src/engine/render/babylon/renderTextures.ts`, `src/engine/render/babylon/frameGraph.ts`
- Tests: `src/engine/tests/renderTextures.test.ts`, `src/engine/tests/babylonFrame.test.ts`, `src/editor/renderTextureAssets.test.ts`
- Browser check: `spikes/babylon/rendering.html` (`?case=rendertexture`, `?format=hdr`, `?depth`)
