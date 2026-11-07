# Babylon.js renderer spike

A throwaway test, not engine code. It checks whether Babylon.js meets the two requirements for replacing three.js (see the discussion that led to it): plain GLSL/WGSL shaders with no TSL, and built-in high-end quality features. Windows / WebView2 (Chromium) is the target.

Run `npm run dev`, or the `babylon-spike` launch config (port 3011), and open `/spikes/babylon/`.

Babylon `@babylonjs/core` 9.32.0 is a devDependency for this spike only. Nothing in `src/` imports it.

## What the scene does

A colonnade under a slatted roof, lit by a rotating sun. Everything renders through a hand-built **frame graph**, in this order:

1. clear
2. 2048 px PCF shadow map
3. HDR object render
4. lighting volume
5. **volumetric lighting**
6. HDR bloom
7. **custom WGSL post-process**: ACES tone map, warm grade, vignette, grain, sRGB encode. It writes straight to the back buffer.

A torus knot uses a **custom `ShaderMaterial` written as a complete plain-WGSL vertex and fragment pair**. The HUD has toggles for each effect. They only zero the effect's strength, so the passes still run when "off".

## Results (WebView2-equivalent Chromium, AMD RDNA 3, 1781×1206)

| Check | Result |
|---|---|
| WebGPU engine | ✅ `WebGPUEngine`. No GLSL transpiler download was needed: Babylon's own shaders ship as WGSL. |
| Plain WGSL material | ✅ Full vertex and fragment source passed directly (`{ vertexSource, fragmentSource }`, `shaderLanguage: WGSL`). Babylon's WGSL dialect: `attribute`/`varying`/`uniform` declarations, `#include<sceneUboDeclaration>`, `uniforms.x`, `vertexInputs`/`vertexOutputs`. It adds the bind groups itself. |
| Plain WGSL post-process | ✅ `FrameGraphCustomPostProcessTask` with a WGSL source registered in `ShaderStore.ShadersStoreWGSL["<name>PixelShader"]`. Uniforms set through `onApplyObservable`. |
| Volumetric lighting | ✅ `FrameGraphLightingVolumeTask` + `FrameGraphVolumetricLightingTask`: real shadow-mapped shafts through the slats. Directional light only. |
| Shadows | ✅ After a fix. With the sun's shadow camera 40 units from the scene centre and no depth range, everything was in shadow. Placing it at 100 units with `shadowMinZ`/`shadowMaxZ` fixed it. |
| HDR bloom | ✅ Picks up the emissive orb and the bright plasma. |
| Frame rate | Holds 60 fps (vsync) with everything on. |
| GPU timing | ❌ Not obtained. `timestamp-query` was granted, but Babylon's GPU frame counter stayed at 0 with a frame graph driving rendering. |
| Bundle size | The `@babylonjs/core` barrel import pulled in the whole library (6.7 MB raw, 1.47 MB gzip). With module-by-module imports (now in `main.ts`): **430 KB gzip loaded at start** (1.74 MB raw), plus 188 KB gzip of lazy chunks (per-language shaders, loaders, the WebGL2 fallback). About 35 KB gzip of that is `ArcRotateCamera` and its input code, which the engine won't use. For comparison, the current player's three.js core chunk is 65 KB gzip. |

## Friction found

- **Tuning is physical and sensitive.** The volumetric `lightPower` needed to be about 0.1. At 1.6 the fog went white, because it integrates over the whole lighting volume.
- **A frame graph replaces `scene.render`'s built-in pipeline.** You assemble passes yourself, so the classic `DefaultRenderingPipeline` doesn't apply, and `scene.activeCamera` is cleared (set `scene.cameraToUseForPointers`). This fits an engine that owns its render setup, but it's more code than one switch.
- **Documentation is thin.** The volumetric task's docs show internals, not wiring. The wiring came from reading the `.d.ts` files and `NodeRenderGraph.setToDefault()`.

## Not tried

- TAA, SSAO2, SSR, cascaded shadows in the frame graph. These tasks exist but need a geometry renderer for depth, normals and velocity.
- Volumetrics from spot or point lights.
- Light probes or GI, and IBL with an environment map.
- Deep-import bundle size, and GPU cost per effect.

## Check pages

Run with `npm run dev` and keep the browser window visible (a hidden page stops `requestAnimationFrame`; these step the engine by hand anyway).

- `/spikes/babylon/depth.html`: depth order (a red cube in front of a blue one), or `?scene=playground`; results in `window.__depth`.
- `/spikes/babylon/stage6.html`: water, fog, a probe and shadows on the GPU; results in `window.__stage6`.
- `/spikes/babylon/ui.html`: the screen UI pass; results in `window.__ui`.
- `/spikes/babylon/lights.html`: clustered against regular point and spot lights (ADR 0079), the same scene drawn both ways and diffed, with spot lights at four `spotSoftness` values; results in `window.__lights`.
