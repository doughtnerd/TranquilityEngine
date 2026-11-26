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

## Alternatives considered

- **Babylon GUI's widgets.** Their own layout and styling would make them the one part of UI the cascade can't style or Yoga can't place.

## Consequences

**Positive:** HTML forms and their Svelte bindings work, in documents and Svelte alike.

**Negative / costs:** eight element kinds to specify and keep stable, a popup layer for selects, and default styles to maintain.

## Deprecates

Nothing.

## References

0271 (element kinds), 0340, 0419, 0422, 0423; HTML Standard §4.10 (forms).
