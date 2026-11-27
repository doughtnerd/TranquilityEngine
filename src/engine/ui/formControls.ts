/**
 * Form controls' behaviour (ADR 0428): what HTML's form elements do, on the UI core's components. The UI core's routing
 * (clicks, slider drags, keys), navigation (submit, arrows) and both front ends' scripts (`requestSubmit`, `reset`, the
 * Svelte renderer's bindings) call these, so a checkbox toggles, a radio unchecks its group, a select chooses and a form
 * submits the same way whatever drove it. Renderer-neutral; nothing here is public API.
 *
 * - **Changes by the player** send `input` then `change` (bubbling, ADR 0426) on the control and make its polled
 *   `changed` true for the frame; a field's (a number field stepped by its arrow keys) is a field change as typing is.
 *   A script writing a field never counts.
 * - **Events these send** are dispatched at once while the frame's events are being dispatched (a default action's) or
 *   after they were (a script in `update`), else with the frame's events (navigation, in the input phase).
 * - **Selects** keep their `value` and their options' `selected` in step (`reconcileSelect`): a written `value` chooses
 *   the option with that value; options' `selected` written (markup, a script) set `value`; with nothing chosen the
 *   first enabled option is (HTML's selectedness).
 * - **Groups**: radios with one `name` in one form (or, outside forms, one canvas) are one group.
 * - **Reset** puts each control in the form back to its defaults: as the UI core first saw it (`rememberDefaults`),
 *   unless its front end says what they are (`setUIDefaults`: the Svelte renderer hands over HTML's `defaultValue`,
 *   `defaultChecked` and options' `selected` attributes).
 */
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import {
  UIButton,
  UICanvas,
  UIForm,
  UIInputField,
  UIMeter,
  UIProgress,
  UILabel,
  UIOption,
  UIRadio,
  UISelect,
  UISlider,
  UIText,
  UITextArea,
  UIToggle,
  isFocusableUI,
  type UIComponentType,
  type UIFocusableElement,
} from "./components";
import { uiInteractions } from "./interactions";
import { dispatchUIEventNow, fireUIEvent, uiEventRecord, type UIEventData, type UIEventRecord } from "./events";

// --- Trees -----------------------------------------------------------------------------------------

/** The form control on a node, or null. */
function controlOn(node: GameObject): UIComponentType | null {
  return (node.getComponent(UIToggle) ?? node.getComponent(UIRadio) ?? node.getComponent(UISlider) ?? node.getComponent(UISelect) ?? node.getComponent(UIOption) ?? node.getComponent(UIInputField) ?? node.getComponent(UIButton) ?? null) as UIComponentType | null;
}

/** Each node under `root` (not `root`), depth first in order. */
function* descendants(root: GameObject): Generator<GameObject> {
  for (const child of root.children) {
    if (!child.isValid) continue;
    yield child;
    yield* descendants(child);
  }
}

/** The nearest `UIForm` at or above `c`'s node, below its canvas; null outside forms. */
export function formOf(c: UIComponentType): UIForm | null {
  for (let n: GameObject | null = c.owner; n?.isValid; n = n.parent) {
    if (n.getComponent(UICanvas)) return null;
    const f = n.getComponent(UIForm);
    if (f) return f;
  }
  return null;
}

/** The node of the canvas `c` is in (or its topmost node when there's none). */
function canvasNodeOf(c: UIComponentType): GameObject {
  let top = c.owner;
  for (let n: GameObject | null = c.owner; n?.isValid; n = n.parent) {
    if (n.getComponent(UICanvas)) return n;
    top = n;
  }
  return top;
}

// --- Selects ---------------------------------------------------------------------------------------

/** A select's options, in order (nested ones too, as inside an `<optgroup>`); not inside another select. */
export function optionsOf(select: UISelect): UIOption[] {
  const out: UIOption[] = [];
  const walk = (n: GameObject) => {
    for (const child of n.children) {
      if (!child.isValid || child.getComponent(UISelect)) continue;
      const o = child.getComponent(UIOption);
      if (o && !o._destroyed) out.push(o);
      else walk(child);
    }
  };
  walk(select.owner);
  return out;
}

/** The select an option is in, or null. */
export function selectOf(option: UIOption): UISelect | null {
  for (let n = option.owner.parent; n?.isValid; n = n.parent) {
    const s = n.getComponent(UISelect);
    if (s) return s;
    if (n.getComponent(UICanvas)) return null;
  }
  return null;
}

/** An option's label: its `label`, else the text of the texts inside it, joined. */
export function optionLabel(o: UIOption): string {
  if (o.label) return o.label;
  const parts: string[] = [];
  for (const n of descendants(o.owner)) {
    const t = n.getComponent(UIText);
    if (t?.text) parts.push(t.text);
  }
  return parts.join(" ");
}

/** What choosing an option makes its select's value: its `value`, else its label. */
export function optionValue(o: UIOption): string {
  return o.value !== "" ? o.value : optionLabel(o);
}

/** Each select's value and options' choice as last put in step, to tell which side changed since. */
const selectStates = new WeakMap<UISelect, { value: string; chosen: readonly UIOption[] }>();

/** Put a select's `value` and its options' `selected` in step (see the head comment). Returns its chosen options. */
export function reconcileSelect(select: UISelect): UIOption[] {
  const options = optionsOf(select);
  const last = selectStates.get(select);
  if (last ? select.value !== last.value : select.value !== "") {
    // The value was written (or given before the first look): the option(s) with it are chosen (the first only, without `multiple`).
    let found = false;
    for (const o of options) {
      const on: boolean = optionValue(o) === select.value && (select.multiple || !found);
      if (o.selected !== on) o.selected = on;
      found ||= on;
    }
  }
  let chosen = options.filter((o) => o.selected);
  if (!select.multiple && chosen.length > 1) {
    // One choice: the one chosen last (markup's last wins; a script's new choice is the one not chosen before).
    const fresh = chosen.filter((o) => !last?.chosen.includes(o));
    const keep = fresh.length ? fresh[fresh.length - 1] : chosen[chosen.length - 1];
    for (const o of chosen) if (o !== keep) o.selected = false;
    chosen = [keep];
  }
  if (!select.multiple && !chosen.length) {
    const first = options.find((o) => o.interactable);
    if (first) {
      first.selected = true;
      chosen = [first];
    }
  }
  const value = chosen.length ? optionValue(chosen[0]) : "";
  if (select.value !== value) select.value = value;
  selectStates.set(select, { value, chosen });
  return chosen;
}

/** The label a select shows: its chosen option's. */
export function selectLabel(select: UISelect): string {
  const chosen = reconcileSelect(select);
  return chosen.length ? optionLabel(chosen[0]) : "";
}

/** The labels of a select's options (what its width fits). */
export function selectLabels(select: UISelect): string[] {
  return optionsOf(select).map(optionLabel);
}

/** Choose `option` (with `multiple`, toggle it). Returns whether anything changed. */
export function chooseOption(select: UISelect, option: UIOption): boolean {
  const options = optionsOf(select);
  let changed = false;
  if (select.multiple) {
    option.selected = !option.selected;
    changed = true;
  } else {
    for (const o of options) {
      const on = o === option;
      if (o.selected !== on) {
        o.selected = on;
        changed = true;
      }
    }
  }
  const chosen = options.filter((o) => o.selected);
  select.value = chosen.length ? optionValue(chosen[0]) : "";
  selectStates.set(select, { value: select.value, chosen });
  return changed;
}

/** Open or close a select's list. Closing it while focus is on one of its options gives focus back to it. */
export function setSelectOpen(select: UISelect, open: boolean): void {
  if (select.open === open) return;
  select.open = open;
  if (open) return;
  const log = uiInteractions(select._world);
  if (log.focused instanceof UIOption && selectOf(log.focused) === select) log.focus(select, "script");
}

// --- Radios ----------------------------------------------------------------------------------------

/** A radio's group: the radios with its `name` in its form (outside forms, its canvas). Itself alone without a name. */
export function radioGroup(r: UIRadio): UIRadio[] {
  if (!r.name) return [r];
  const form = formOf(r);
  const root = form?.owner ?? canvasNodeOf(r);
  const out: UIRadio[] = [];
  for (const n of descendants(root)) {
    const other = n.getComponent(UIRadio);
    if (other && other.name === r.name && formOf(other) === form) out.push(other);
  }
  return out.includes(r) ? out : [r, ...out];
}

/** Check `r`, unchecking the rest of its group. Returns whether it wasn't checked. */
export function checkRadio(r: UIRadio): boolean {
  for (const other of radioGroup(r)) if (other !== r && other.checked) other.checked = false;
  if (r.checked) return false;
  r.checked = true;
  return true;
}

// --- Sliders and number fields ---------------------------------------------------------------------

/** `v` on a slider's scale: snapped to its steps from `min`, within `min`..`max`. */
export function sliderValue(s: UISlider, v: number): number {
  const min = Number.isFinite(s.min) ? s.min : 0;
  const max = Number.isFinite(s.max) && s.max >= min ? s.max : min;
  let x = Number.isFinite(v) ? Math.min(Math.max(v, min), max) : min;
  if (Number.isFinite(s.step) && s.step > 0) {
    x = min + Math.round((x - min) / s.step) * s.step;
    if (x > max) x -= s.step; // a step past the top doesn't fit
    x = Number(x.toFixed(10)); // 0.1 + 0.2 is 0.3 here
  }
  return x;
}

/** A slider's value as a fraction of its range (0 at `min`, 1 at `max`). */
export function sliderFraction(s: UISlider): number {
  const range = s.max - s.min;
  return range > 0 ? Math.min(1, Math.max(0, (s.value - s.min) / range)) : 0;
}

/** Step a number field's value by `steps` of its `step`, within `min`/`max`. Returns whether it changed. */
export function stepNumberField(field: UIInputField, steps: number): boolean {
  const step = Number.isFinite(field.step) && field.step > 0 ? field.step : 1;
  const now = Number(field.value);
  // An empty (or unreadable) value steps from `min`, else 0, as browsers do.
  const from = field.value.trim() !== "" && Number.isFinite(now) ? now : (field.min ?? 0);
  let v = from + steps * step;
  if (field.max !== null && Number.isFinite(field.max)) v = Math.min(v, field.max);
  if (field.min !== null && Number.isFinite(field.min)) v = Math.max(v, field.min);
  const text = String(Number(v.toFixed(10)));
  if (text === field.value) return false;
  field.value = text;
  return true;
}

// --- Defaults and reset ----------------------------------------------------------------------------

const defaults = new WeakMap<UIComponentType, Readonly<Record<string, unknown>>>();

/** Note a control's state as it was built, for its form's reset (the UI core does when it first sees an element). */
export function rememberDefaults(c: UIComponentType): void {
  if (defaults.has(c)) return;
  if (c instanceof UIToggle) defaults.set(c, { checked: c.checked, indeterminate: c.indeterminate });
  else if (c instanceof UIRadio) defaults.set(c, { checked: c.checked });
  else if (c instanceof UISlider) defaults.set(c, { value: c.value });
  else if (c instanceof UIInputField) defaults.set(c, { value: c.value });
  else if (c instanceof UIOption) defaults.set(c, { selected: c.selected });
}

/**
 * Change what a control's form reset puts back (ADR 0428; HTML's `defaultValue`, `defaultChecked` and an option's
 * `selected` attribute, which can change after the control is built): only the fields the control has a default for.
 */
export function setUIDefaults(c: UIComponentType, values: { value?: string; checked?: boolean; selected?: boolean }): void {
  rememberDefaults(c);
  const d = defaults.get(c);
  if (!d) return;
  const next: Record<string, unknown> = { ...d };
  if (values.value !== undefined && "value" in d) next.value = c instanceof UISlider ? sliderValue(c, Number(values.value)) : values.value;
  if (values.checked !== undefined && "checked" in d) next.checked = values.checked;
  if (values.selected !== undefined && "selected" in d) next.selected = values.selected;
  defaults.set(c, next);
}

/** Put every control in `form` back as it was built (HTML's reset algorithm), without events. */
export function resetForm(form: UIForm): void {
  const selects = new Set<UISelect>();
  for (const n of descendants(form.owner)) {
    const c = controlOn(n);
    const d = c ? defaults.get(c) : undefined;
    if (!c || !d) continue;
    Object.assign(c, d);
    if (c instanceof UIOption) {
      const s = selectOf(c);
      if (s) selects.add(s);
    }
  }
  for (const s of selects) {
    const chosen = optionsOf(s).filter((o) => o.selected);
    s.value = chosen.length ? optionValue(chosen[0]) : "";
    // The options' defaults are the choice now (not a written value, which would choose only the options with the
    // first one's value: a `multiple` select's other defaults lost); reconciling still chooses a single select's first.
    selectStates.set(s, { value: s.value, chosen });
    reconcileSelect(s);
  }
}

// --- Labels ----------------------------------------------------------------------------------------

/** The control a label labels: the one `for` names (by id, in its canvas), else the first one inside it. */
export function labelledControl(label: UILabel): UIFocusableElement | null {
  if (label.for) {
    for (const n of descendants(canvasNodeOf(label))) {
      if (n.name !== label.for) continue;
      const c = controlOn(n);
      if (c && isFocusableUI(c) && !(c instanceof UIOption)) return c;
    }
    return null;
  }
  for (const n of descendants(label.owner)) {
    const c = controlOn(n);
    if (c && isFocusableUI(c) && !(c instanceof UIOption)) return c;
  }
  return null;
}

// --- Activation: what a click, submit or a label does ---------------------------------------------

/** The player changed `c`: `input` then `change`, and its polled `changed` this frame. */
export function controlChanged(world: World, c: UIFocusableElement): void {
  uiInteractions(world).publishPolled("change", c);
  if (c instanceof UIInputField) {
    // A field's change is its typing's (the front ends make it `input`, and `change` once committed).
    fireUIEvent(world, { type: "change", target: c, bubbles: false, cancelable: false, data: {}, prevented: false });
  } else {
    fireUIEvent(world, uiEventRecord("input", c));
    fireUIEvent(world, uiEventRecord("change", c));
  }
}

/** Send a form's `submit` (Enter in one of its fields, a submit button, `requestSubmit`). */
export function submitForm(world: World, form: UIForm, afterFrameEvents = false): void {
  const log = uiInteractions(world);
  log.publishPolled("submit", form);
  // Enter's (a keydown's default action): after the frame's other events, so the field's own `submit` comes first.
  if (afterFrameEvents) log.emit(uiEventRecord("submit", form));
  else fireUIEvent(world, uiEventRecord("submit", form));
}

/** Send a form's `reset`; unless a handler prevents it, its controls go back as they were built. */
export function resetFormEvent(world: World, form: UIForm): void {
  fireUIEvent(world, uiEventRecord("reset", form, {}, (prevented) => {
    if (!prevented) resetForm(form);
  }));
}

/**
 * Activate a control, as a click on it (or `submit` on it, or a click on its label) does: a checkbox toggles, a radio
 * checks, a select opens or closes, an option is chosen, a button submits or resets its form. Nothing for a control
 * that isn't interactable, and for fields and sliders (focus is how they're activated).
 */
export function activateControl(world: World, c: UIComponentType): void {
  if (!isFocusableUI(c) || !c.interactable || !c.isActiveAndEnabled) return;
  if (c instanceof UIToggle) {
    c.checked = !c.checked;
    c.indeterminate = false;
    controlChanged(world, c);
  } else if (c instanceof UIRadio) {
    if (checkRadio(c)) controlChanged(world, c);
  } else if (c instanceof UISelect) {
    setSelectOpen(c, !c.open);
  } else if (c instanceof UIOption) {
    const select = selectOf(c);
    if (!select || !select.interactable) return;
    const changed = chooseOption(select, c);
    if (!select.multiple) setSelectOpen(select, false);
    if (changed) controlChanged(world, select);
  } else if (c instanceof UIButton) {
    const form = formOf(c);
    if (!form) return;
    if (c.type === "submit") submitForm(world, form);
    else if (c.type === "reset") resetFormEvent(world, form);
  }
}

/**
 * A `click` record on `target` with HTML's activation (ADR 0428, as the conformance triage amended it): a checkbox or
 * radio the click activates changes before the click's handlers run (HTML's legacy pre-activation), so they read the new
 * state, and changes back if one prevents the click; else `input` and `change` follow. Every other activation (an option
 * chosen, a select opened, a form submitted or reset, a label's click sent on) is the click's default action, as before.
 */
export function uiClickRecord(world: World, target: UIComponentType, data: UIEventData = {}, after?: (prevented: boolean) => void): UIEventRecord {
  const c = activatedControl(target);
  if (!(c instanceof UIToggle) && !(c instanceof UIRadio)) {
    return uiEventRecord("click", target, data, (prevented) => {
      // A handler may have removed what was clicked: nothing is left to activate.
      if (!prevented && target.node.isValid) clickDefault(world, target, data);
      after?.(prevented);
    });
  }
  let undo: (() => void) | null = null;
  return uiEventRecord(
    "click",
    target,
    data,
    (prevented) => {
      if (prevented) undo?.();
      else if (undo && c.node.isValid) controlChanged(world, c);
      after?.(prevented);
    },
    () => {
      if (!c.interactable || !c.isActiveAndEnabled) return;
      if (c instanceof UIToggle) {
        const was = { checked: c.checked, indeterminate: c.indeterminate };
        c.checked = !c.checked;
        c.indeterminate = false;
        undo = () => {
          c.checked = was.checked;
          c.indeterminate = was.indeterminate;
        };
      } else {
        const previous = radioGroup(c).find((r) => r.checked) ?? null;
        if (!checkRadio(c)) return; // already checked: nothing changes, nothing is sent
        undo = () => {
          c.checked = false;
          if (previous) checkRadio(previous);
        };
      }
    },
  );
}

/**
 * The DOM's `element.click()` on a UI element: a `click` dispatched now (bubbling, cancelable) with its activation, and
 * the events its activation sends (`input`, `change`, `submit`) at once. Nothing on a control that isn't interactable.
 */
export function clickUI(world: World, target: UIComponentType): void {
  if (isFocusableUI(target) && !target.interactable) return;
  dispatchUIEventNow(world, uiClickRecord(world, target));
}

/** The control a click on `target` activates: the nearest control at or above it, else a label's control (null for a field, a slider or nothing). */
function activatedControl(target: UIComponentType): UIComponentType | null {
  for (let n: GameObject | null = target.owner; n?.isValid; n = n.parent) {
    if (n.getComponent(UICanvas)) return null;
    const c = controlOn(n);
    if (c) return c instanceof UIInputField || c instanceof UISlider ? null : c;
    if (n.getComponent(UILabel)) return null; // a label sends a click of its own to its control
  }
  return null;
}

/**
 * A finished click on `target`'s default action (ADR 0426, 0428): the nearest control at or above it activates (an
 * option in its select's list, a checkbox, a radio, a select, a button); a field or slider there takes it (nothing
 * more). Else a label at or above it sends a click to its control, whose own default action follows.
 */
export function clickDefault(world: World, target: UIComponentType, data: UIEventData = {}): void {
  for (let n: GameObject | null = target.owner; n?.isValid; n = n.parent) {
    if (n.getComponent(UICanvas)) return;
    const c = controlOn(n);
    if (c) {
      if (!(c instanceof UIInputField) && !(c instanceof UISlider)) activateControl(world, c);
      return;
    }
    const label = n.getComponent(UILabel);
    if (label) {
      labelActivate(world, label, data);
      return;
    }
  }
}

/** A click on a label: a click on its control (a checkbox toggles, a button clicks…); a field, slider or select takes focus. */
function labelActivate(world: World, label: UILabel, data: UIEventData): void {
  const c = labelledControl(label);
  if (!c || !c.interactable || !c.isActiveAndEnabled) return;
  const log = uiInteractions(world);
  if (c instanceof UIInputField || c instanceof UISlider || c instanceof UISelect) {
    if (c.focusable) log.focus(c, "press", c instanceof UIInputField);
    return;
  }
  fireUIEvent(world, uiClickRecord(world, c, { ...data, detail: 1 }));
}

// --- Values (the front ends' `value`) ----------------------------------------------------------

/**
 * A control's value as text, as the DOM's `value` reads it: a field's text, a select's chosen value, a slider's,
 * progress bar's or meter's number, a checkbox's, radio's or option's `value`; null for other elements.
 */
export function uiValueOf(c: UIComponentType): string | null {
  if (c instanceof UIInputField || c instanceof UISelect || c instanceof UIToggle || c instanceof UIRadio) return c.value;
  if (c instanceof UISlider) return String(c.value);
  if (c instanceof UIOption) return optionValue(c);
  if (c instanceof UIProgress) return String(c.value ?? 0);
  if (c instanceof UIMeter) return String(c.value);
  return null;
}

/** Write a control's value from text (a slider, bar or meter reads it as a number; a select chooses the option with it). Not a player change. */
export function setUIValue(c: UIComponentType, value: string): void {
  if (c instanceof UIInputField || c instanceof UISelect || c instanceof UIToggle || c instanceof UIRadio || c instanceof UIOption) c.value = value;
  else if (c instanceof UISlider) c.value = sliderValue(c, Number(value));
  else if (c instanceof UIProgress || c instanceof UIMeter) {
    const n = Number(value);
    c.value = value.trim() !== "" && Number.isFinite(n) ? n : c instanceof UIMeter ? 0 : null;
  }
}

/** True for a text area (Enter starts a line there instead of submitting). */
export function isTextArea(c: unknown): c is UITextArea {
  return c instanceof UITextArea;
}
