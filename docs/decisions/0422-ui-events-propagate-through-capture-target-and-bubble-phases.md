# 0422. UI events propagate through capture, target and bubble phases, as DOM events do

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0309, 0340, 0385, 0419

## Context

UI events (0309) go to one element: the button clicked, the field changed. They don't bubble. Svelte code, and web code in general, relies on DOM propagation:

- a click handler on a list catches clicks on its rows;
- `onclickcapture` sees a click before its target;
- `stopPropagation` stops it;
- `preventDefault` cancels what the engine would have done;
- Svelte delegates common events to its root.

0419's full-compatibility target lists this as UI core work.

## Decision

**UI events dispatch in three phases over the element's ancestor path: capture (root to target), target, then bubble (target to root), as DOM events do.**

- **Event types and their DOM bubbling rules:**
  - `click`, `pointerdown`/`pointerup`/`pointermove`, `pointerover`/`pointerout`, `wheel`, `keydown`/`keyup`, `input`, `change`, `submit` and `focusin`/`focusout` bubble;
  - `pointerenter`/`pointerleave`, `focus`/`blur`, `load` and `transitionend`/`animationend` don't;
  - `dblclick`, `contextmenu` and drag events (`dragstart`, `drag`, `dragend`, plus the UI-to-UI drop events) come from the pointer routing, which gains press timing and drag thresholds.
- **The event object:** `target`, `currentTarget`, `eventPhase`, `bubbles`, `stopPropagation()`, `stopImmediatePropagation()`, `preventDefault()`/`defaultPrevented`, and pointer and keyboard data (position in canvas and element pixels, button, buttons, key, code, modifiers).
- **Default actions run after dispatch, unless prevented:**
  - focus on press (0340);
  - typing into input fields;
  - toggling checkboxes (0424);
  - scrolling on wheel and drag (0423);
  - submit on Enter.
- **Timing doesn't change.** Events are recorded in the interaction log as today and dispatched once per frame at the same point, so polled state, the `UIEvents` buffer and systems see the same frame (0309, 0017). Propagation only decides which handlers run.
- **Both front ends:** `element.on(type, handler, { capture })` on UI documents, and the renderer's `addEventListener` (with `capture`, `once`, `passive`) for Svelte. Svelte's root event delegation works because events bubble to the view's root.
- **Pointer claims are unchanged** (0385): what claims the pointer for the game is still decided by raycast targets, not by handlers.

## Alternatives considered

- **Keep target-only events and emulate bubbling in the Svelte renderer.** UI documents wouldn't get it, and two event models would drift.

## Consequences

**Positive:** Svelte's event delegation and every DOM event idiom work, with the same rules for documents and views.

**Negative / costs:** each event walks its ancestor path (cheap: UI trees are shallow), and the event set and default-action rules become API.

## Deprecates

Nothing. Target handlers keep working: the target phase runs them.

## References

0309, 0340, 0385, 0419; DOM Standard §2 (events, dispatch).
