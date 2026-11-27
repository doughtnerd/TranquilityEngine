# 0433. UI layout moves from Yoga to Taffy, compiled to WebAssembly in `native/layout`

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** 0076 in part (Yoga as the UI core's layout engine; Babylon GUI drawing and input routing stand)
- **Related:** 0076, 0422, 0427, 0428, 0429, 0432 (the UI features layout carries), 0065 and 0424 (Rust crates compiled to committed wasm)

## Context

The UI core (`src/engine/ui/UICore.ts`, helpers in `src/engine/ui/layout.ts`, the only two files that use it) lays out
every UI element with Yoga (`yoga-layout` 3.2.1, the latest release, shipped as prebuilt wasm). The goal for game UI
since 0422 is web CSS: a Svelte component should lay out in the game as it does in a browser.

**The bug that forced the question.** In the King of Pirates sample (`samples/pirates/ui/Hud.svelte`) the bottom HUD
(batteries, hull bar) was laid out below the 720 px screen whenever the middle panel held only empty text. Yoga has a
shortcut, `measureNodeWithFixedSize` in its C++: when it measures a node that has children in fit-content (AT_MOST)
mode with an available width of 0 or less, it skips laying out the children and gives the node the whole available
height (and the same with the axes swapped). Plain Yoga with no engine code shows it: screen 1280×720, a column with
`justify-content: space-between` holding [top (h 40), row (`justify-content: center`) > column
(`align-items: center`, padding 18) > column `#lines` (`align-items: center`) > one 0×24 box, bottom (h 80)]. Yoga
makes `#lines` 684 tall and puts the bottom's top at 760; a browser gives 24 and 640. No Yoga errata flag covers it.

**Yoga isn't CSS in other ways too.** Running the conformance set below on Yoga (with CSS's initial values set where
Yoga's differ: row direction, `flex-shrink: 1`, `align-content: stretch`) it matches Chromium in 43 of 47 cases. The
four misses are the shortcut above, min/max clamping while items flex, and two cases of CSS's automatic minimum size
(`min-width: auto`: a flex item doesn't shrink below its content unless it clips), which Yoga doesn't implement.

**A stopgap is shipping separately** (branch `claude/kind-hypatia-5dhdqz`, in `UICore.ts`): (1) plain empty text
(empty after whitespace collapsing; not inputs, text areas, selects or editable text) measures 0×0, as an empty block
does in a browser; (2) a tiny minimum width and height on containers so Yoga avoids the shortcut.

0422 considered Taffy and turned it down ("Yoga is already our layout, and Taffy would add a second wasm engine for
grid"). It wouldn't be a second engine: it replaces Yoga.

## Decision

We will replace Yoga with **Taffy** (DioxusLabs, MIT), the Rust CSS layout engine whose test suite is generated from
Chrome's layouts, compiled to WebAssembly in `native/layout/` and committed, as navigation (0065) and tweening (0424)
are.

**Taffy 0.16.0** (pinned `=0.16.0`), features `std`, `taffy_tree`, `flexbox`, `grid`, `block_layout`, `content_size`.
That's flexbox, CSS grid and block layout (so `display: grid` and `display: block` are a style setting away when the UI
cascade grows them, without a rebuild), automatic minimum sizes, `box-sizing`, `direction`, per-axis overflow, aspect
ratio, absolute positioning against the containing block, gaps, and measure functions for leaves (text, replaced
elements). Left out: `calc` (see below), float layout, detailed grid info, serde, `flexbox_balance`.

**The crate.** `native/layout/` is a Cargo workspace (release profile as `native/nav`: `opt-level = 3`, LTO, one
codegen unit, `panic = "abort"`):

- `crates/layout-core`: `UiLayout`, Taffy's `TaffyTree` behind `u32` handles (reused after `remove`) with three
  setters, `set_enum(handle, prop, value)`, `set_length(handle, prop, kind, value)` (auto, px or percent) and
  `set_number(handle, prop, value)`, numeric codes listed in its `lib.rs`; `create(measured)`, `set_children`,
  `mark_dirty`, `compute(root, width, height, measure)` (a finite size is definite room, `+inf` max-content, `-inf`
  min-content), and `layout(handle, out)`, 22 floats: x, y, width, height (border box relative to the parent's border
  box), border, padding and resolved margin (top, right, bottom, left), the scrollable overflow rectangle and the
  scrollbar room. Rounding is off, as Yoga's `pointScaleFactor(0)` was. Every node starts `display: flex` and
  `position: relative` (each UI element is a containing block for its absolute children, as under Yoga).
  `cargo test -p layout-core` covers it, the Yoga repro included.
- `crates/layout-wasm`: the wasm-bindgen boundary (`LayoutTree`), pinned to wasm-bindgen 0.2.130 like the other
  crates. Only numbers cross it. A measured leaf calls the JS function passed to `compute` with
  `(handle, knownWidth, knownHeight, availableWidth, availableHeight)` (NaN for unknown), which answers through
  `setMeasured(w, h)`. Computed boxes are written to a buffer in the module's memory (`outPtr`) that the adapter reads
  through a `Float32Array` view: one call per box, no allocation in the module.
- `npm run build:layout` (`native/layout/build.mjs`) builds it with the remapped paths of 0432's reproducible builds and
  writes `src/engine/ui/taffy/wasm/` (committed), failing over its size tripwire (below).

**The adapter**, `src/engine/ui/taffy/layoutTree.ts` (internal, not public API): `loadLayoutEngine()` (once per page;
browsers fetch the wasm as a Vite asset, Node reads it from disk) and `layoutEngineLoaded()`; `LayoutTree` with
`create(measure?)`, `compute(root, width?, height?)`, `free()`; `LayoutNode` with setters that take CSS keywords and
lengths (`setFlexDirection("column")`, `setWidth("50%")`, `setMargin("left", "auto")`, `setInset`, `setGap(column,
row)`, `setOverflow(x, y)`, …), `setChildren`, `markDirty`, `free` and `layout()` (a `LayoutBox`). A
`MeasureFunction` receives `{ knownWidth, knownHeight, availableWidth, availableHeight }` with `Infinity` for
max-content room and `-Infinity` for min-content, and returns `{ width, height }`.

**`compute`'s room is CSS's, not Yoga's.** Yoga's `calculateLayout(w, h)` made an auto-sized root `w`×`h`; Taffy lays
the root out in that room as a page's root element is laid out in its viewport, so an auto-sized root fits its content.
The UI core gives each canvas root an explicit size, as it does today.

**How the UI core's features map onto Taffy** (the migration, below, does this in `UICore.ts`):

| UI core today (Yoga) | On Taffy |
| --- | --- |
| `display: flex / none`; `inline-block`/`inline-flex` atoms laid out in their own subtree (0432) | `display` flex / none; an atom's node is a root of its own in the same tree, computed with max-content room |
| A select's options in a Yoga root of their own (0428) | The same: a separate root node in the tree |
| Measured nodes (text, select, text area, inline runs, 0271/0429): `measure(entry, width)` with `Infinity` when unconstrained | A `MeasureFunction`: width `knownWidth ?? (availableWidth === -Infinity ? 0 : availableWidth)`; marked dirty when the run changes, as now |
| Text measures as its widest line | CSS's shrink-to-fit width, `min(max-content, max(min-content, room))`: wrapped text takes the whole room (the conformance set showed Chromium does; a centred wrapped paragraph is 376 px in 376 px of room, not its 375 px widest line) |
| `flexShrink` defaults by element kind; 0 for children along a scroller's main axis (0427) | Unchanged (set per node) |
| `overflow` visible / hidden / scroll (`OVERFLOW_*`) | `setOverflow`: hidden and scroll also zero the automatic minimum size, as in CSS. Scrollbar room stays 0; the gutter (0432) stays a wider border side for now |
| `direction` (`DIRECTION_INHERIT` from the canvas, 0432) | Taffy doesn't inherit: each node gets its resolved direction (`directionOf(entry)` exists) |
| Mixed `calc(50% + -12px)` resolved against last frame's parent size, with a second pass where it changed (0422 wave 5) | Unchanged at first: `TaffyTree` resolves `calc` handles to 0, so the adapter takes pixels and percentages only |
| Per-side padding, border, margin (`auto` margins), insets, min/max, basis, wrap, `align-*`, `justify-content`, gap, aspect ratio, percentages | One-to-one setters. `min-width: auto` now means the content-based minimum, as in CSS (it was 0) |
| `getComputed*` reads, content extents for scrolling (0427) | `layout()`; the overflow rectangle can replace the hand-summed extents later |
| The stopgap's empty-text 0×0 rule | Kept: that's what a browser does |
| The stopgap's tiny container minimums | Removed: Taffy has no such shortcut |

**Gaps** (none blocks the switch): Taffy's `calc` needs a custom tree (Taffy's `LayoutPartialTree::resolve_calc_value`)
rather than `TaffyTree`; a measured leaf reports no first baseline, so `align-items: baseline` aligns text by its box
bottom, as under Yoga; `direction` isn't inherited inside Taffy; grid and block are compiled in but no UI style reaches
them until the cascade gets `display: grid` and its properties (a record of its own).

**Size and performance budget.** The wasm is 369,315 bytes (124.8 KB gzip), against Yoga's 71,736 bytes (28.8 KB
gzip; Yoga ships it as base64 in a 120,919-byte JS file). `opt-level = "s"` would save 13% (320,023 bytes) at a speed
cost, which CLAUDE.md rules out. The tripwire in `build.mjs` is the first build plus 20%: 440 KB. It loads only when the first UI needs it,
as Yoga did. Timing in Node (V8, Vitest), on a tree shaped like the Pirates HUD (top bar, middle text panel, six
batteries, hull bar, a 16-row leaderboard, 120 minimap dots, 20 markers; text measured by the conformance set's word
model, so the numbers are the engines'):

| | Yoga 3.2.1 | Taffy 0.16 |
| --- | --- | --- |
| HUD, 350 nodes: build and first layout | 2.23 ms | 1.32 ms |
| HUD ×10, 3,501 nodes: build and first layout | 20.4 ms | 10.5 ms |
| One text changed, re-layout (350 / 3,501 nodes) | 0.051 / 0.070 ms | 0.081 / 0.057 ms |
| Nothing changed, re-layout | < 0.001 ms | < 0.001 ms |
| Read every box (350 / 3,501 nodes) | 0.38 / 2.38 ms | 0.088 / 0.51 ms |

**Conformance.** `src/engine/tests/layoutConformance/cases.json` holds 47 flex cases the UI core uses (both HUD
shapes, every direction, `justify-content`, `align-items`, wrapping with each `align-content`, `wrap-reverse` with
gaps, grow, shrink, basis, min/max, percentages, auto margins, borders and padding, absolute insets and static
positions, `display: none`, aspect ratio, overflow and automatic minimums, wrapping text in rows and columns, `rtl`).
`npm run conformance:layout` (`scripts/layout-conformance.mjs`, Playwright) records Chromium's boxes in
`chromium.json`; `taffyConformance.test.ts` lays each case out through the adapter and compares within 1/32 px
(Chromium's layout unit is 1/64). Taffy matches all 47; Yoga matches 43.

**Migration plan.**

1. The crate, the committed wasm, the adapter, its Vitest tests, the conformance set and the measurements.
2. With the stopgap merged in (it must reach `master` with or before this): `UICore` switches to the adapter (`loadLayoutEngine` / `layoutEngineLoaded` for
   `loadYogaOnce` / `loadedYoga`; one `LayoutTree` per core; `Entry.node` and `popup` become `LayoutNode`s;
   `applyProperties` keeps its change-only slots and calls the keyword setters; the measure mapping and shrink-to-fit
   width above; resolved `direction`; boxes read through `layout()`), the stopgap's container minimums go, the empty
   text rule stays, `yoga-layout` leaves `package.json`, and `layout.ts` drops its Yoga loader.
3. Checks: typecheck, the UI Vitest suites (`uiCore.test.ts` and the UI document tests), then the UI e2e specs
   (`ui-css.spec.ts` and the UI specs), and the Pirates HUD's bars showing while afloat.

## Alternatives considered

- **Keep Yoga with an epsilon workaround** (the stopgap's tiny minimum sizes). It hides this one shortcut, but leaves
  the other differences from CSS (no automatic minimum size, min/max while flexing) and every future one, and it
  changes the layout of every container by an epsilon.
- **Build a patched Yoga wasm with Emscripten.** Removes the shortcut, but we'd own a fork of Yoga's C++ and an
  Emscripten toolchain beside the Rust one, and Yoga still isn't CSS in the other ways.
- **Taffy through a third-party npm binding.** Not evaluated in depth: a boundary shaped for the UI core (handles,
  numeric setters, a shared box buffer, one measure entry) is under 600 lines of Rust we control, pinned and built like
  the engine's other crates, with no binding project's release cadence between us and Taffy.
- **A DOM overlay for UI.** Rejected by 0020 and 0421: UI stays in-canvas.

## Consequences

**Positive**
- Layout matches the browser in every case we've checked, including the one that hid the Pirates HUD, and in
  behaviours Yoga lacks (automatic minimum sizes).
- Grid and block layout are already in the module for when the cascade grows them.
- Faster first layouts (about 2×) and box reads (4–5×) on HUD-sized and larger trees; re-layouts stay well under
  0.1 ms.
- One more piece of the engine on the shared Rust → committed wasm path; no third-party wasm shipped as base64 JS.

**Negative / costs**
- The wasm is about 5× Yoga's (125 KB against 29 KB gzip), downloaded the first time UI shows.
- Layouts that relied on Yoga's differences change: an item whose content is wider than its share no longer shrinks
  below its content unless it clips, wrapped text takes its whole room, and an auto-sized root fits its content.
  Captures in the UI e2e specs may need updating, each checked against a browser.
- A Rust toolchain is needed to change the layout engine (the committed wasm means not to build the engine).

## Deprecates

`yoga-layout` (removed from `package.json` in migration step 2), the Yoga loader in `src/engine/ui/layout.ts`
(`loadYogaOnce`, `loadedYoga`) and the Yoga enum tables in `UICore.ts`; the stopgap's container minimum sizes.

## Open questions

- `calc()` inside Taffy: a custom tree over Taffy's low-level API (with the `calc` feature) would resolve mixed lengths
  during layout and remove the UI core's second pass. Worth it when a case needs it.
- Text baselines: layout-core could take a first baseline from the measure callback.
- `display: grid` and `display: block` in UI documents: a record of their own.
- Whether `scrollbar-gutter` should use Taffy's scrollbar room instead of widening the border.

## References

- Taffy: https://github.com/DioxusLabs/taffy (0.16.0, MIT); its tests are generated from Chrome's layouts.
- Yoga's shortcut: `measureNodeWithFixedSize` in `yoga/algorithm/CalculateLayout.cpp`.
- `native/layout/` (crate, `build.mjs`), `src/engine/ui/taffy/layoutTree.ts`, `src/engine/tests/taffyLayout.test.ts`,
  `src/engine/tests/taffyConformance.test.ts`, `src/engine/tests/layoutConformance/`, `scripts/layout-conformance.mjs`.
- `samples/pirates/ui/Hud.svelte` (the HUD the bug hid).
