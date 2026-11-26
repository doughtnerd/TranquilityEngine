# 0423. UI elements scroll with `overflow: auto | scroll`, in the UI core, by wheel, drag, touch, keyboard and navigation

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0340, 0418, 0419, 0422

## Context

0418 wave 1 stopped at `overflow: hidden` and left scrolling to its own record. Lists, logs, settings pages and Svelte code (`scrollIntoView`, `scrollTop`, `bind:scrollY`-style bindings) need scrolling containers.

Babylon GUI has a `ScrollViewer`, but it does its own layout and styling, apart from Yoga and the cascade.

## Decision

**Scrolling is built in the UI core on wave 1's clipping.**

- **Fields and properties:**
  - `overflow` gains `auto` and `scroll`, with `overflow-x`/`overflow-y` as longhands;
  - fields `scrollX` and `scrollY` (UI px), clamped to the content's extent beyond the padding box, writable by scripts;
  - `scroll-behavior: smooth` (on the tween backend, 0420);
  - `overscroll-behavior` (`auto | contain | none`).
- **Layout:** the content lays out unconstrained along a scrolling axis. Its extent is the union of the children's margin boxes.
- **Drawing and hits:** children draw offset by the scroll, inside the clip, and hit-testing, picking, navigation and the editor's outline include the offset.
- **Input, as default actions** (0422), so handlers can prevent them:
  - the wheel scrolls the innermost scrollable element under the pointer that can still move, then its ancestors (chaining, unless `overscroll-behavior` stops it);
  - a touch or pen drag scrolls with momentum (the mouse doesn't drag-scroll);
  - PageUp/PageDown, Home/End and arrow keys scroll a focused scroller;
  - navigation (0340) scrolls a newly focused element into view.
- **Scrollbars:** drawn as UI elements on the scrollbar track, styled through `scrollbar-color` and `scrollbar-width` (`auto | thin | none`), shown for `scroll` always and for `auto` when content overflows. They're draggable.
- **Script API and Svelte:**
  - `scrollTo`, `scrollBy`, `scrollIntoView({ block, inline, behavior })`;
  - `scrollWidth`/`scrollHeight`/`clientWidth`/`clientHeight`;
  - a `scroll` event (not bubbling, as in the DOM; `scrollend` too);
  - on documents' elements and on renderer nodes (the Element subset, 0419).

**As built (2026-11-26):**

- **Fields:** `overflow` (the `overflow` shorthand: one value is the field, two set `overflowX`/`overflowY`; CSS's `clip` is `hidden`), `overflowX`/`overflowY` (null takes `overflow`; `visible` beside a clipping axis computes to `auto`, as in CSS), `scrollX`/`scrollY`, `scrollBehavior`, `overscrollBehavior` (one value for both axes), `scrollbarWidth`, and `scrollbarThumbColor`/`scrollbarTrackColor` (the `scrollbar-color` shorthand; `auto` clears both). A `hidden` axis scrolls by script only.
- **Layout:** "unconstrained along a scrolling axis" is done by giving children of a scroller whose main axis scrolls a default `flexShrink` of 0 (an explicit `flexShrink` is kept) and Yoga's `OVERFLOW_SCROLL`. Text in a horizontally scrolling row is still measured against the scroller's width (Yoga has no max-content basis), so it wraps there. The extent ignores children's transforms; `*-reverse` directions and right-to-left text scroll from the top-left.
- **Clamping** happens at the routing core's layout, which writes the clamped offsets back to the fields (a passive core, the editor's preview inset, reads them without writing).
- **A panel the player scrolls is a raycast target** over its whole box (0385's graphic test), so the wheel and drags reach it between its children.
- **Scrollbars** are drawn over the content inside the padding box (no gutter: `clientWidth` is the padding box), 10 or 6 UI pixels, a thumb at least 18 long; the drawing layer draws a track and a thumb per bar where the scroller is drawn (its transform), above its clip; hit-testing meets them before the scroller's content. A press on the track pages by 87.5% of the padding box.
- **The wheel** picks a scroller per axis, scrolls at once (no browser-style easing), and Shift turns a vertical wheel sideways. When a UI scroller takes it, the game's wheel reads zero that frame (`InputClaim.wheel`, internal; `Input.mouseScrollDelta`).
- **Touch and pen drags** become scrolls past 10 CSS pixels, on the innermost scroller that can move the drag's main way; the press gets `pointercancel` and doesn't click. Momentum: the last tenth of a second's speed, decaying by e^(−3.5 t), ending below 20 UI pixels a second or at an end; a press in the scroller stops it.
- **Keys:** with something focused, Page Up/Down and Home/End scroll the scroller it's in (Home/End not while a field types); the arrows stay navigation's. With nothing focused, a press in a scroller makes it the keys' target and the arrows scroll it too. Arrow steps 40 UI pixels.
- **Smooth scrolling** (`scroll-behavior: smooth`, `behavior: "smooth"`) eases in the UI core with CSS's `ease` curve over 0.2–0.5 s (longer for further), on the unscaled clock, not as tween backend tweens: a scroll's target moves with every wheel tick and key repeat, and per-element retargeting each frame suits a TS curve better than the backend's 256-sequence budget (0418 wave 4 notes). A script writing the field stops it. Navigation scrolls its focus into view `nearest`, smoothly where `scroll-behavior` says.
- **Events:** `scroll` and `scrollend` are recorded at the routing core's layout and dispatched with the next frame's events (the frame after the change); `scrollend` when the offsets didn't change, no gesture holds the scroller and nothing animates it.
- **Navigation** searches each element's `reach` (its drawn bounds cut only by clips that don't scroll), so rows scrolled out of view are found.
- **Not built:** element size and scroll bindings (Svelte has none for scroll offsets on elements), the window's `scrollX`/`scrollY` (still 0: the page doesn't scroll), scroll snapping, `scrollbar-gutter`.

## Alternatives considered

- **Babylon GUI's `ScrollViewer`.** It wraps content in its own layout and styling, and wouldn't match Yoga, the cascade, hit-testing or navigation.

## Consequences

**Positive:** scrolling lists and pages with web semantics, in documents and Svelte.

**Negative / costs:**
- hit-testing, picking and navigation all gain the scroll offset;
- drag-scrolling must be told apart from presses (a movement threshold);
- momentum adds per-frame work while it runs.

## Deprecates

Nothing.

## References

0418 wave 1 (`overflow: hidden`), 0422, 0340, 0420; CSSOM View (scrolling APIs).
