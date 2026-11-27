# 0437. The UI core resolves each element's paint, as it resolves its text run

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0271 (extends), 0076, 0069, 0340, 0422, 0428, 0432, 0010

## Context

ADR 0271 made the UI core resolve each element's text run once and report it, so what is measured is what is drawn. An element's paint had no such owner:

- Babylon's `syncPanel` (`render/babylon/ui.ts`) picked a box's fill from `hovered`, `pressed`, the interaction log's `showsFocus`, `interactable` and the Unity-style colours (`hoverColor`, `pressedColor`, `focusColor`, ADR 0069 and 0340), picked a field's border from `focusColor` the same way, and resolved each corner's radius (`-1` meaning `borderRadius`). A text's box read its colour and border fields again in `syncInline`.
- The UI host had two `:hover` mechanisms. `_lateSync` restyles every element whose pseudo-state changed, which is how a border, a text colour or anything else follows `:hover`. Buttons also got a second one: `UIHost.apply` re-ran `resolveStyle` with the element in pretend `:hover` and `:pressed` states on every restyle, just to copy those backgrounds into the public `hoverColor` and `pressedColor` fields, because the drawing layer drew those fields while hovered or pressed instead of `backgroundColor`.
- The second mechanism hid the first: a `transition: background-color` on `:hover` restyled and animated `backgroundColor`, but the drawing showed `hoverColor`, which jumped. A `:focus` background was drawn while focused by the pointer and replaced by `focusColor` while navigating.
- Button state colours were tested only through Babylon GUI over a fake canvas 2D context.

## Decision

We will make the paint the core's output, as the text run is.

- **The resolved paint.** `ui/paint.ts` (renderer-neutral, not public API, ADR 0010) has `paintOf(component)`: the `UIPaint` a box element is drawn with now: `background` (RGBA, null for none or a transparent colour), `borderColor`, `borderWidths` (top, right, bottom, left) and `radii` (top-left, top-right, bottom-right, bottom-left), or null for kinds without a box (images, canvases). A panel's, and every kind built on one (buttons, fields, options, form controls); a text's box (one radius, ADR 0432).
- **State colours are inputs.** For an interactable button: pressed and hovered takes `pressedColor`, hovered `hoverColor`, showing focus `focusColor` (a press dragged off shows the plain fill, as before). For any other focusable element, showing focus takes `focusColor` as its border. Each applies unless the element's own style states that look: the rule that gives it its `backgroundColor` (or `borderColor`) names that state's pseudo-class in its subject compound (`:hover`, `:pressed` (or `:hover` for pressed), `:focus`). Then the style's value is drawn, which the real pseudo-state restyle has already written and the animator transitions.
- **The host records which states its rules state.** As it applies a restyle, the UI host writes `UIPanel._styledStates` (internal): the paint states named by the subject compounds (`:is()`/`:where()` options included) of the matching selectors of the rules that won `backgroundColor` and `borderColor`. Null for an unstyled element, or one whose sheets use no pseudo-classes, so code-built UI and attributes use the Unity-style colours alone.
- **The core reports it.** `UICore` resolves each element's paint every sync, keeps the same object while it draws the same (`samePaint`), and reports it on `UILaidOutElement.paint`. A changed paint, such as a hover, bumps `layoutVersion` as a changed text run does.
- **Babylon draws exactly that.** `syncPanel` and `syncInline` take the fill, border and corners from `el.paint`; the drawing layer no longer reads `hovered`, `pressed`, `showsFocus` or the state colours.
- **The pretend-state restyle is deleted.** `UIHost.apply` no longer resolves the element in pretend states or writes `hoverColor`/`pressedColor`. Those fields stay public, as inputs a script, an attribute (`hover-color`) or a style property sets.

## Alternatives considered

- **Keep the pretend-state pass, move only the selection into the core.** The core would still draw `hoverColor` for a styled `:hover`, so transitions on `:hover` backgrounds stay broken, and every button restyle still costs three extra cascades.
- **The style always wins (a stylesheet background turns the state colours off), as an author rule beats the UA sheet in browsers.** Simpler, but a project that styles a button's background without a `:hover` rule would lose its hover feedback, which the Unity-style colours give it today.
- **The host writes `hoverColor` from the real restyle when the element is hovered.** No pretend states, but it still overwrites public inputs and still jumps instead of transitioning.
- **Babylon calls `paintOf` itself** (as 0271 rejected for `textRunOf`): "the drawing shows the state" would hold only while both call the same function; reporting it makes it a property of the core's output that a test reads.

## Consequences

**Positive**
- One `:hover` mechanism: the real pseudo-state restyle. A `:hover` or `:pressed` background transitions as written.
- State colours are tested where they are decided, through `UICore.elements()` (`engine/tests/uiResolvedPaint.test.ts`); Babylon's test checks only that it draws the paint it is given.
- A button restyle no longer runs the cascade three times.

**Negative / costs**
- A changed behaviour: while navigating, a `:focus` rule's background (or a field's `:focus` border colour) is drawn instead of `focusColor`, matching what pointer focus already showed.
- A changed behaviour: a stylesheet's `:hover`/`:pressed` backgrounds no longer appear in a button's public `hoverColor`/`pressedColor` fields; a script reading them sees its own or the default value.
- `paintOf` runs for every element each sync (field reads, a few small arrays), and a hover bumps `layoutVersion`.
- A state reached only through an ancestor or `:has()` (`.card:hover button`) isn't the element's own: its own hover still draws `hoverColor`, as the pretend-state pass did.

## Deprecates

`UIHost.apply`'s pretend-state restyle (it is removed). Babylon's state-colour selection and corner resolution in `syncPanel`, and `syncInline`'s own reads of a text's box fields (removed; they read `el.paint`).

## Open questions

None.

## References

- Architecture review 2026-11-27, candidate "the UI core resolves paint".
- `src/engine/ui/paint.ts`, `src/engine/ui/UICore.ts` (`collectResults`), `src/engine/ui/host/UIHost.ts` (`styledStatesOf`), `src/engine/render/babylon/ui.ts` (`syncPanel`, `syncBorder`, `syncInline`); tests `engine/tests/uiResolvedPaint.test.ts`, `engine/tests/babylonUI.test.ts` ("draws the paint the core resolved…"), `engine/tests/piratesMenu.test.ts`.

## As built (2026-11-27)

- Built as decided. `UIRGBA` and `UIPaint` are in `ui/uiCoreTypes.ts`; `UIPaintState` and `UIStyledStates` in `ui/paint.ts`.
- A fully transparent fill is reported as none (`background: null`); Babylon sets an empty background for it instead of `rgba(…, 0)`, which draws the same.
- The clip container's corner radius (`syncClip`), box shadows, `backgroundImage` and scrollbar colours still read component fields: none of them depends on interaction state.
- The HUD bundle size tripwire (`MEASURED_GZIP` in `svelteExport.test.ts`) is unchanged and passes.

### Follow-up (2026-11-27)

- **States named outside the subject count.** The rule that gives an element its `backgroundColor` (or `borderColor`) now states a state's look when a selector of it that matches the element names that pseudo-class anywhere: in any compound (`.row:hover button`, `#row:has(#b:hover) #b`), and inside `:is()`, `:where()`, `:has()` and `:nth-child(… of S)`. That rule only matches while the state it names holds, so what it gives is the look for that state, written by the real restyle and transitioned; drawing the Unity-style colour over it would hide it. Under `:not()` a state is named as *not* holding: `.row:not(:hover) button` is the look of a row that isn't hovered, and says nothing about a hovered button, so it doesn't count (it does again under two `:not()`s). This replaces the subject-only rule above and resolves the last negative consequence (`.card:hover button` with the button hovered now draws the rule's background). The styled tree works out each selector's named states once (`paintStatesOf`, cached per selector) and still requires the selector to match the element now.
- **An unchanged paint allocates nothing.** `paintOf(component, last)` reads its inputs (the fill and border colours after the state colours, the side widths, the corner radii) into scratch slots and returns `last` itself when it holds them all; otherwise a new paint shares `last`'s unchanged arrays. `UICore.collectResults` passes each element's last paint, and `samePaint` is deleted. The core has no per-field change tracking to key a skip on (component fields are plain properties), so the read is the dirty check: about twenty field reads and the focus check per box element per sync, and no allocation unless the paint changed. Tested through `UICore.elements()`: the same paint object across a write that draws the same (a new `Color` of the same colour, a side width equal to `borderWidth`), a new one when a painted field changes.
