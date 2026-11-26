# 0418. The UI core grows toward web CSS in five waves: layout, paint, transforms, animation, then selectors and values

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0069, 0076, 0077, 0271, 0340, 0385, 0417, 0419, 0420

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

- **As built (wave 1):**
  - Per-side border widths are on `UIPanel` (with buttons and input fields), where borders already live, not on every element.
  - A per-side or `flexShrink` field left null takes the all-sides field or the element kind's default.
  - Per-side padding and margin take pixels only.
  - `overflow: hidden` also starts a stacking group (as a non-zero `zIndex` does), so drawing and hit order always agree.

**Wave 2: Paint (Babylon GUI).**

- `boxShadow`: one shadow with `offset-x offset-y blur colour`; `inset` and several shadows are left out. It is drawn by the element's background rectangle.
- `backgroundImage` takes `linear-gradient(angle, stops…)` and `radial-gradient(stops…)` (circle at centre) besides `url()`, drawn with Babylon GUI's gradients. Colour stops take positions in `%`.
- `borderRadius` grows four per-corner fields (`borderTopLeftRadius`…), with the shorthand taking one to four values.
- `textShadow` on `Text`: one shadow, drawn as the TextBlock's shadow.

- **As built (wave 2):**
  - A shadow is four typed fields, colour (null: none), offset x and y, and blur, so the Inspector edits them and wave 4 can animate them. `box-shadow`/`text-shadow` expand to them.
  - Corner fields default to -1, meaning they take `borderRadius`.
  - `backgroundImage` is a string field holding the CSS value. A gradient replaces `backgroundColor`, so hover colours don't show on a gradient button.
  - Babylon GUI 9.32's declarations swap the comments on two corners: its drawing code draws `cornerRadiusZ` bottom-right and `W` bottom-left, and the mapping follows the drawing code.

**Wave 3: Transforms (draw-time, as in CSS).**

- `transform` supports `translate(x, y)` (px or % of the element's box), `scale(s | sx, sy)` and `rotate(deg)`, composed left to right. It becomes the fields `translateX/Y`, `scaleX/Y` and `rotate`, set from the shorthand or individually (`translate`, `scale`, `rotate` properties).
- `transformOrigin` defaults to `50% 50%`.
- **Layout ignores transforms**, as on the web: siblings don't move.
- Hit-testing inverts the element's transform chain, so a rotated button clicks where it's drawn. The editor's outline and handles use the transformed corners. Navigation (0340) uses the transformed boxes' centres.

- **As built (wave 3):**
  - The fields apply as CSS applies the individual `translate`, `rotate` and `scale` properties: scale, then rotate, about the origin, then translate. A `transform` list is composed left to right and folded into them. A list that can't fold is refused with a warning: a rotation after an unequal scale (a skew), or a `%` translate after a rotation that isn't a half turn.
  - `transform` and the individual properties write the same fields, so the later declaration wins per field. CSS would apply both.
  - The `translate` attribute stays HTML's localisation marker (0356). Markup uses `transform="translate(…)"` or `translate-x`/`translate-y`; stylesheets take the `translate` property.
  - One pure module, `ui/transform2d.ts`, computes every transform. The UI core composes each element's with its ancestors' after layout and publishes it with the laid-out element. Drawing, hit-testing, picking, the editor and navigation all read that result.
  - Drawing keeps Babylon GUI controls flat, so the core's draw order and stacking stay as they are. Each control gets its transform relative to the control it's drawn in (its clipper's clip container, else the canvas root): placed at its transformed top-left corner, turned and scaled about that corner. Clip containers move with their clippers, so clipping follows the drawn shape. A rotation inside an unequal scale (a skew) can't be shown with one control's rotation and scales, so it's drawn without the skew and warned once. Hit-testing still uses the exact transform.
  - Shadows turn with the element: the offset goes through the transform's linear part, and the blur scales by its area factor. Canvas2D shadows ignore the context transform, so the drawing layer sets this itself.
  - Clips are a chain of (padding box, clipper's inverse transform) steps, merged into one rectangle while untransformed. `UILaidOutElement.clip` stays the layout-space overlap, and the new `bounds` field gives the drawn, clipped axis-aligned box, which navigation searches.
  - Editor handles: resizing works in the element's drawn frame. On an element with a transform of its own, the west and north handles change only the size, because `left`/`top` are in its parent's frame. Moving uses the parent's frame, from where layout put the box (`UICorners.layoutPoints`). The editor's clip outline leaves out a clip that is turned relative to the element.
  - The hidden DOM `<input>` that takes typing stays off-screen, as before wave 3. An IME's candidate window doesn't follow a transformed field.

**Wave 4: Animation (on the engine's tween core, 0420, on unscaled time).**

- **Properties:** `transition` (property list or `all`, duration, timing function, delay) and `@keyframes` with `animation` (name, duration, timing function, delay, iteration count or `infinite`, direction, fill mode, play state).
  - These are cascade declarations, not component fields: a class or pseudo-class change starts them.
  - Scripts drive them by changing classes or by setting the `animation-*` attributes.
- **Animatable values:** numbers, lengths (px with px, % with %; a mixed pair jumps at the midpoint, as CSS does for non-interpolable values), colours (in linear RGB), the transform fields and opacity.
- **Timing functions:** `linear`, `ease`, `ease-in`, `ease-out`, `ease-in-out`, `cubic-bezier()` and `steps()`, as engine curves (Bezier keys, step keys) on the shared tween crate (0420). Transitions and keyframes run on the animation core's tween table when the animation plugin is on, and on the small tween module when it isn't.
- **When it runs:** animation runs in the UI document sync on the World's unscaled clock, so UI still animates while the game is paused with `Time.timeScale = 0`. A script writing a field directly overrides that field's running transition, as an inline style would.
- **Events:** `transitionend` and `animationend` through `element.on` (on top of 0309's interaction log), one frame after they finish, like other UI events.

- **As built (wave 4):**
  - **Tweens, not sequences.** Each transition, and each field of a keyframe animation, is one tween at a time on the backend (0420): the segment it's in. A segment's tween is created on the frame it starts, with a delay placing its start exactly (`start − last frame's time`). Sequences would have needed one table slot per animation, and both tables hold 256 sequences against 4,096 tweens.
  - **The animator keeps time.** Each run's clock (unscaled seconds since it started), delay, iterations, direction (a backward segment eases through the reversed curve `1 − f(1 − x)`), fill mode, play state and end are decided in TypeScript; the backend only eases values. A segment entered part-way (a negative delay, a resumed animation, the backend still loading, a fractional last iteration) is evaluated from the same engine curve in TypeScript (`evalCurve`) until the next segment, which tweens again.
  - **Curves.** `cubic-bezier()` and its keywords are exactly one Bézier segment of an engine curve (0346): handles at (x1, y1) and (x2, y2). `steps()` is step keys. Each distinct function and direction loads once per backend. Linear uses the tween's own easing.
  - **Where it runs.** `engine.UIAnimation`, a late-update system after `engine.UIDocumentSync` and `engine.UIHostSync`, so a restyle's transition starts in its frame, and after `lateUpdate()` scripts, outside the animation plugin's evaluate-to-apply span, as the core-backed backend's update needs (0420 as built). One animator and one backend per World; it closes when the World's last animating document or tree goes.
  - **Cascade data.** The declarations resolve under two keys of the resolved map that are never fields (`@transition`, `@animation`), in the field order (rules by specificity, then attributes, then an inline style). `@keyframes` are plain data on `UIStylesheet`, so Svelte styles compiled to rule data carry them. A missing `from`/`to` keyframe takes the element's value when the animation starts.
  - **Values.** A transition only runs between values that interpolate: numbers, px with px, % with %, colours, and a mixed pair of lengths (which jumps half way, as above). Other fields change at once (CSS's `transition-behavior: normal`); between keyframes they jump half way. A side left null and a corner left at -1 animate from their all-sides value; a none shadow or background colour animates as the other colour fully transparent.
  - **Scripts.** A script's write is noticed as a field whose value isn't what the animator last wrote. It stops that field's transition (no `transitionend`, as CSS's cancel) or that field of an animation for the rest of the run.
  - **Events** also reach the `UIEvents` buffer (the open question below), with `propertyName`, `animationName` and `elapsedTime`. `animationstart` and `animationiteration` were cheap, so they're there. Hosted elements get them through `UIHostElement.on`; Svelte's `ontransitionend` attribute needs the renderer's event list (0419), not yet.
  - **Value sources:** the Inspector names a running transition or animation over the origin of the value it animates to.
  - **Left out:** a running animation picks up new durations or timing functions only when it starts again (its play state applies at once); inherited values reach children at the end of a parent's transition, not in between; CSS's shortening of a transition reversed half way; `transition-behavior`, `animation-composition` and `linear()`.
  - **Measured** (headless, no drawing; medians): 500 elements each transitioning a colour and a number cost about 1 ms a frame; the frame starting all 1,000 transitions about 17 ms against 9 ms for the same class change without transitions.

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

- **As built (wave 5):**
  - **Rule data, games parser-free.** The selectors are new optional fields of a compound (`not`, `nth`, `attributes`, `empty`, `root`) and two combinators (`+`, `~`); a rule inside `@media` carries its query lists (`StyleRule.media`, one list per nesting level, every level must match). Data compiled before wave 5 still matches (`Selector.root` alone still means `:root`). Media queries and math are read by hand-written readers (`document/mediaQuery.ts`, `document/cssMath.ts`), so the Svelte renderer's `matchMedia` works in games without css-tree. The stylesheet parser hands attribute selectors and the new pseudo-classes to the query reader (`selectorQuery.ts`), so rule data and queries read them alike.
  - Beyond the list above: `:only-child`, `:first-of-type`, `:last-of-type`, `:only-of-type`, `:nth-of-type()`, `:nth-last-of-type()`, `:nth-child(an+b of S)`, `[a|=v]`, the `i` flag, `:empty`, and `:root` as an ordinary pseudo-class (the tree's root, in compounds and complex selectors; it used to only declare variables).
  - **Positions count child elements**, not text: the labels a host makes from text beside elements don't count, and they make their parent non-empty. A target lists its children, text and attributes lazily (`StyleTarget.children`, `content`, `attributes`), so they're always current. Attribute selectors match what the author wrote: markup attributes (a bound one by its `{name}` text), and for Svelte elements every attribute the component set, HTML-only, `data-*` and `aria-*` ones included (the renderer passes them beside the field attributes; this is the one renderer change).
  - **Restyling.** With structural selectors or sibling combinators in the styles, adding, removing or moving an element restyles its parent's subtree, and a class or attribute change restyles the element's parent's subtree (its later siblings may match differently). Elements made since the last late sync, and a tree's first canvas size, restyle as first styles, so nothing transitions from a sibling or a size that only just arrived. UI documents restyle the whole tree once after building when they need structure or `@media`.
  - **`calc()`, `min()`, `max()`, `clamp()`** are worked out after `var()` substitution, in every declaration and attribute (shorthands, transforms, transitions and keyframes included). A length mixing % and px is kept as `calc(<p>% + <q>px)` in length fields (`width`, `height`, `top`…, the min/max sizes, `flex-basis`); the UI core resolves it against the parent's content box from the last layout (`flex-basis` along the parent's direction) and, where that box changed, applies it and lays the canvas out once more in the same frame. A chain of nested mixed lengths settles over frames. Transforms and paint take px-only results. A mixed pair doesn't transition (it jumps half way, as wave 4's mixed lengths do).
  - **`@media`** reads the canvas from the last layout (`UILaidOutCanvas` size, UI pixels after the scaler), so a resize re-matches the frame after; before the first layout only size-free queries match. Features: `width`, `height`, `aspect-ratio` (with `min-`/`max-` and range forms) and `orientation`; `and`/`or`/`not`, nesting and media types (`all` and `screen` match). Unknown features are unknown and never match (Media Queries 4). `@keyframes` inside `@media` is refused.
  - **Svelte (the coordinator's units ruling).** The renderer's window target reports the canvas in UI pixels: `innerWidth`/`innerHeight` (and `outer*`) are the first view's canvas after the scaler, `devicePixelRatio` is device pixels per UI pixel, `resize` follows that size, and `matchMedia` evaluates against it (a `UIMediaQueryList` with `change` events). `svelte/reactivity`'s `MediaQuery` calls the global `window.matchMedia`, so UI code gets an engine module for `svelte/reactivity` (Svelte's, with `MediaQuery` asking the renderer's window) in the editor's runtime modules, in game UI bundles and in Vitest; no patch change. `svelte/reactivity/window` still reads the global window.
  - **Measured:** the lazily loaded cascade grew by the media reader (2.2 KB gzip) and the math reader (1.5 KB); `svelte/reactivity`'s wrapper is 0.3 KB in bundles that import it. Structural matching scans siblings (an `:nth-child` over n rows costs O(n) per row's restyle).

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
- Mostly wiring onto Yoga, Babylon GUI and css-tree. No new dependency: animation runs on the engine's tween core (0420).
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
- Yoga 3.2.1 node API; Babylon GUI 9.32 `Control` (`shadow*`, `gradient`, `rotation`, `scaleX/Y`, `transformCenterX/Y`, `zIndex`, `clipChildren`) and `Rectangle` (`cornerRadiusX..W`)
