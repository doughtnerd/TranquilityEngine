# 0428. The UI closes its remaining CSS, text, scrolling and tooling gaps

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0418, 0419, 0423, 0424, 0425, 0426, 0370

## Context

The UI program (0417–0427) is built. Its records and their as-built notes list what was left out. The owner asked to cover those gaps. Some were deferred by a record ("part pseudo-elements in a later record", 0424; "`backdrop-filter` is left out", 0426). Others were left as not built in as-built notes:

- **Selectors and values:** `:has()`; `em`/`rem`/viewport units; `transition-behavior`, `linear()`, shortening a reversed transition, and inheritance passing through children mid-transition.
- **Text:** `white-space` modes; `:hover`/`:pressed`, padding, margins and borders on inline runs; inline blocks (a button inside a paragraph); SVG and media inside text.
- **Scrolling:** scroll snapping, `scrollbar-gutter`, and scrolling for `*-reverse` directions and right-to-left text.
- **Tooling:** type checking inside `.svelte` files.
- **Build hygiene:** committed wasm builds embed the building checkout's absolute path.

## Decision

**We will close every gap above, following the web standards where they exist.**

- **Selectors and values (0418's cascade):**
  - `:has()`, with relative selectors, restyling when descendants change;
  - `em` (the element's font size), `rem` (the root canvas element's), and `vw`/`vh`/`vmin`/`vmax` (the canvas in UI pixels, as 0418 wave 5's `@media` uses), anywhere a length is accepted, including `calc()`;
  - `transition-behavior: allow-discrete`, and the `linear()` easing as engine curve keys;
  - CSS's shortening of a transition reversed partway (the reversing-shortening factor);
  - inherited values passing through to children while a parent's property transitions.
- **Pseudo-elements:**
  - `::before` and `::after` with `content` (strings, `attr()`, counters out of scope), generated as hosted elements the cascade styles and the UI core lays out;
  - `::placeholder` and `::selection`;
  - **form part pseudo-elements** with standard names where they exist (`::file-selector-button` doesn't apply) and the WebKit and Blink names authors already use: `::-webkit-slider-thumb`, `::-webkit-slider-runnable-track`, `::-webkit-progress-bar`/`-value`, `::-webkit-meter-*-value`, a checkbox's mark through `accent-color` plus `::checkmark`, a select's arrow through `::picker-icon`. 0424's parts become styleable through them.
- **`backdrop-filter`:** 0426's filter functions applied to what's drawn behind the element, within its box. Drawn by sampling the canvas texture under the box into an offscreen canvas, filtering it with `ctx.filter` or the fallback, then drawing it under the element's background. It costs a readback per backdrop element per redraw.
- **Text (0425's inline layout):**
  - `white-space`: `normal | nowrap | pre | pre-wrap | pre-line | break-spaces`, with `white-space-collapse`/`text-wrap-mode` as longhands;
  - runs gain `:hover`/`:active` (pointer state per run), and padding, margins and borders, laid out as inline boxes;
  - `display: inline-block` (and form controls, buttons, SVG and media inside text) lay out as atomic inline boxes on the line, with their own Yoga subtree.
- **Scrolling (0423):**
  - `scroll-snap-type`, `scroll-snap-align`, `scroll-snap-stop`, `scroll-padding` and `scroll-margin`, honoured by wheel, drag momentum, keys, `scrollTo` and navigation;
  - `scrollbar-gutter: stable [both-edges]`;
  - `*-reverse` directions and right-to-left text start and scroll from the end, as in CSS.
- **Type checking inside `.svelte`:** `svelte2tsx` (the svelte-check transform, MIT, pinned exact) turns each component into TypeScript for the editor's existing TypeScript service. Diagnostics map back to `.svelte` positions, show in the Code panel and run in Play's type check. It's an editor-only dependency; games never load it.
- **Reproducible wasm builds:** every native build passes `--remap-path-prefix` (and `CARGO_ENCODED_RUSTFLAGS` where the build script sets flags), mapping the workspace root to a fixed name. Builds from any checkout or worktree are then byte-identical, and the committed wasm is rebuilt once with it. This sits beside the pending `wasm-opt` note.
- **Out of scope still:** counters and `content` images, `::first-line`/`::first-letter`, `:has()` inside `:has()`, physical-unit lengths (`cm`, `in`), and SVG filters.
- **As built (G1, selectors and values):**
  - **`:has()`** is a compound field (`SimpleSelector.has`: lists of relative selectors, the first part carrying its leading combinator), read by the selector reader for rule data and queries alike, so games stay parser-free. Matching searches the anchor's descendants (`" "`, `>`) or later siblings and their descendants (`+`, `~`), only one level when the relative selector has one compound. Specificity adds the most specific argument's. `:has()` inside `:has()` is refused by both readers.
  - **Restyling `:has()`, cost-aware.** Only when a registered sheet uses it (`hasUse`): an element made, moved or removed, or a change to its attributes, emptiness or pseudo-class state, marks its ancestors (and with `+`/`~`, the earlier siblings of it and of each ancestor) whose tag, id and classes fit some `:has()` compound (`couldAnchorHas`). Each restyles alone in the late sync, top first, and restyles its subtree only when what it passes on (variables, inherited fields, units) changed. When a `:has()` compound isn't its selector's subject (`.card:has(.x) .title`), the anchor's parent restyles with its subtree instead. Elements made since the last restyle start no transitions from these restyles, as with structural selectors.
  - **Relative lengths** become px in the cascade after `var()` and before `calc()`, outside strings and `url()` (`resolveRelativeUnits`), so every length, shorthand, transform, shadow and `calc()` takes them, and a mixed `calc(50% + 1em)` keeps its % part for layout. `em` is the element's own font size, found before its other declarations (the winning `font-size`, else HTML's tag default, else inherited, else 16); inside `font-size` it's the parent's. `rem` is the root canvas element's: the canvas now keeps the text properties its `:root` rules set (as well as variables), and its children inherit them, as on the web (before, only `:root` variables reached them). What an element resolved against travels in its resolved map under `@units` (never a field), so keyframes and the host's played keyframes convert with it. Viewport units use the root target's `viewport`: the canvas size from the last layout, its reference resolution before one (headless Worlds); a resize restyles the tree when a sheet or any element's attributes use viewport units, and a size at or before the first layout starts no transitions.
  - **`linear()`** is parsed with CSS Easing 2's normalisation into points and becomes an engine curve of linear keys (a repeated input is a jump), with keys at 0 and 1 on the first and last segments' lines when the points start after 0 or end before 1; reversed, the points mirror. `linear(0, 1)` is plain linear.
  - **`transition-behavior`** is a longhand and a shorthand keyword (`allow-discrete`, `normal`); the shorthand resets it. A spec carries `allowDiscrete` only when set. Discrete pairs then transition, flipping half way through the eased progress; `display` to or from `none` keeps the other value throughout, in transitions and keyframes alike (CSS Display 4).
  - **Reversing shortening** follows CSS Transitions 1: each transition keeps its reversing-adjusted start value and factor; a change to that start value scales the new transition's duration (and a negative delay) by `|eased progress × old factor + 1 − old factor|`, clamped to 1.
  - **Inheritance mid-transition.** The animator tells its owner of every value it writes (`UIAnimationOwner._animatedWrite`); the host passes a written inherited field down to children whose value is inherited (and through elements without the field), skipping a child that animates it itself. Elements that only pass an inherited field on (a panel's or button's `color`, which their components lack) animate it as a *virtual* field (`UIStyledElement.virtual`): the animator holds its value and only the owner hears it, so `button:hover { color: … }` with a transition fades its label.
  - **Left out:** `em` lengths follow a transitioning `font-size` at the element's next restyle, not per frame; `@starting-style` and `transitioncancel`; `%` font sizes.

## Alternatives considered

- **Leave the gaps.** The owner asked to cover them, and authors expect most of them, especially pseudo-elements, `em`/`rem` and `white-space`.
- **One record per gap.** Each is small and built on an accepted record. One record keeps them reviewable together, with each part's as-built notes added as it lands.

## Consequences

**Positive:** the UI's CSS covers what web authors routinely reach for. Svelte components are type-checked like scripts, and native builds are reproducible.

**Negative / costs:**
- more engine API;
- a readback per `backdrop-filter` element;
- inline-block layout joins Yoga subtrees into lines;
- an editor dependency (`svelte2tsx`).

## Deprecates

Nothing.

## References

0418 (all waves and as-built notes), 0423, 0424, 0425, 0426 (as-built "not built" lists), 0419 (Compatibility target), `native/*/build.mjs`; CSS Selectors 4 (`:has()`), CSS Values 4, CSS Pseudo-Elements 4, CSS Text 4 (`white-space`), CSS Scroll Snap 1, CSS Filter Effects 2 (`backdrop-filter`).
