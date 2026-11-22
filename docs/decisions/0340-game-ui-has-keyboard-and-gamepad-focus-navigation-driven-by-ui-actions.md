# 0340. Game UI has keyboard and gamepad focus navigation, driven by built-in UI actions

- **Status:** Accepted
- **Date:** 2026-11-22
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0020, 0069, 0076, 0077, 0309, 0336, 0337

## Context

The game UI library is UI components (ADR 0069) and UI documents (ADR 0077), laid out and routed by the UI core (ADR 0076). It can only be used with a pointer:
- buttons are clicked;
- input fields are focused by a click and typed into through a hidden DOM input.

Keyboard and gamepad navigation between UI elements has been open since ADR 0020 (open question **O7**). ADR 0336 noted that UI navigation should become ordinary actions in a `ui` context.

Every console-style or couch game needs this: menus driven by d-pad and A/B, Tab through a form, Escape to back out. `UIControlMapper` (ADR 0337) works around the gap with a selection model of its own.

What engines do:
- **Unity:** `Selectable` elements with automatic (spatial) or explicit navigation, a `firstSelected` per screen, and the Input System's UI module mapping navigate, submit and cancel actions.
- **Godot:** focus neighbours (`focus_neighbor_*`), automatic spatial focus, and `ui_*` actions in the InputMap.
- **Unreal:** Common UI's activatable widgets, which give modal input routing and per-platform action bars.

## Decision

**Focus.** Each World's UI has at most one **focused** element. It's kept in the World's UI interaction log (ADR 0309), which today keeps the focused input field. Its rules:
- Focusable elements are the interactive ones: `UIButton` and `UIInputField`, active, visible, and (buttons) `interactable`.
- A new field, `focusable` (default true), takes one out.
- `UIButton.focused` is readable and settable, like `UIInputField.focused`.
- A click focuses what it clicked, as now.

**Built-in UI actions.** An engine action set, `engine.UIActions`:

| Action | Type | Defaults |
| --- | --- | --- |
| `navigate` | `vec2` | arrow keys, `<Gamepad>/dpad`, `<Gamepad>/leftStick` |
| `submit` | button | Enter, Space, `<Gamepad>/buttonSouth` |
| `cancel` | button | Escape, `<Gamepad>/buttonEast` |
| `next` | button | Tab |
| `previous` | button | Shift+Tab |

- `navigate`, `next` and `previous` repeat while held, with a 0.4 s delay then every 0.1 s, using the `pulse` trigger.
- The defaults sit in an engine context named `ui`, not in the default context. That context is active for a player only while their World's UI has a focused element, at a priority above any game context (`UI_CONTEXT_PRIORITY`, 1000).
- **Consumption:** while a menu has focus, its arrows, d-pad, Enter and Escape don't also move or pause the game. With nothing focused, the context is off and the game gets every control.
- Players rebind the `ui` context like any other (ADR 0337, 0339).
- While an input field is focused, the keyboard still types into it (ADR 0069). Only Tab, Shift+Tab, Escape and gamepad controls navigate out of it.

**Navigating.** A built-in system, `engine.UINavigation`, runs in the `input` phase after `engine.InputEvaluate`:
- **`navigate`:** moves focus to the nearest focusable element in that direction. The search runs from the focused element's laid-out rectangle, over the candidates whose centres lie in a 90° cone, scoring by distance with a penalty for being off-axis (CSS spatial navigation's heuristic).
- **Explicit neighbours:** fields `navUp`, `navDown`, `navLeft` and `navRight` (node references) on a focusable element override the search per direction. `navigation: "auto" | "explicit" | "none"` turns the search on, off, or off entirely, like Unity.
- **`next` and `previous`:** move in tree order (document order in UI documents), wrapping within the canvas.
- **`submit`:** clicks the focused button, recorded as a `click` in the interaction log, so `clicked`, UI document `onClick` handlers and `UIEvents` work unchanged. On an input field, it starts typing.
- **`cancel`:** recorded as a `cancel` event on the focused element's canvas: `UICanvas.canceled` and a UI document `onCancel` handler.
- **Events:** focus changes are recorded as `focus` and `blur` events: UI document handlers and `UIEvents` rows, and `UIButton.focusedChanged`.
- **Timing:** these events are published for the current frame, which hasn't run any script yet when the input phase ends. This keeps ADR 0309's rule: every script phase of a frame sees the same events.

**Where focus can go.**
- Navigation stays within one canvas: the focused element's canvas, or, with nothing focused, the highest-`sortOrder` screen canvas that has a focusable element.
- A canvas can **trap** focus (`UICanvas.modal`, default false): while a modal canvas has a focusable element, focus can't leave it, so a pause menu over a HUD keeps it.
- **Initial focus:** `UICanvas.autoFocus` (default false) focuses `UICanvas.firstSelected` (a node reference), or else the canvas's first focusable element, when the canvas becomes active. A game opening a pause menu gets focus without script.
- **Which players drive the UI:** `UICanvas.player` (-1, the default, means any local player) says which player's `UIActions` drive it, for split-screen menus.

**Showing focus.** `UIButton.focusColor` and `UIInputField.focusColor` (with defaults) are drawn while the element is focused and the player's last UI input was a navigation action, not the pointer. Mouse users don't see a stray highlight; d-pad users always see where they are.

**UI documents** (ADR 0077) follow the same rules, with these attributes:
- `focusable="false"`;
- `nav-up`, `nav-down`, `nav-left` and `nav-right` (element ids);
- `navigation="explicit"`;
- on the root, `auto-focus` and `first-selected`.

**`UIControlMapper`** moves onto this. Its own selection model is removed; its cells are focusable buttons, and stick navigation comes with the left stick in `navigate`.

**Open question O7's navigation half is answered.** Its styling half stays open.

## Alternatives considered

- **Hard-coded keys and buttons in the UI core.** Smaller, but they couldn't be rebound or consumed, and would clash with game controls. ADR 0336 already said UI navigation should be actions.
- **Explicit neighbours only (no spatial search).** Predictable, but every menu would need wiring by hand. Unity and Godot both default to automatic and allow explicit.
- **DOM focus through the hidden input element.** The UI is drawn in the canvas (ADR 0076), with no DOM elements to focus, and gamepads don't move DOM focus.
- **A `ui` context that is always active.** Arrow keys and the d-pad would never reach gameplay while any UI exists, even a HUD.

## Consequences

**Positive**
- Menus, forms and the rebinding screen work with keyboard and gamepad with no game code.
- UI controls are rebindable and consumed like any other.
- Split-screen menus can belong to one player.

**Negative / costs**
- More fields on the UI components, and attributes on UI documents, to document and show in the Inspector.
- One more built-in system and context. Spatial search runs only when a navigate action fires.
- `UIControlMapper`'s own selection model is replaced, which changes how its tests drive it.

## Deprecates

`UIControlMapper`'s private selection model (cell selection by arrows and d-pad): replaced by focus navigation.

## Open questions

- An on-screen keyboard for typing into input fields with a gamepad (the platform's on desktop or console, an engine one on the web).
- Common UI-style action bars (a row of "A Select  B Back" prompts per screen), which could use `InputPrompt` and `InputGlyphs`.

## References

- `src/engine/ui/UICore.ts`, `interactions.ts`, `components.ts`, `UIDocument.ts`, `controlMapper.ts`; `src/engine/input/actions.ts`, `contexts.ts`, `evaluate.ts`
- Unity UI navigation: https://docs.unity3d.com/Packages/com.unity.ugui@2.0/manual/script-Selectable.html
- Godot focus: https://docs.godotengine.org/en/stable/tutorials/ui/gui_navigation.html
- CSS spatial navigation: https://drafts.csswg.org/css-nav-1/

## Build notes (2026-11-22)

Built in `src/engine/ui/navigation.ts` (`engine.UIActions`, the `ui` context, `engine.UINavigation`), `interactions.ts` (the one focus per World), `components.ts`, `UICore.ts`, `UIDocument.ts` and `render/babylon/ui.ts`. `UIControlMapper` isn't moved onto focus navigation yet: its own selection model still runs beside it.

- **Focused and typing.** Navigation focuses an input field without typing in it (`submit` starts typing), so a field has two states: `focused` (it's the World's focused element) and a new read-only `UIInputField.typing` (it takes the keyboard; the keyboard claim, the hidden input and the caret follow it). A click, or a script's `focused = true`, still focuses and starts typing, so code written before this record sees no change.
- **Leaving a typing field.** Tab, Shift+Tab and Escape come from the hidden `<input>` (the keyboard is the field's while it types, so the `ui` context can't see them, and they aren't rebindable there). Their presses are claimed from the game until released, through a new `InputClaim.keys` in the device snapshot, so neither the game nor the `ui` context sees the same press again once typing stops. Escape stops typing and keeps focus on the field (it doesn't record `cancel`); before this record it unfocused the field. The gamepad's UI actions leave a typing field as from any element (its `cancel` stops typing).
- **The `ui` context** is a context registered with `defineInputContext` (so rebinding finds it, checks conflicts against it, and a project can replace it under the same name), switched on per player by an internal engine context source (`addContextSource` in `contexts.ts`, read by the evaluator's per-player context list). The repeat is two action-level triggers, `pressed` and `pulse { delay: 0.4, interval: 0.1 }`, so rebound mappings keep it. The left stick mapping has a 0.5 dead zone, so a resting stick never moves focus.
- **Events.** Focus changes navigation makes (including `autoFocus` and a modal canvas pulling focus in) are published for the current frame; a press's are published with the click, for the next frame; a script's are never events (ADR 0309). `focusedChanged` is on input fields too. `cancel` is a `UICanvas.canceled` getter, and reaches a UI document as a `cancel` event on its root element (`doc.root.on("cancel", …)`, `UIDocumentElement.canceled`) when the canceled canvas is its root or the canvas above it. `UIDocumentElement.focused` covers buttons.
- **Pointer.** A press focuses the button or field it hit, and a press on nothing unfocuses, unless a modal canvas keeps focus. `modal` traps focus only: presses outside it still press what they hit, without taking focus. Because a clicked button keeps focus, Space and Enter press it afterwards (as in Unity); the guide tells games to give HUD buttons `focusable = false`.
- **Showing focus.** Focus colours show while the World's last UI input was a UI action (one flag per World, not per player); moving or pressing the pointer clears it. `focusColor` is a button's fill, under hover and pressed, and an input field's border.
- **Search.** A candidate counts when its centre is beyond the focused box's edge and inside a 90° cone opening from that edge, or when its span overlaps the box's across the direction (so a wide button below is reachable). Score: distance from the edge to its centre plus twice its centre's distance off the box's span. Explicit neighbours must be focusable elements of the same canvas. `navigation: "none"` stops `navigate` only; `next` and `previous` still leave the element.
- **`autoFocus`** also runs again when its canvas loses its focused element to that element becoming unfocusable (hidden, removed, made non-interactable), so a d-pad player isn't left without focus.
- **Rebinding.** A player with a rebind pending doesn't drive navigation, so the press being captured doesn't also move focus or click.
- **UI documents.** `nav-*` and `first-selected` name element ids, looked up in the element's own list row first, then the whole document; a bare boolean attribute (`<Canvas auto-focus>`) is `true`.
- **`UIControlMapper` migration (left for later):** `engine.UIActions` is an action set like any other, so a mapper with an empty `actions` list now lists it too, with no default-context bindings; the mapper should skip `engine.UIActions` or show the `ui` context's bindings for it.
