# 0069. Game UI components on pmndrs uikit: canvases, panels, text, images, buttons, inputs, and UI-first pointer routing

- **Status:** Accepted
- **Date:** 2026-11-04
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0010, 0017, 0020, 0050, 0051, 0056

## Context

0020 chose pmndrs uikit for in-canvas UI, but only an interim `Text` component exists: it's drawn to a canvas texture, with no layout, panels, buttons or input routing (implementation status, 0020 row). Lobby screens, scoreboards and HUDs need clickable, laid-out UI.

`@pmndrs/uikit` 1.0.77 (2026-10-13, MIT) has a vanilla three.js API: `Container`, `Text`, `Image`, `Input` and a root with Yoga flexbox layout and MSDF text. It depends on `yoga-layout` (WASM), `@preact/signals-core` (the same signals Preact uses, already in the tree through `@preact/signals`) and `@pmndrs/msdfonts` (a bundled Inter font). It needs `three >= 0.162`; we're on 0.187.

## Decision

- **Dependency:** `@pmndrs/uikit` pinned at `1.0.77`. It's imported only under `src/engine/ui/`, and loaded on demand the first time a World has a `UICanvas` (like particles and post-processing). Game code never sees it (0010).
- **Components** (`src/engine/ui/components.ts`). A UI element is a node with one UI component, and the node tree is the UI tree. Children lay out inside their parent.
  - `UICanvas` (the root): `mode` `screen | world`; `referenceResolution` (default 1280×720), scaled to the canvas height by `matchHeight` 0–1 like Unity's Canvas Scaler; `sortOrder`; and for world mode, `pixelSize` (world units per UI pixel).
  - `UIPanel`: a container. Its layout fields are Yoga's: `flexDirection`, `justifyContent`, `alignItems`, `gap`, `padding`, `margin`, `width`, `height` (pixels, `"50%"` or `"auto"`), `positionType` absolute/relative with `top/right/bottom/left`, `flexGrow`. Style fields: `backgroundColor`, `borderRadius`, `borderWidth`, `borderColor`, `opacity`, `visible`.
  - `UIText`: `text`, `fontSize`, `color`, `fontWeight`, `textAlign`, `wordBreak`, plus the panel's layout fields.
  - `UIImage`: `image` (texture asset), `fit` (cover, contain, fill), and layout fields.
  - `UIButton`: a panel that takes pointer input, with `hoverColor`, `pressedColor` and `interactable`. Its children (usually a `UIText`) are its label. Polled state: `hovered`, `pressed`, and `clicked` (true for the frame a click finished, like `Input.getMouseUp`).
  - `UIInputField`: a one-line text field: `value`, `placeholder`, `maxLength`, `focused`, and `submitted` (true for the frame Enter was pressed). Typing goes through a hidden DOM `<input>` (0020's note), so IME and paste work.
- **Rendering.** Screen canvases draw in a UI pass after the main camera, its post-processing and the interim `Text`, in `sortOrder`. They use an orthographic camera sized to the reference resolution, unaffected by tone mapping and fog. World canvases are ordinary scene objects drawn with the scene.
- **Pointer routing.** Each frame, before game scripts run, the pointer is tested against interactable UI, top `sortOrder` first. When it's over one, `Input.pointerOverUI` is true, and that frame's mouse-button presses go to the UI: `Input.getMouseDown/Up` report false for them. Keyboard input goes to a focused `UIInputField`, and `Input.getKey*` report false while one is focused.
- **Scripting.** Fields change at runtime and the backend syncs them each frame, like other components. Fields are plain values, so UI built in the editor or in code is the same thing. A script finds elements as nodes (`find("Menu/Play")`) and reads `getComponent(UIButton).clicked`.
- **Headless.** UI components register and hold data in any World. Only Worlds with a render backend build uikit objects, so servers and tests can create UI without WebGL. `clicked` stays false there. Tests can simulate a click with `button._simulateClick()` (internal).
- **Editor:** the components appear in the Inspector and the Create menu (UI > Canvas, Panel, Text, Image, Button, Input Field). There's no visual layout editing beyond the fields for now.
- **The interim `Text`** stays, unchanged, so existing scenes work. New UI uses `UIText`.

## Alternatives considered

- **A DOM overlay with Preact.** Fastest, and the editor already uses Preact, but 0020 decided UI is in-canvas, and world-space UI and post-processing wouldn't match.
- **Our own canvas-texture UI** (extending the interim `Text`). No dependency, but layout, text measuring, MSDF scaling and hit testing would be ours to build. uikit already does them.

## Consequences

**Positive**
- Menus, lobbies, HUDs and world-space panels with flexbox layout and crisp text at any resolution.
- 0020 is built as decided, behind engine components.

**Negative / costs**
- Adds yoga-layout's WASM (about 90 KB gzipped) and the Inter MSDF font, loaded only by games with UI.
- No keyboard or gamepad navigation between elements yet (0020's open question).
- The editor has no drag-to-lay-out UI view.

## Deprecates

- Nothing yet. The interim `Text` is kept, and a later record may retire it.

## Open questions

- Custom fonts. The pipeline to convert TTF to MSDF (`@zappar/msdf-generator` is in uikit's tree) is left for later; v1 uses the bundled Inter.
- Themes and styles shared between elements.

## References

- https://github.com/pmndrs/uikit (vanilla API docs: `pmndrs.github.io/uikit/docs`)
- 0020; `src/engine/render/components.ts` (`Text`), `src/engine/input/Input.ts`, `src/engine/render/RenderBackend.ts`
