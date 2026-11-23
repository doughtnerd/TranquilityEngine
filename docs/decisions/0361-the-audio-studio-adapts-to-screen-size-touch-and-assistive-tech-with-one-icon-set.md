# 0361. The Audio Studio adapts to screen size, touch and assistive tech, with one icon set

- **Status:** Accepted
- **Date:** 2026-11-23
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0174, 0219, 0341, 0349

## Context

The Studio's screens (0341) and component kit (0349) shipped with their functions in place but little of the
prototype's polish: buttons drawn as text glyphs (`+`, `×`, `▶`, `⏮`, `?`, `∿`), a header that clipped its tabs below
about 1500px, side docks that squeezed the middle panel to a sliver on a tablet and broke on a phone, player-bar
container queries written against the container itself (so they never applied), no touch sizes, context menus that iOS
can't open (it sends no `contextmenu` for a long press), and icon-only controls without names. The prototype canvas
(the "Audio Design Studio" design) draws all of this: inline stroke icons, `pointer: coarse` sizes, a left dock that
folds on a tablet, a player bar sized by its own width, reduced motion and ARIA throughout.

## Decision

We will make the Studio work from a phone to a wide desktop, with a mouse, a finger or a keyboard and screen reader,
using these shared pieces:

- **One icon set**, `src/studio/components/Icon.tsx`: stroke icons on a 24-unit grid in `currentColor` (so themes and
  disabled states colour them), sized with `--ui-scale`. An icon is decoration (`aria-hidden`); its control carries the
  name (visible text, or `aria-label` plus a tooltip). Text that is notation stays text (M / S, A/B, kind badges, dB).
  Player-bar transports use `TransportButton` (icon, name, optional `primary` and `pressed`).
- **Width-driven chrome.** The header, player bar and status bar follow their own width with container queries: the
  header drops its group titles, then every tab label but the open screen's, then all labels, and below about 1020px
  gives the screens a row of their own that scrolls sideways; the player bar drops its status and captions and on a
  phone stacks the transport above the now-playing tile and Hear as.
- **Docks that fold.** `DockHost.foldBelow` (`src/editor/layout/narrowFold.ts`): below that width, with docks open on
  both sides, the outermost open left dock is drawn folded to its strip. The fold is only drawn; the stored layout keeps
  the dock open, so a wide screen shows it again. Opening it keeps it open while narrow; collapsing it folds it back
  without storing a collapse. The Studio sets 900px; the scene editor doesn't set it.
- **One panel at a time on a phone.** Below 640px a screen shows a row of panel tabs (the fixed panel first) over one
  panel at full size, over the same layout store, so nothing about the saved layout changes.
- **Touch.** Under `pointer: coarse`: 36px buttons and fields, 40px rows and tabs, 44px transports, wider resize-handle
  hit areas, `touch-action: manipulation` on controls and `none` on drag surfaces, menus that scroll within the visible
  height, hover-only controls shown. A long press (550 ms, held within 10px) sends the pressed element a `contextmenu`
  unless the browser sent its own (`shell/longPress.ts`). Zooming timelines and plots have zoom buttons beside
  Ctrl+wheel.
- **Accessibility.** Real buttons and labels, names on icon-only controls, `aria-pressed`, `aria-expanded`,
  `aria-selected`, `aria-current` and `aria-keyshortcuts` where they apply, focus rings from `--focus-ring`, and
  `prefers-reduced-motion` turns transitions and animations off.

## Alternatives considered

- **An icon font or a third-party icon package** — a new dependency and a download for a few dozen shapes; inline SVG
  in `currentColor` themes for free and matches the prototype's drawing.
- **Media queries on the viewport** — the header and player bar also render in Storybook and could sit in narrower
  frames; container queries follow the element.
- **Store the tablet fold in the layout** — a phone or a narrowed window would then collapse the dock on the desktop
  too; drawing it only keeps one saved layout for every size.
- **A separate phone layout per screen** — duplicates each screen's panel list; the single-panel view reuses the dock's
  own panels and order.

## Consequences

**Positive**
- Every screen is usable on a tablet and a phone; touch can reach every control and context menu.
- Icons, sizes and names are consistent across screens and themes.

**Negative / costs**
- Each panel must now work at phone width alone and at about 280px in a side dock; new panels have to be checked at
  both.
- Touch sizes make dense lists show fewer rows on touch screens.

## Deprecates

The glyph buttons (`▶ ■ ⏮ ⏭ ⇥ + × ? ∿` and similar) across the Studio, replaced by `Icon`. The Studio's
`.studio-icon` button class is unrelated to `Icon`'s `.studio-glyph`.

## Open questions

- Pinch-to-zoom on timelines (zoom buttons cover touch for now; the Spatial plan already pinches).
- Whether the scene editor adopts `foldBelow` and the single-panel view.

## References

- The "Audio Design Studio – Prototype UI v2" canvas (Studio page): header, player bar, dock and touch rules.
- ADR 0341 (the shell), 0349 (the component kit), 0174 (docks).
