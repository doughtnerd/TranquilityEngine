# 0020. In-canvas UI built on pmndrs uikit

- **Status:** Accepted; partly superseded by 0076 (uikit replaced by Yoga and Babylon GUI; UI stays in-canvas)
- **Date:** 2026-10-31
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0004, 0022

## Context

Games need menus, HUDs and world-space UI (health bars, signs, VR-style panels). The two broad approaches are an HTML/CSS overlay on top of the canvas, or UI rendered by three.js inside the canvas. The legacy engine has no UI.

Owner decision: **all game UI is in-canvas**.

In-canvas options: pmndrs **uikit** (flexbox layout via Yoga, MSDF text, actively maintained, with a vanilla three.js API alongside its React Three Fiber bindings), **three-mesh-ui** (older and less active, more limited layout), or a custom system.

## Decision

- Game UI renders inside the three.js canvas using **pmndrs uikit**, wrapped as engine components (`UICanvas`, `Panel`, `Text`, `Image`, `Button`, `Slider`, …). Game code never imports uikit directly.
- **Screen-space UI**: a `UICanvas` node in screen mode is drawn by a dedicated orthographic UI pass after the scene render, scaled to the window with a reference resolution.
- **World-space UI**: a `UICanvas` in world mode is a normal node placed in the scene.
- **Input routing**: pointer events are raycast against UI first; events consumed by UI don't reach game input (`Input.getMouseDown` etc. report the UI's capture state).
- Fonts are assets converted to MSDF; the asset pipeline (0013) handles them.
- The game UI decision doesn't decide the **editor's** UI (0022).

## Alternatives considered

- **DOM overlay (+ in-canvas later).** Fastest to build, best text and accessibility, but two coordinate systems, can't be post-processed, and world-space UI needs a separate solution.
- **three-mesh-ui.** Less active; weaker layout.
- **Custom.** Text layout and rendering alone is a large project.

## Consequences

**Positive**
- One rendering path for all UI; works in world space and with post-processing.
- Flexbox layout is familiar to web developers.

**Negative / costs**
- Accessibility (screen readers, OS text input, IME) is harder than with DOM. Text input fields need a hidden DOM input for typing.
- Depends on uikit's vanilla three.js API, which is less used than its React bindings; a spike should confirm it covers the engine's needs before building on it.
- MSDF font generation becomes part of the asset pipeline.

## Deprecates

- Nothing (the legacy engine has no UI).

## Open questions

- Theming/styling model (component props vs a stylesheet-like system).
- Gamepad/keyboard navigation between UI elements.

## References

- https://github.com/pmndrs/uikit
