# 0448. One form-control model owns UI controls' state and behaviour, and reading a control never changes it

- **Status:** Accepted
- **Date:** 2026-11-27
- **Deciders:** Chris Carlson
- **Supersedes:** —
- **Related:** 0271, 0340, 0423, 0426, 0428

## Context

0428 built HTML's form elements as UI core kinds. Their state rules ended up in three places:

- **`src/engine/ui/formControls.ts`**: a `defaults` WeakMap (what a reset puts back), `selectStates` and
  `reconcileSelect` (a select's `value` and its options' `selected` in step), activation, radio groups, slider and
  number-field stepping. Its header still said "both front ends", though 0423's wave D left one (Svelte).
- **The Svelte renderer** (`src/plugins/ui/svelte/renderer.ts`): `_defaults`, `_dirty` and `_templateDefault` on each
  node, `setDefault`, `pushDefaults` (handing its defaults over with `setUIDefaults`), `askForReset`, plus per-tag
  checks for state writes (a radio checks its group, an option unchooses the others).
- **The UI host** (`src/engine/ui/host/UIHost.ts`): content attributes written only when the attribute changes, which
  looked like a third dirty mechanism.

Rules were written twice:

- **HTML's selectedness** (nothing chosen: the first enabled option; several: the last) was in `reconcileSelect` and
  in the renderer's `askForReset`.
- **Slider stepping** used two rules. Navigation's arrows step by `step`, or a hundredth of the range without one.
  `UICore.keySlider`'s Page Up/Down moved a tenth of the range. That tenth snapped back to the same value whenever a
  step was longer than a tenth of the range, so the keys did nothing.

**Bug:** `elementKinds.textRunOf` read a select's label through `selectLabel`, which called `reconcileSelect`. That
wrote `option.selected`, `select.value` and the WeakMap. `textRunOf` is meant to be a pure read: it is the measure's
dirty signature (`sameTextRun`), the drawing layer draws its result, and the editor's `uiViewStrings` calls it. So
measuring a select, or the editor listing a view's strings, changed form state.

## Decision

**We will keep form controls' state and behaviour in one module, the form-control model
(`src/engine/ui/formModel.ts`), with a small interface.** It replaces `formControls.ts`.

- **Reads are pure:**
  - `controlValue` (the DOM's `value`);
  - `selectLabel`, `selectLabels` and `chosenOptions`, which work out a select's choice without writing it;
  - the tree helpers: `formOf`, `optionsOf`, `selectOf`, `radioGroup`, `labelledControl`.

  `textRunOf` reads `selectLabel`, so measuring never changes a control.
- **Writes**:
  - *default written*: `FormControlState.defaultWritten(field, value, current, keep)` returns whether the current
    value follows the new default. It follows only while the field isn't dirty and still equals its last default.
  - *script write*: `writeControl` and `writeControlValue`, with the DOM property's semantics: a radio checked
    unchecks its group, an option chosen in a single select unchooses the others, a select's `value` chooses at once.
    `FormControlState.wrote` sets the field's dirty flag.
  - *settle*: `settleSelect` puts in step what a script wrote straight to a select's fields. The UI core calls it for
    every select at the start of its sync, before layout reads labels.
  - *player change*: `playerTyped`, `dragSlider`, and the semantic inputs below. Each sets the dirty flag; the inputs
    also send `input` then `change`.
  - *reset*: `resetForm` puts each control back to its defaults and clears its dirty flags, as HTML's reset algorithm
    does.
- **Semantic inputs**, so that routing and navigation only translate keys:
  - `stepSlider(n)`: arrows;
  - `pageSlider(n)`: Page Up/Down;
  - `sliderToEnd`: Home/End;
  - `stepNumberField(n)`: a number field's arrows;
  - `checkByPlayer`: a radio group's arrows;
  - `activateControl` and its click record (`uiClickRecord`, `clickUI`).
- **One state record per control.** A `FormControlState` holds a control's defaults (HTML's default value, default
  checkedness, an option's `selected` attribute) and HTML's dirty flags. The UI core makes one from the control as
  built when it first sees it. Each renderer node keeps its own from creation, so defaults and dirty flags are known
  before the UI element exists, and hands it over when the element is made (`adoptControlState`). The renderer's
  `_defaults`, `_dirty`, `pushDefaults` and `setUIDefaults` are gone. `_templateDefault` stays in the renderer: it
  records how Svelte compiled the template (`set_default_value` keeps a template's value), so it is part of mapping
  Svelte onto the model, and the renderer passes it as `keep`.
- **One selectedness rule**: `selectedness(options, chosen, enabled, preferred)`. The UI core's settle uses it on
  components. The renderer's `askForReset` uses it on its nodes, which also hold before their UI elements exist.
- **One stepping rule for sliders**, browsers' (Chromium's `RangeInputType`):
  - an arrow steps by `step`, or a hundredth of the range without a valid step;
  - a page is a tenth of the range but at least one step;
  - the result is snapped to the steps from `min` and clamped.

  Navigation's arrows already followed this rule. Page Up/Down now moves at least one step.
- **Content attributes stay a diff, not a dirty flag.** The UI host writes a content attribute's field only when the
  attribute changes. That just skips attributes that didn't change; the dirty flags live in the front end's state
  record. The host writes the field directly, not through `writeControl`, because when an element is made its other
  fields (a select's `multiple`, a radio's `name`) haven't been styled onto it yet. The core settles the select at its
  next sync.

## Alternatives considered

- **Settle selects lazily inside the read, as before.** Simple, but it keeps the bug: any read (measuring, drawing, the
  editor) becomes a write.
- **Settle every script write synchronously with accessors on `UISelect`/`UIOption` fields.** That would put HTML's
  rules into the component classes and change the public components' field semantics. Settling at the core's sync, plus
  explicit model writes, keeps the components plain.
- **Move the renderer's pre-element state into the UI core.** Svelte sets defaults and values on nodes before their UI
  element exists, so the record has to live with the node until then. Handing the same object over keeps one record
  without inventing placeholder components.
- **Route the UI host's content attributes through `writeControl`.** Tried. The Svelte conformance fixture
  `form-default-value-select` failed: an option's `selected` attribute was applied before its select's `multiple` was
  styled on, so the single-select rule unchose its siblings.

## Consequences

**Positive**
- Measuring or drawing a select, and the editor reading a view's strings, no longer change form state.
- HTML's selectedness and slider stepping are each written once. Page Up/Down works on sliders whose step is longer
  than a tenth of their range.
- Defaults and dirty flags have one owner. A player's change sets them, a reset clears them (HTML's), so a default
  written after a reset reaches the control again.
- Routing and navigation lost their stepping code. The renderer lost its default hand-over and its per-tag state
  writes.

**Negative / costs**
- Behaviour changes, each towards HTML:
  - Page Up/Down moves at least one step.
  - A reset clears dirty flags. A control the player changed and the form then reset follows a later
    `defaultValue`/`defaultChecked`/`selected` change; before, it stayed put.
  - A player's change of a checkbox, radio, slider, number field or select option marks it dirty even when it ends
    back on its default value.
- A script's raw field write to a select (`select.value = …` on the component) still reads correctly at once (reads
  compute the choice), but the options' fields are put in step only at the UI core's next sync, as before.

## Deprecates

- `src/engine/ui/formControls.ts`: replaced by `formModel.ts`. `rememberDefaults`, `setUIDefaults`,
  `reconcileSelect`, `uiValueOf`, `setUIValue`, `controlChanged`, `sliderValue` (now private) and `isTextArea` are
  removed. `controlState`, `adoptControlState`, `controlValue`, `writeControlValue`, `playerChanged` and the
  semantic inputs take their place.
- The renderer's `_defaults`, `_dirty` and `pushDefaults`.
- `UICore.keySlider`'s own page rule.

## As built (2026-11-27)

- `src/engine/ui/formModel.ts`: the model. `UICore` calls `controlState` as it first sees a control, `settleSelect`
  for each select at the start of `sync` (the routing core only; a passive core never writes), `playerTyped` for a
  field's typing, and `dragSlider`, `pageSlider`, `sliderToEnd` and `stepNumberField` for slider drags and keys.
  `navigation.ts` calls `stepSlider`, `checkByPlayer` and `chosenOptions`. `elementKinds.textRunOf` reads the pure
  `selectLabel`.
- `src/plugins/ui/svelte/renderer.ts`: each node has `_form: FormControlState`. `setDefault`,
  `textAreaContentChanged` and `optionDefaultChanged` ask it whether the current value follows. `handOverState`
  adopts it when the element is made. `askForReset` runs `selectedness`. State writes to a made element go through
  `writeControl`.
- `src/engine/ui/host/UIHost.ts`: `UIHostElement.value` reads `controlValue` and writes `writeControlValue`; content
  attributes are as before.
- Tests: `src/engine/tests/formModel.test.ts` drives the model's interface. It covers:
  - measuring a select changes nothing (`textRunOf` and `selectLabel`), and settling is the write;
  - a select with nothing chosen;
  - script writes (value, option, radio group);
  - the selectedness rule;
  - `defaultWritten`'s dirty rules;
  - reset restoring defaults and clearing dirty flags;
  - slider step, page and end inputs.

  `engine/tests/uiForms.test.ts` (driven as a player) and `plugins/ui/runtime/uiViewForms*.test.ts` (Svelte binding
  wiring) are unchanged and pass.
- The Svelte conformance run stays at 1278 of 1278 in scope.

**Follow-up (2026-11-27).** The gaps this record left are closed:

- **Content attributes go through the model.** The ordering problem that made the first try fail was that a select's
  `multiple` (and a radio's `name`) reached the element only at its first restyle, after its options were made. They
  are content attributes now (`elementKinds`: `Select` `["multiple", "value"]`, `Radio` `["name", "checked"]`), written
  in the kind table's order as the element is made, so they're on it before its options exist or its `checked`
  applies, as HTML's attributes are before the parser inserts children. The kind table names each control's
  **default attribute** (`uiDefaultAttribute`: `value` for fields and sliders, `checked` for checkboxes and radios,
  `selected` for options; it replaces the `defaults` flag). The UI host hands that attribute to the model's
  `defaultAttributeWritten`: as in HTML the attribute is the default, and the current value follows it only while the
  control isn't dirty; following is a DOM-property write, so a radio checked unchecks its group and an option chosen in
  a single select unchooses the others at once (the routing core's settle stays as the backstop). Behaviour change, towards HTML:
  in markup, the last checked radio of a group and the last `selected` option of a single select win at once.
- **The renderer maps Svelte's property writes as properties.** `value={x}` and `checked={x}` after the template
  (Svelte's `set_value`/`set_checked`) write the current value through the node's `value`/`checked` (dirty) and are no
  longer attributes, so they don't move the default; the template's attribute stays the node's attribute and default.
- **HTML's stepping is written once**, in the model: `stepValue(value, n, rule)` on a `StepRule` from `htmlStepRule`
  (step base `min`, else the default value, else 0; a range's 0..100; `step="any"` has no allowed step). A value off
  the steps moves only to the nearest step that way; the result is put at the largest (smallest) step-aligned value in
  range; nothing changes if that moves it the wrong way. `stepNumberField` (a number field's arrows) and the renderer's
  `stepUp()`/`stepDown()` call it; `stepUp(-n)` steps down, as browsers do. Behaviour change: a number field's arrow
  past `max` stops at the top step in range instead of `max` (`min="0" max="3" step="2"`: 2, not 3), and an empty field
  steps from 0, then into range. `uiForms.test.ts`'s number-field test now expects HTML's values.
- **A select's choice by value is written once** (`optionsWithValue`): the model's settle, the renderer node's
  `value` setter and its Svelte `select_option` (`chooseBound`) use it. The renderer's lists of tags that keep a value or
  a checked state when an element is made again, and its default-attribute checks, read `uiDefaultAttribute`.
- Tests: `formModel.test.ts` adds HTML's stepping and the default content attributes (a `multiple` select keeps every
  `selected` option; a single select and a radio group keep the last). Conformance stays 1278 of 1278 in scope.

## References

- HTML Standard §4.10: the select element's selectedness setting algorithm, the dirty value and dirtiness flags,
  and the reset algorithm.
- Chromium `RangeInputType::HandleKeydownEvent`: arrow and page steps.
