# 0426. UI draws CSS filters, inline SVG, video and full matrix transforms with skew

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0418, 0419, 0420

## Context

0419's full-compatibility target needs four drawing features the UI core lacks:

- **CSS `filter`:** `blur`, `brightness`, `drop-shadow`… Svelte's `blur` transition uses it.
- **Inline `<svg>`:** icons, and Svelte's `draw` transition.
- **`video`** and **`audio`** elements.
- **Arbitrary `transform` lists with skew.** 0418 wave 3 refuses lists that would skew, and can't draw skew.

They share one drawing question, because Babylon GUI draws each control into a Canvas2D context.

## Decision

**Each is drawn through Babylon GUI's Canvas2D drawing, extended where a control needs to.**

- **Filters:** a `filter` property; each function is a field, so they animate (0418 wave 4).
  - The functions: `blur()`, `brightness()`, `contrast()`, `grayscale()`, `hue-rotate()`, `invert()`, `opacity()`, `saturate()`, `sepia()` and `drop-shadow()`.
  - Drawn by setting the context's `filter` around the element's subtree, where the browser supports `CanvasRenderingContext2D.filter`.
  - Where it doesn't, the subtree is drawn to an offscreen canvas and filtered there, with `blur` and `drop-shadow` approximated by box blurs.
  - `backdrop-filter` is left out.
- **Inline SVG:**
  - `svg` and its shape elements (`path`, `rect`, `circle`, `ellipse`, `line`, `polyline`, `polygon`, `g`, `text`, `use`, `defs`, gradients) are a subtree the renderer keeps as an SVG document;
  - it's drawn by serialising the subtree to an SVG image and drawing that image, re-serialised only when an attribute changes;
  - hit-testing uses the `svg` element's box, plus shape geometry for `pointer-events` on shapes;
  - `getTotalLength()` on paths (for `draw`) comes from a path-length routine in the UI core;
  - SMIL animation is left out.
- **Video and audio:**
  - `video` is an image element whose source is an `HTMLVideoElement`, drawn each frame while playing;
  - `audio` maps to the engine's audio plugin through an audio source the element owns;
  - both expose the media API (`play`, `pause`, `currentTime`, `duration`, `paused`, `volume`, `muted`, `loop`) and Svelte's media bindings through the `bind` hook.
- **Matrix transforms:**
  - the transform fields gain a full 2D matrix (`matrix(a, b, c, d, e, f)`, `skew()`, `skewX()`, `skewY()`), held when a list doesn't fold into translate, rotate and scale;
  - wave 3's refusal is lifted;
  - drawing applies the full matrix by overriding a control's transform (`_transform` with the element's `Matrix2D`), so skew draws as it hits.

## Alternatives considered

- **Render the UI with the GPU instead of Canvas2D** for filters and skew. It's a larger change (0076's drawing replaced), worth it only if Canvas2D's cost shows up in profiles.
- **SVG drawn natively as UI shapes.** A second vector renderer, when the browser already rasterises SVG.

## Consequences

**Positive:** filters, SVG icons, `draw`/`blur` transitions, video and skew all work, on the existing drawing.

**Negative / costs:**
- filters on browsers without `ctx.filter` cost an offscreen pass;
- an SVG change re-rasterises its image;
- overriding a Babylon control's transform depends on a protected member, so it's checked when Babylon is upgraded.

## Deprecates

0418 wave 3's refusal of skewing transform lists (as built), once matrices land.

## References

0418 (waves 2–4), 0419, 0420; Filter Effects 1, SVG 2, HTML media elements.
