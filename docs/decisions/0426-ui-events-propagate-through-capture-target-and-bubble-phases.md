# 0426. UI events propagate through capture, target and bubble phases, as DOM events do

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0309, 0340, 0385, 0423

## Context

UI events (0309) go to one element: the button clicked, the field changed. They don't bubble. Svelte code, and web code in general, relies on DOM propagation:

- a click handler on a list catches clicks on its rows;
- `onclickcapture` sees a click before its target;
- `stopPropagation` stops it;
- `preventDefault` cancels what the engine would have done;
- Svelte delegates common events to its root.

0423's full-compatibility target lists this as UI core work.

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
  - toggling checkboxes (0428);
  - scrolling on wheel and drag (0427);
  - submit on Enter.
- **Timing doesn't change.** Events are recorded in the interaction log as today and dispatched once per frame at the same point, so polled state, the `UIEvents` buffer and systems see the same frame (0309, 0017). Propagation only decides which handlers run.
- **Both front ends:** `element.on(type, handler, { capture })` on UI documents, and the renderer's `addEventListener` (with `capture`, `once`, `passive`) for Svelte. Svelte's root event delegation works because events bubble to the view's root.
- **Pointer claims are unchanged** (0385): what claims the pointer for the game is still decided by raycast targets, not by handlers.

**As built (2026-11-26):**

- **Records and one dispatch.** The UI core's routing records the frame's events as records (`engine/ui/events.ts`): a DOM type, the target component, the pointer or key data, and the default action as a callback told whether the record was prevented. The interaction log publishes them with its frame rule, after the polled events of the same frame. `engine.UIDocumentEvents` (the documents' old point: after input routing, before behaviors' `update`) fills the `UIEvents` buffer as before, then dispatches every record of the frame in order, for documents and hosted trees alike, each followed by its default action. So Svelte handlers now run there too, a little earlier than `engine.UIHostEvents`, which only delivers transition and animation events now. A default action can record more (focus moving records `blur`, `focusout`, `focus`, `focusin`), dispatched in the same pass.
- **Targets are raycast targets** (0385). Pointer events go to the topmost element that stops the pointer; a press on a bare layout panel (no background, no border) reaches the game and no UI handler, as before. A label the engine made (a button's text in a document, the renderer's element for a text node) isn't a target: its events are its parent's, and over/out between them aren't sent. `click` goes to the element the press and the release share (any element, not only buttons; none inside a button whose `interactable` is off); the polled `clicked` is unchanged. `dblclick` is two clicks on one element within 0.5 s and 5 CSS pixels; `contextmenu` follows a right press (Windows' and Linux's timing).
- **Positions:** `clientX`/`clientY` in the target canvas's UI pixels (matching `getBoundingClientRect` and the 0423 units ruling), `offsetX`/`offsetY` in the target's own pixels through its transforms, `canvasX`/`canvasY` in the drawing canvas's CSS pixels.
- **Keys** come from the device snapshot before claims (`PointerFrame.keys`, internal), so `keydown`/`keyup` reach a typing field and bubble on. With nothing focused they go to the scroller the last press landed in (0427), else nowhere.
- **Default actions as built:** focus on press (the `pointerdown`'s), so a press's focus is taken in the frame's event step: the input phase of that frame (navigation, the `ui` context) still sees the old focus, and a typing field claims the keyboard from the next routing. Preventing the `pointerdown` also stops a touch drag scroll and a UI drag. Enter's `keydown` prevented takes the field's `submit` back for the frame (`UIInteractions.retract`). Typing can't be prevented: the browser has put the character in the hidden input before the frame's handlers run. Checkboxes wait for 0428.
- **Drags (UI to UI)** start on an element with the new `draggable` field after the press moves 4 CSS pixels (a touch drag that a scroller takes scrolls instead); `dataTransfer` holds text in memory; `drop` needs a `dragover` prevented in an earlier frame; a drag isn't a click.
- **Svelte:** the renderer relays each type with one capture and one bubble host listener per node; `addEventListener` takes `capture`, `once` and `passive` (a passive listener's `preventDefault` does nothing); `mouse…` names are aliases run with the pointer event, not separate events. An event that bubbles out of a view's canvas unstopped goes on to `<svelte:body>`, `<svelte:document>` and `<svelte:window>` (`onUIHostBubbleOut`); a type the UI dispatched in a frame isn't fed to them again from the devices. Capture doesn't start at the window: a window or document capture listener doesn't hear UI events before their targets. `node.dispatchEvent` propagates over the renderer's nodes (by `event.bubbles`) and out to the globals.
- **Documents:** `on(type, handler, { capture, once })`, `off(type, handler, { capture })`; the `UIEvent` interface gains the DOM members and fields, and the new types. The `UIEvents` buffer is unchanged.

## Alternatives considered

- **Keep target-only events and emulate bubbling in the Svelte renderer.** UI documents wouldn't get it, and two event models would drift.

## Consequences

**Positive:** Svelte's event delegation and every DOM event idiom work, with the same rules for documents and views.

**Negative / costs:** each event walks its ancestor path (cheap: UI trees are shallow), and the event set and default-action rules become API.

## Deprecates

Nothing. Target handlers keep working: the target phase runs them.

## References

0309, 0340, 0385, 0423; DOM Standard §2 (events, dispatch).
