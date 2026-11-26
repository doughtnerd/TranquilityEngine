# 0418. The UI core grows toward web CSS in five waves: layout, paint, transforms, animation, then selectors and values

- **Status:** Proposed
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0069, 0076, 0077, 0271, 0340, 0385, 0417

## Context

0417 made UI documents (markup, stylesheets, scripts) the only way to build game UI. 0077 kept the CSS subset small on purpose: it left out media queries, animations and transitions, `!important` and attribute selectors, and said they "can be added later without breaking anything".

The Svelte spike (`spikes/svelte-ui/README.md`) compared the UI core with what people writing web-style UI expect. Rendering Svelte into the UI core works. What's missing is UI core features, and those gaps hurt `.ui.xml` the same way. Missing today:

- **Layout:** padding, margin and border are one number each (no per side); no min/max sizes, `flex-wrap`, `align-self`, `align-content`, `flex-basis`, `aspect-ratio`, `overflow` or `z-index`. Only `flex-grow` is a field, and `flex-shrink` comes from the element kind.
- **Paint:** no shadows, no gradients, one corner radius.
- **Transforms:** none.
- **Animation:** no `transition`, `@keyframes` or `animation`.
- **Selectors and values:** no `:is`/`:where`/`:not`, structural pseudo-classes, attribute selectors, sibling combinators, `calc()` or `@media`.

The layers underneath already have most of this. Yoga 3.2.1 has per-side edges, min/max, wrap, `align-self`/`align-content`, basis, aspect ratio and overflow. Babylon GUI 9.32 has `shadowBlur`/`shadowOffsetX/Y`/`shadowColor`, `LinearGradient`/`RadialGradient` (`Control.gradient`), per-corner radii (`cornerRadiusX..W`), `rotation`, `scaleX/Y`, `transformCenterX/Y`, `zIndex` and `clipChildren`. css-tree 3.2.1, which we already ship, parses all the selectors, `calc()`, `@media` and `@keyframes`. So most of the work is wiring and semantics, not new engines.

## Decision

We will grow the UI core toward web CSS in five waves. Each wave is shippable alone and adds an implementation-status row. Rules that hold across all waves:

- **Properties stay component fields** (0077), in kebab-case, settable by attribute, rule or script. The exception is animation (wave 4), whose declarations are cascade data, not fields.
- **CSS shorthands** (`padding: 4px 8px`, `border: 2px solid #fff`, `flex: 1 1 0`) expand to their longhand fields in the cascade. Attributes take the same shorthands.
- **Layout properties go to Yoga, paint properties to Babylon GUI**, through the existing element-kind table (0271) and the UI core's sync.
- **Hit-testing, picking, navigation (0340) and the editor's outline and handles** follow every change that moves or clips what's drawn (`overflow`, `z-index`, transforms).
- **Headless Worlds** hold and cascade all new fields. Only drawing needs a renderer.

**Wave 1: Layout (Yoga).** New `UIElement` fields:

- `paddingTop/Right/Bottom/Left`, `marginTop/Right/Bottom/Left` and `borderTopWidth/…`. The existing `padding`, `margin` and `borderWidth` become CSS shorthands, and the old fields stay as "all sides" values so saved data and scripts keep working. Per-side borders draw as one border while the sides are equal; unequal sides draw each side as an edge rectangle.
- `minWidth`, `maxWidth`, `minHeight`, `maxHeight`: `UILength`.
- `flexWrap` (`nowrap | wrap | wrap-reverse`), `alignSelf`, `alignContent`, `flexShrink` (default from the element kind, as today), `flexBasis` (`UILength`), `aspectRatio`.
- `overflow` (`visible | hidden`). `hidden` clips drawing (`clipChildren`) and hit-testing to the padding box. `scroll` (a scroll offset, wheel, drag and navigation scrolling into view) gets its own record.
- `zIndex` (number): draw and hit-test order among siblings, then document order, as in a CSS stacking context per element with a non-zero `zIndex`.

**Wave 2: Paint (Babylon GUI).**

- `boxShadow`: one shadow with `offset-x offset-y blur colour`; `inset` and several shadows are left out. It is drawn by the element's background rectangle.
- `backgroundImage` takes `linear-gradient(angle, stops…)` and `radial-gradient(stops…)` (circle at centre) besides `url()`, drawn with Babylon GUI's gradients. Colour stops take positions in `%`.
- `borderRadius` grows four per-corner fields (`borderTopLeftRadius`…), with the shorthand taking one to four values.
- `textShadow` on `Text`: one shadow, drawn as the TextBlock's shadow.

**Wave 3: Transforms (draw-time, as in CSS).**

- `transform` supports `translate(x, y)` (px or % of the element's box), `scale(s | sx, sy)` and `rotate(deg)`, composed left to right. It becomes the fields `translateX/Y`, `scaleX/Y` and `rotate`, set from the shorthand or individually (`translate`, `scale`, `rotate` properties).
- `transformOrigin` defaults to `50% 50%`.
- **Layout ignores transforms**, as on the web: siblings don't move.
- Hit-testing inverts the element's transform chain, so a rotated button clicks where it's drawn. The editor's outline and handles use the transformed corners. Navigation (0340) uses the transformed boxes' centres.

**Wave 4: Animation (the UI core's own tweening, on unscaled time).**

- **Properties:** `transition` (property list or `all`, duration, timing function, delay) and `@keyframes` with `animation` (name, duration, timing function, delay, iteration count or `infinite`, direction, fill mode, play state).
  - These are cascade declarations, not component fields: a class or pseudo-class change starts them.
  - Scripts drive them by changing classes or by setting the `animation-*` attributes.
- **Animatable values:** numbers, lengths (px with px, % with %; a mixed pair jumps at the midpoint, as CSS does for non-interpolable values), colours (in linear RGB), the transform fields and opacity.
- **Timing functions:** `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `cubic-bezier()` and `steps()`, using `bezier-easing` 3.2.0 (MIT, about 1 KB) pinned exact.
- **When it runs:** animation runs in the UI document sync on the World's unscaled clock, so UI still animates while the game is paused with `Time.timeScale = 0`. A script writing a field directly overrides that field's running transition, as an inline style would.
- **Events:** `transitionend` and `animationend` through `element.on` (on top of 0309's interaction log), one frame after they finish, like other UI events.

**Wave 5: Selectors and values.**

- **Selectors:**
  - `:is()`, `:where()` (zero specificity), `:not()`;
  - `:first-child`, `:last-child`, `:only-child`, `:nth-child(an+b)`, `:nth-last-child()`;
  - attribute selectors `[a]`, `[a=v]`, `[a~=v]`, `[a^=v]`, `[a$=v]`, `[a*=v]`, matched against the element's markup attributes;
  - the sibling combinators `+` and `~`.
  - Tag selectors become case-insensitive, so `panel` matches `<Panel>`. Svelte and other lowercase authoring need that.
- **`calc()`** of lengths and numbers: `+ - * /`, mixing px and %. px-only expressions resolve in the cascade. Mixed px and % resolve at layout against the containing box: Yoga takes px or %, so the UI core computes the value from last frame's parent size and relayouts once when it changes.
- **`@media`** on the canvas, not the browser window: `width`, `height`, `min-/max-` of each, `orientation` and `aspect-ratio`, in reference pixels after the canvas scaler. A rule set is re-matched when the canvas size changes.
- **`!important`** stays out (0077); specificity and `:where()` cover the cases it's used for.

**Out of scope here, each its own record when needed:** scrolling containers, `position: sticky`/`fixed`, CSS grid, filters (`blur`, `drop-shadow`), masks, several shadows, 3D transforms, pseudo-elements (`::before`/`::after`), web fonts beyond the font assets we have, and an external tree host for a Svelte plugin (the spike's follow-up, which amends 0417).

**Order and verification.**

- Waves run 1 → 5. Wave 1 and wave 2 can run in parallel: different files, apart from the cascade table.
- Each wave adds to the UI guide (`docs/wiki/guide/ui.md`), the inspector's value sources (where a value came from: a shorthand, a transition, a keyframe) and a browser capture of a test document in `tests/e2e` (one per wave).
- Performance check per wave: the Pirates HUD and the control-mapper screen must not lose frame time beyond noise. A shadow or a gradient redraws its Canvas2D region, so animating them costs more than animating a transform. The guide says so.

## Alternatives considered

- **A DOM overlay for UI that needs web CSS.** It gets everything at once, but 0020 and 0417 keep UI in-canvas: world-space UI, post-processing, one look on every platform.
- **Port a CSS engine** (for example Taffy, a layout-only Rust crate). Yoga is already our layout, and Taffy would add a second wasm engine for grid, which is out of scope here. Selectors and the cascade are a few hundred lines on css-tree, which we already ship.
- **Animation through the engine's animation system** (clips and curves). It's built for nodes and skeletons, not CSS timing semantics, and tying stylesheet transitions to clip assets would make simple hover fades heavy to author. A script API (`element.animate(...)`, like the Web Animations API) could come later over the same tweening.
- **Everything at once.** Five waves let each be checked and shipped, and keep the cost of each visible.

## Consequences

**Positive**
- `.ui.xml` and any later Svelte layer get the same, much larger CSS: wrapping layouts, min/max sizes, clipping, layering, shadows, gradients, transforms and animated states.
- Mostly wiring onto Yoga, Babylon GUI and css-tree. One new dependency, `bezier-easing`, at about 1 KB.
- A step toward the Gameface-like path the spike describes, without leaving the canvas.

**Negative / costs**
- More engine API to keep stable: about 40 new fields and the CSS rules behind them.
- Transforms and `overflow` touch hit-testing, picking, navigation and the editor's handles, the riskiest part.
- Babylon GUI draws through Canvas2D, so shadows, gradients and animated paint cost CPU on large screens. A GPU-batched UI renderer stays a later option (0076's drawing is replaceable), measured first.
- `calc()` mixing px and % costs a second layout pass when a parent's size changes.

## Deprecates

Nothing. `padding`, `margin`, `borderWidth` and `borderRadius` keep working as "all sides" values; their per-side fields and shorthands are added beside them.

## Open questions

- Whether `transitionend`/`animationend` should also reach systems through the `UIEvents` buffer, or only handlers.
- Scrolling containers (wave 1 stops at `overflow: hidden`).
- A script animation API (`element.animate`) on the wave 4 tweening.

## References

- `spikes/svelte-ui/README.md` (the gap list), 0077 §2 (the CSS subset), 0076 (Yoga and Babylon GUI), 0271 (text runs), 0340 (navigation), 0385 (raycast targets)
- `src/engine/ui/components.ts`, `src/engine/ui/UICore.ts`, `src/engine/ui/document/stylesheet.ts`, `src/engine/render/babylon/ui.ts`
- Yoga 3.2.1 node API; Babylon GUI 9.32 `Control` (`shadow*`, `gradient`, `rotation`, `scaleX/Y`, `transformCenterX/Y`, `zIndex`, `clipChildren`) and `Rectangle` (`cornerRadiusX..W`); `bezier-easing` 3.2.0
