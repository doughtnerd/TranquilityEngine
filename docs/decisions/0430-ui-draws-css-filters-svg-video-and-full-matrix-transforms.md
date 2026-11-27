# 0430. UI draws CSS filters, inline SVG, video and full matrix transforms with skew

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0422, 0423, 0424

## Context

0423's full-compatibility target needs four drawing features the UI core lacks:

- **CSS `filter`:** `blur`, `brightness`, `drop-shadow`… Svelte's `blur` transition uses it.
- **Inline `<svg>`:** icons, and Svelte's `draw` transition.
- **`video`** and **`audio`** elements.
- **Arbitrary `transform` lists with skew.** 0422 wave 3 refuses lists that would skew, and can't draw skew.

They share one drawing question, because Babylon GUI draws each control into a Canvas2D context.

## Decision

**Each is drawn through Babylon GUI's Canvas2D drawing, extended where a control needs to.**

- **Filters:** a `filter` property; each function is a field, so they animate (0422 wave 4).
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

- **As built:**
  - **Matrix transforms.** One field, `transformMatrix` (`matrix(a, b, c, d, e, f)` text, "" none), applied after translate, rotate and scale (CSS's individual properties, then `transform`). A list that folds still folds and clears the matrix. One that doesn't (any `skew()`/`skewX()`/`skewY()`/`matrix()`, or a rotation after an unequal scale) keeps its leading translates in the translate fields, where `%` still works, and the rest becomes the matrix. A `%` translate later in such a list is refused with a warning, since a matrix holds pixels. A matrix animates by tweening one progress float on the tween backend; the field's value is worked out from it the way CSS interpolates matrices (decompose into translation, rotation, shear and scales, mix them, recompose; the short way round). Width-4 tween slots couldn't hold a six-number decomposition. Drawing uses the full matrix only when the map skews; otherwise controls keep Babylon's rotation and scales, as in wave 3. A shared mixin (`Drawn`) overrides `_transform`; Babylon declares `_clip` private, so the mixin replaces it on each instance.
  - **Filters.** Thirteen fields, one per function plus the drop shadow's four, drawn in a fixed order (the order listed above). A function listed twice folds where the two compose (factors multiply, angles add, blurs combine as Gaussians), so Svelte's `blur`, which appends a blur to the element's own filter, works. Flat controls mean "around the subtree" is the filter set on the context while each control of the subtree draws: the UI core composes each element's chain (its own steps, then its ancestors'). So a blur blurs each drawn piece, and translucent overlapping pieces are filtered one at a time rather than flattened first. Lengths go through the filtering element's transform, as shadows do. The offscreen fallback filters each control's own drawing (`render/filterPixels.ts`). Support is detected per context (`typeof ctx.filter === "string"`).
  - **Inline SVG** is a new element, `UISvg` (an image kind, tag `Svg`), whose `markup` field holds the SVG text. The Svelte renderer keeps the `<svg>`'s descendants as nodes and writes the field whenever any of them changes. The cascade styles only the `<svg>` (its size, `color` for `currentColor`); shapes take paint from attributes and inline styles. It's rasterised at the box's size in texture pixels, again only when the text, colour or size changes, and the previous picture stays drawn until the new one loads. Shape hit-testing retargets the `<svg>`'s pointer events in the renderer: geometry plus `pointer-events`, with capture, target and bubble through the groups. `<text>` and `<use>` aren't hit. Path lengths come from `ui/svg/svgGeometry.ts`. `draw` samples its keyframes on the `<svg>`'s animator clock and writes them into the shape's style. UI documents can build `<Svg markup="…">`; they can't hold inline shapes (cheap enough to skip, with documents being retired).
  - **Media.** `video` is `UIVideo`, a subclass of `UIImage` (tag `Video`); `audio` is `UIAudio` (tag `Audio`, `display: none`). Both hold a source behind one interface, `UIMediaSource` (the `HTMLMediaElement` subset):
    - Video makes an `HTMLVideoElement` from `src` in a browser. Any media element can be handed to `media` instead, which is also how headless tests inject a fake.
    - Audio's source adapts an engine `AudioSource` that its node owns, found by its registered name, so the UI core doesn't import the audio plugin. It keeps time on the element's clock, notices the end when the sound stops by itself, reports `duration` as NaN, and maps `playbackRate` to pitch.
    - `UIMediaPlayer` (`ui/media.ts`) keeps the fields on the source every frame (`engine.UIMedia`), autoplays once, forwards media events, copies changes made on the source back into the fields, and pauses when the element is disabled.
    - The renderer puts the media API on nodes and implements Svelte's media bindings through `bind`. `<source>` children give `src`. There are no built-in `controls`.
  - **Not built:** the e2e capture and the performance check, `backdrop-filter`, SVG filters, SMIL, stylesheet rules reaching shapes, and an audio `duration`.

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

0422 wave 3's refusal of skewing transform lists (as built), once matrices land.

## References

0422 (waves 2–4), 0423, 0424; Filter Effects 1, SVG 2, HTML media elements.
