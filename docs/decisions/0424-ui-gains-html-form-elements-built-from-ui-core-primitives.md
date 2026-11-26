# 0424. UI gains HTML's form elements, built from UI core primitives and styled by the cascade

- **Status:** Accepted
- **Date:** 2026-11-26
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0340, 0419, 0422, 0423

## Context

0419 requires HTML elements to behave like HTML. Today there are text inputs (`InputField`) and buttons. Svelte code expects:

- `<input type="checkbox|radio|range|number|password">`;
- `<textarea>`;
- `<select>`/`<option>`;
- `<progress>`/`<meter>`;
- `<label>` that focuses or toggles its control;
- the bindings `bind:checked`, `bind:group`, `bind:value` on each.

Babylon GUI has `Checkbox`, `RadioButton`, `Slider`, `InputTextArea` and `InputPassword`, but they don't take Yoga layout or our cascade.

## Decision

**Each form element is a UI core element kind (0271's table) drawn from existing primitives (panels, text, images) and styled by the cascade, with web semantics.**

- **New kinds**, each a component and a markup tag; the Svelte renderer maps its HTML names onto them:
  - `Toggle` (`input type=checkbox`): `checked`, `indeterminate`, `name`, `value`;
  - `Radio` (`input type=radio`): `checked`, `name`, `value`; one checked per `name` within a form or view;
  - `Slider` (`input type=range`): `min`, `max`, `step`, `value`;
  - `InputField` gains `type` (`text | password | number`), and with `number` also `min`, `max` and `step`;
  - `TextArea`: multi-line `value`, `rows`, `wrap`, scrolling (0423);
  - `Select` with `Option` children: `value`, `selected`, `disabled`, `multiple`; the list is a popup panel above the view;
  - `Progress` (`value`, `max`, indeterminate when unset) and `Meter` (`value`, `min`, `max`, `low`, `high`, `optimum`);
  - `Label` (`for`, or wrapping its control): a click focuses or activates its control.
- **Behaviour as in HTML:**
  - `input` and `change` events (0422) and default actions: toggling, typing, slider dragging and keys, opening and choosing in a select;
  - keyboard and gamepad through navigation (0340): arrows on sliders and radios, Space/Enter to toggle or open;
  - `disabled` everywhere, and `:checked`, `:indeterminate` and `:disabled` pseudo-classes for styling.
- **Default look:** a built-in stylesheet gives each kind its parts (a checkbox's box and mark, a slider's track and thumb, a select's arrow). Parts are reachable for styling as in browsers: `accent-color`, plus part pseudo-elements in a later record.
- **Svelte bindings:** the renderer's `bind` hook covers `checked`, `group` (radio and checkbox groups), and `value` with number coercion for `number` and `range`. `<form>` gets `submit` and `reset`.

**As built (2026-11-26):**

- **Kinds.** Ten: `Toggle`, `Radio`, `Slider`, `TextArea` (an `InputField` subclass), `Select`, `Option` (a `Button` subclass: hover, press and `clicked` come with it), `Progress`, `Meter`, `Label` and `Form`, the last two panels (a label wraps its control, so it's no longer a text kind in Svelte; `<form>` was a plain panel). `InputField` gains `type`, `min`, `max`, `step`; `Button` gains `type` (`submit` by default, as in HTML). `interactable` (HTML's `disabled`) moves from buttons to every focusable control.
- **Parts are worked out in the UI core** (`formParts.ts`) as rectangles in the element's frame, a stroke being a thin rotated rectangle, and every drawing layer draws them as it draws scrollbars (0423): a checkbox's fill and mark, a radio's dot, a slider's track, fill and thumb, a bar's or meter's fill, a select's arrow, a chosen option's highlight. The element itself is the box (a checkbox's square, a progress bar's track), styled as a panel.
- **The default look is the components' constructor values**, not a rule sheet: games that use only Svelte ship no CSS parser, and every rule beats a constructor value exactly as a user-agent sheet's lowest place would. What would need rules (the checked fill, a disabled control's fading) is drawn from the control's state in its parts.
- **A select's list** is its options laid out in a Yoga root of their own (the select's node is measured for its widest option's label, and Yoga's measured nodes have no children), placed below the select (above where it wouldn't fit), outside every clip, drawn and hit after everything else in its canvas, shown while `open`. Opening it from the keyboard focuses the chosen option; up/down, Tab, Enter and Escape act in the list; a press elsewhere closes it. A `value` no option has chooses the first option (HTML leaves none chosen).
- **Behaviour is default actions of the records 0422 built**: a click's (activation, including a label's click sent on to its control), navigation's `submit` (now a cancelable click record with that default), `pointerdown`'s (a slider's thumb jumping, open lists closing), `keydown`'s (sliders' Page/Home/End, a number field's arrows, Enter submitting a form after the field's own `submit`). So a checkbox toggles after its `click` handlers, not before them as in HTML (where a prevented click toggles it back). Events a default action or a script sends (`input`, `change`, `submit`, `reset`) dispatch at once once the frame's dispatch has begun or passed, else with the frame's records (`fireUIEvent`).
- **Navigation's arrows:** left and right step a slider and move a named radio group's check; up and down leave both (HTML's radios and ranges take all four arrows, but a gamepad would be stuck).
- **A text area** types into a second hidden element, a `<textarea>`, is `rows` lines tall whatever its text, and scrolls its wrapped text with 0423's scrolling (its extent is its text's height); its caret follows line breaks, not soft wraps.
- **Reset** puts controls back as the UI core first saw them (HTML's default value and checkedness), without events; Svelte bindings read the controls again a microtask after a form's `reset`, as Svelte's DOM bindings do.
- **Svelte:** the patch needed no change: the compiler already emits `bind_renderer` for `checked`, `indeterminate`, `group` and `value`; `bind:group`'s value is the node's `value` attribute as given (any type), as is an option's for `bind:value`. Binding listeners run in the capture phase, so bound state is set before the element's own `onchange` reads it. An `<input>` whose `type` changes is made again in place. `checked`, `indeterminate`, `value` and `selected` are content attributes: written when the attribute changes, so the player's change stays until then.
- **Not built:** part pseudo-elements (a later record, as decided), the indeterminate bar's animation on the tween backend (it sweeps on the unscaled clock in its parts), `<datalist>`, `<optgroup label>`, other `<input>` types (drawn as text fields), number spinners, `select size`.

## Alternatives considered

- **Babylon GUI's widgets.** Their own layout and styling would make them the one part of UI the cascade can't style or Yoga can't place.

## Consequences

**Positive:** HTML forms and their Svelte bindings work, in documents and Svelte alike.

**Negative / costs:** eight element kinds to specify and keep stable, a popup layer for selects, and default styles to maintain.

## Deprecates

Nothing.

## References

0271 (element kinds), 0340, 0419, 0422, 0423; HTML Standard §4.10 (forms).
