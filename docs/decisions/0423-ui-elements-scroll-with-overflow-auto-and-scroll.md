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
