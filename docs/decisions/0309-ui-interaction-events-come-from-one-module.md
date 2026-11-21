# 0309. UI interaction events come from one module, stamped once for the World's next frame

- **Status:** Accepted
- **Date:** 2026-11-21
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0069 (UI components, polled state), 0076 (the UI core routes input), 0077 (UI documents, handlers, `UIEvents`), 0298 (the document's element source; unchanged), 0310 (the device snapshot that hands the UI core the pointer)

## Context

"What the player did to a UI element this frame" was found in three modules, with two timing rules:

- `ui/UICore.ts` `route` (run in the input snapshot, before any World steps) wrote `_hovered`, `_pressed` and
  `_focused` onto the components and stamped `_clickFrame` / `_submitFrame` with `frameCount + 1`, the World's next frame.
  Its hidden DOM `<input>` handler wrote `value` and recorded nothing.
- `ui/UIDocument.ts` found changes and hovers by comparing values each frame (`_lastValue`, `_wasHovered`) in the
  `engine.UIDocumentEvents` system and stamped `_changeFrame` with the *current* frame. To keep a script's own edit from
  counting as the player's, `_lastValue` was reset in four places (the element `value` setter, the build, binding writes,
  the late sync).
- `ui/components.ts` getters read those stamps.

Confirmed by reading: a script setting `UIInputField.value` in `fixedUpdate` (or in an update system ordered before
`engine.UIDocumentEvents`) was reported as a player `change`; `changed` was stamped a frame differently from `clicked`
and `submitted`, so `fixedUpdate` saw clicks but never changes; and a bare `UIInputField` (outside a document) had no
`changed` at all.

## Decision

We will record every UI interaction in one module, `src/engine/ui/interactions.ts`, with one timing rule.

- **The interaction log** (`UIInteractions`, one per World, `uiInteractions(world)`): the UI state the player drives —
  the button under the pointer (`hovered`), the button a press began on (`pressed`), the focused input field (`focused`)
  — and the frame's **interaction events**: `click`, `submit`, `change` and `hover` (the pointer moving onto a button),
  each for one component.
- **Who records:** only the UI core. Its routing hands the log what the pointer did (`route`: hovered, pressed, clicked);
  its hidden `<input>`'s handlers record `change` (the browser's `input` event, when the value really changed) and
  `submit` (Enter) as they happen, between frames.
- **One timing rule:** events recorded since the last routing are published by the next routing, stamped with the
  frame the World steps next (`frameCount + 1`). Every script phase of that frame — `fixedUpdate`, `update`, systems in
  any order — sees the same events; the frame after, none. A `submit` is dropped if its field lost focus before the
  routing. Events recorded while the World doesn't step (paused) are kept for the frame it next steps.
- **Readers:** `UIButton.hovered` / `pressed` / `clicked` and `UIInputField.focused` / `submitted` and the new
  `UIInputField.changed` read the log. `UIInputField.focused = …` from a script writes the log's focused field (one
  focused field per World; setting it on another field moves focus). `UIDocument` walks its elements in document order,
  asks the log which events each had this frame, and turns them into handler calls and `UIEvents` rows; it computes
  nothing itself.
- **Deleted:** the value comparison, `_lastValue` and its four resets, `_wasHovered`, `_changeFrame`, and the
  component members `_hovered`, `_pressed`, `_focused`, `_clickFrame`, `_submitFrame`. A script writing `value` (on the
  component, through an element, or by a binding) never makes a `change`, in any phase.
- ADR 0298's document-source interface is untouched.

## Alternatives considered

- **Keep the comparison and add a fifth reset after `fixedUpdate`.** Fixes one symptom; the two timing rules and the
  reset list stay, and the next phase or system order breaks it again.
- **Stamp events onto the components** (as clicks were). Keeps the stamps spread over component members the routing
  writes; the document would still need its own idea of hover-enter. One log per World gives one place to read.

## Consequences

**Positive**
- One timing rule: `clicked`, `submitted`, `changed` and `hover` are true in the same frame, in every phase.
- A script's own edits are never player changes; no reset list to keep in step.
- `UIInputField.changed` works outside documents.

**Negative / costs**
- A World without a UI core (a headless test without one, a server) records no `change`: a script writing `value`
  there no longer fires `change` handlers. That was the bug, but tests that typed by writing `value` now type through
  the UI core's input.
- Two focused fields at once are no longer possible (the second focus moves it).

## Deprecates

The value comparison in `UIDocument._collectEvents`, `UIDocumentElement._lastValue` / `_wasHovered` / `_changeFrame`,
and the routing-written component members listed above (removed).

## Open questions

None.

## References

`src/engine/ui/interactions.ts`, `UICore.ts` (`route`, `ensureDom`), `components.ts`, `UIDocument.ts`
(`_collectEvents`, `_lateSync`); tests `src/engine/tests/uiInteractions.test.ts`, `uiCore.test.ts`,
`uiDocument.test.ts`.
