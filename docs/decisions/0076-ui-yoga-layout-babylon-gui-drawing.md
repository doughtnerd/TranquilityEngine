# 0076. Game UI: Yoga lays out, Babylon GUI draws, the engine routes input

- **Status:** Accepted
- **Date:** 2026-11-05
- **Deciders:** Chris Carlson
- **Supersedes:** 0069 in part (uikit as the drawing and layout library; the component API stays)
- **Related:** 0010, 0020, 0050, 0069, 0075

## Context

0069 built game UI on pmndrs uikit: `UICanvas`, `UIPanel`, `UIText`, `UIImage`, `UIButton` and `UIInputField`, with Yoga flexbox layout, MSDF text and UI-first pointer routing. `ui/UIRuntime.ts` (576 lines) mirrors the components into uikit objects, and 29 tests in `ui.test.ts` cover layout, routing, clicks and fields in Node. The interim `Text` component draws through a canvas texture in its own pass.

uikit is built on three.js objects, so it can't draw on the Babylon backend (0075, stage 9). 0075 kept the `UICanvas` component API and left the replacement to this record. On the Babylon backend today, neither the UI components nor the interim `Text` draw.

What's available:

- **Babylon GUI** (`@babylonjs/gui` 9.32.0, Apache-2.0, the same version as our core; peer dependency `@babylonjs/core ^9`). It provides:
  - A fullscreen UI texture, and UI on a mesh's texture for world space.
  - Rectangles with rounded corners and borders, text blocks with outlines, wrapping and ellipsis, images, buttons and input fields.
  - A `FlexPanel` with direction, wrap, justify, align, gap, and per-control `flexGrow` and `flexShrink`.
  - A frame graph task (`FrameGraphGUITask`) that draws a UI texture into a target.
  - It imports core module by module (no barrel imports). Text is drawn with the 2D canvas API, so it uses CSS fonts.
- **Yoga** (`yoga-layout` 3.2.1). It's already installed, because uikit depends on it. It's real CSS flexbox: margins, padding, absolute positioning, percentages and `auto`, exactly what the 0069 fields describe.

## Decision

We will split the UI runtime into a renderer-neutral core and a Babylon drawing layer. The components and their fields don't change.

- **Layout: Yoga, directly.** `yoga-layout` becomes a direct dependency, pinned at 3.2.1, loaded on demand with the UI as today.
  - A new `ui/layout.ts` builds a Yoga tree from the node tree and computes each element's box in canvas pixels, including the canvas's reference-resolution scaling and `matchHeight`.
  - It uses no renderer, so layout runs in any World, including servers and tests.
  - Text size comes from a measure function: the 2D canvas API's `measureText` with the element's font, or a fixed per-character estimate in Node, where there's no canvas.
- **Routing: the engine's, on Yoga's boxes.**
  - The 0069 rules stay as they are, in a renderer-neutral `ui/routing.ts`: UI-first pointer routing in `Input.beginFrame`, `pointerOverUI`, button `hovered`/`pressed`/`clicked`, field focus, and keys withheld from `Input.getKey*` while a field is focused.
  - Screen canvases are hit-tested against last frame's boxes, highest `sortOrder` first. World canvases use the view camera's ray (0073) against the canvas's plane.
  - Babylon GUI's own pointer handling is never attached, so the engine is the only thing deciding who gets the pointer, in play mode and in the editor.
- **Drawing: Babylon GUI** (`render/babylon/ui.ts`), loaded on demand. Its job is to draw what layout computed; it makes no layout decisions.
  - **Controls.** Each element is a control placed at its Yoga box (absolute left, top, width and height, inside a plain `Container` per canvas):
    - `UIPanel` is a `Rectangle` (background, corner radius, border, opacity).
    - `UIText` is a `TextBlock`.
    - `UIImage` is an `Image` (`fit` maps to its stretch modes).
    - `UIButton` is a `Rectangle` whose colour follows the engine's hover and pressed state.
    - `UIInputField` is a `TextBlock` with a caret and the placeholder, while typing still goes through the hidden DOM `<input>` (0069), so IME and paste keep working.
  - **Screen canvases** share one fullscreen UI texture. Each canvas is a root container with `zIndex` set to its `sortOrder`. A `FrameGraphGUITask` draws the texture onto the canvas after the game cameras' finish passes and before the editor overlay. It's never tone mapped. The UI texture's render scale follows the engine's pixel ratio, so text stays sharp.
  - **World canvases** are planes in the scene, sized to `referenceResolution × pixelSize`, with a UI texture at twice the reference resolution. They're lit like unlit sprites, depth-tested and fogged with the scene.
  - **The camera preview inset** in the editor gets the screen UI drawn into its rectangle, as on three.js.
- **Fonts.** Text uses CSS fonts. Inter is bundled as a WOFF2 file and is the default, as now. Font files in a project (`.ttf`, `.otf`, `.woff2`) load through `FontFace` and are named by a new `font` field on `UIText` and `UIInputField`. This answers 0069's open question about custom fonts.
- **The interim `Text`** draws as a `TextBlock` on the same fullscreen texture, with its outline, anchor, offset and alignment. Its separate canvas-texture pass is dropped on the Babylon backend. The component stays for existing scenes.
- **During the migration** the three.js backend keeps `UIRuntime.ts` on uikit unchanged. The new layout and routing modules are written first and the three.js runtime is moved onto them where that's cheap. When 0075 stage 10 removes three.js, `@pmndrs/uikit` goes with it.

## Alternatives considered

- **Babylon GUI end to end, with its `FlexPanel` for layout.**
  - Least glue. But `FlexPanel` is its own approximation of flexbox: there's no margin, a control's padding acts as an outer inset, and absolute positioning goes through alignment rather than `top/right/bottom/left`.
  - Existing layouts and the layout tests would change, and layout would be tied to the renderer again.
- **Our own UI renderer: Yoga, plus MSDF text and quads drawn with Babylon.**
  - Sharpest text, especially in world space up close, and fully renderer-independent.
  - But we'd own text shaping, building the MSDF atlas, clipping, and the field's caret and selection: the large project 0020 wanted to avoid.
- **Keep uikit by keeping three.js for UI only.**
  - A second WebGL canvas over the WebGPU one is in effect a DOM overlay: world-space UI is lost, and two renderers stay in the build.
- **A DOM overlay with Preact.** Rejected by 0020: no world-space UI, and post-processing and the scene don't match.

## Consequences

**Positive**
- The UI components, their fields, routing and scripting don't change. Scenes and scripts built on 0069 keep working, and the routing tests keep passing.
- Layout and routing become renderer-neutral and testable without a GPU. A later renderer change only touches the drawing layer.
- Custom fonts are ordinary font files instead of an MSDF conversion step.
- Babylon GUI shares Babylon core's version, upgrade path and frame graph, and brings controls we may want next (sliders, checkboxes, scroll viewers).
- The interim `Text` and the UI draw in one place.

**Negative / costs**
- Text is drawn with the 2D canvas API instead of MSDF. Screen text is sharp at the device's pixel ratio, but world-space text is limited to its texture's resolution and blurs up close.
- Two libraries (Yoga and Babylon GUI) instead of one, plus the glue between them, in a rewrite of most of `UIRuntime.ts`.
- Babylon GUI's download size is not measured yet. It loads only with UI, like Yoga, and is measured in the first build.
- Text measured in Node is an estimate, so tests can't check exact text widths.

## Deprecates

- `@pmndrs/uikit` and its MSDF font, removed with three.js at 0075 stage 10. The three.js UI runtime stays until then.
- The interim `Text`'s canvas-texture pass, on the Babylon backend.

## Open questions

- Keyboard and gamepad navigation between elements (0020, 0069). Babylon GUI has focusable controls that may help.
- Whether world-space text needs MSDF later, for close-up readable signs.
- A Slider and other controls 0020 lists, and themes and styles shared between elements.

## References

- `@babylonjs/gui` 9.32.0: `2D/advancedDynamicTexture`, `2D/FrameGraph/guiTask`, `2D/controls/` (`rectangle`, `textBlock`, `image`, `flexPanel`)
- `yoga-layout` 3.2.1: https://www.yogalayout.dev/
- 0069; `src/engine/ui/UIRuntime.ts`, `src/engine/ui/components.ts`, `src/engine/tests/ui.test.ts`, `src/engine/input/Input.ts`
