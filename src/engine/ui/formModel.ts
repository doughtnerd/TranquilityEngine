/**
 * The form-control model (ADR 0436, on 0428): what HTML's form elements are and do, on the UI core's components. It owns
 * a control's state rules (value, checked, selected; defaults and HTML's dirty flags; a select's selectedness) and its
 * behaviour (activation, stepping, submit and reset), so the UI core's routing and navigation only translate keys and
 * presses into its inputs, and the Svelte renderer only maps `defaultValue` and `bind:` onto it. Renderer-neutral;
 * nothing here is public API.
 *
 * Its interface:
 * - **Reads** are pure: `controlValue`, `selectLabel`, `selectLabels`, `chosenOptions`, the trees (`formOf`,
 *   `optionsOf`, `selectOf`, `radioGroup`, `labelledControl`). Measuring or drawing a control never changes it.
 * - **Writes**: a default written (`FormControlState.defaultWritten`: the current value follows only while nothing has
 *   changed it), a script's write (`writeControl`, `writeControlValue`, with `FormControlState.wrote` for its dirty
 *   flag; the UI core's sync settles fields a script wrote straight to a select, `settleSelect`), a player's change (`playerTyped`, `dragSlider`, and the semantic inputs
 *   below, which send `input` then `change`) and a form's reset (`resetForm`).
 * - **Semantic inputs**: `stepSlider` (n steps), `pageSlider` (n pages), `sliderToEnd`, `stepNumberField`,
 *   `checkByPlayer`, `activateControl` (what a click, Space or Enter does) and the click record that carries it.
 *
 * - **Changes by the player** send `input` then `change` (bubbling, ADR 0426) on the control, make its polled `changed`
 *   true for the frame and set its dirty flag; a field's (a number field stepped by its arrow keys) is a field change
 *   as typing is. A script writing a field never counts as the player's.
 * - **Events these send** are dispatched at once while the frame's events are being dispatched (a default action's) or
 *   after they were (a script in `update`), else with the frame's events (navigation, in the input phase).
 * - **Selects** keep their `value` and their options' `selected` in step: a written `value` chooses the option with that
 *   value; options' `selected` written (markup, a script) set `value`; with nothing chosen the first enabled option is,
 *   with several the last chosen is (HTML's selectedness, `selectedness`, which the renderer's nodes use too).
 * - **Groups**: radios with one `name` in one form (or, outside forms, one canvas) are one group.
 * - **Reset** puts each control in the form back to its defaults (`FormControlState`) and clears its dirty flags: as the
 *   UI core first saw it, unless its front end hands it a state of its own (`adoptControlState`: the Svelte renderer's
 *   nodes keep HTML's `defaultValue`, `defaultChecked` and options' `selected` attributes in one before they're made).
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
  UIPanel,
  UIRadio,
  UISelect,
  UISlider,
  UIText,
  UIToggle,
  isFocusableUI,
  type UIComponentType,
  type UIFocusableElement,
} from "./components";
import { uiInteractions } from "./interactions";
import { dispatchUIEventNow, fireUIEvent, uiEventRecord, type UIEventData, type UIEventRecord } from "./events";

// --- Trees -----------------------------------------------------------------------------------------

/** The form control on a node (its UI element, when that takes focus: every control is a panel), or null. */
function controlOn(node: GameObject): UIFocusableElement | null {
  const c = node.getComponent(UIPanel);
  return isFocusableUI(c) ? c : null;
}

/** A control that keeps a click to itself (a field or a slider takes it as focus or a drag; nothing activates). */
function keepsClick(c: UIComponentType): boolean {
  return c instanceof UIInputField || c instanceof UISlider;
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

/**
 * HTML's selectedness setting algorithm for a single select (the one place it's written; the renderer's nodes run it
 * too): of the options `chosen`, one stays (the last of `preferred` among them, else the last); none chosen chooses the
 * first `enabled` option (none when no option is). Returns the options to be chosen.
 */
export function selectedness<T>(options: readonly T[], chosen: readonly T[], enabled: (o: T) => boolean, preferred: readonly T[] = []): T[] {
  if (chosen.length > 1) {
    const fresh = chosen.filter((o) => preferred.includes(o));
    return [fresh.length ? fresh[fresh.length - 1] : chosen[chosen.length - 1]];
  }
  if (chosen.length === 1) return [chosen[0]];
  const first = options.find(enabled);
  return first === undefined ? [] : [first];
}

/** Each select's value and options' choice as last settled, to tell which side a script changed since. */
const selectStates = new WeakMap<UISelect, { value: string; chosen: readonly UIOption[] }>();

/**
 * What a select's choice is, read without changing anything: a `value` written since it was last settled (or given
 * before the first look) chooses the option(s) with it (the first only, without `multiple`); else its options'
 * `selected`. A single select then keeps one (markup's last wins; a script's new choice is the one not chosen before).
 */
function selectChoice(select: UISelect): { options: UIOption[]; chosen: UIOption[]; value: string } {
  const options = optionsOf(select);
  const last = selectStates.get(select);
  let chosen: UIOption[];
  if (last ? select.value !== last.value : select.value !== "") {
    chosen = [];
    for (const o of options) if (optionValue(o) === select.value && (select.multiple || !chosen.length)) chosen.push(o);
  } else chosen = options.filter((o) => o.selected);
  if (!select.multiple) chosen = selectedness(options, chosen, (o) => o.interactable, chosen.filter((o) => !last?.chosen.includes(o)));
  return { options, chosen, value: chosen.length ? optionValue(chosen[0]) : "" };
}

/**
 * Settle a select's `value` and its options' `selected` (see `selectChoice`): a script's write to either is put in step.
 * The UI core calls it for every select each sync, before layout reads its label. Returns its chosen options.
 */
export function settleSelect(select: UISelect): UIOption[] {
  const { options, chosen, value } = selectChoice(select);
  for (const o of options) {
    const on = chosen.includes(o);
    if (o.selected !== on) o.selected = on;
  }
  if (select.value !== value) select.value = value;
  selectStates.set(select, { value, chosen });
  return chosen;
}

/** A select's chosen options, as settling would leave them (a pure read). */
export function chosenOptions(select: UISelect): UIOption[] {
  return selectChoice(select).chosen;
}

/** The label a select shows: its chosen option's (a pure read: measuring a select never changes it). */
export function selectLabel(select: UISelect): string {
  const chosen = chosenOptions(select);
  return chosen.length ? optionLabel(chosen[0]) : "";
}

/** The labels of a select's options (what its width fits). */
export function selectLabels(select: UISelect): string[] {
  return optionsOf(select).map(optionLabel);
}

/** Choose `option` (with `multiple`, toggle it). Returns whether anything changed. */
function chooseOption(select: UISelect, option: UIOption): boolean {
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
function checkRadio(r: UIRadio): boolean {
  for (const other of radioGroup(r)) if (other !== r && other.checked) other.checked = false;
  if (r.checked) return false;
  r.checked = true;
  return true;
}

/** The player checks `r` (navigation's arrows through its group): its group unchecks, and a change is sent when it wasn't checked. */
export function checkByPlayer(world: World, r: UIRadio): void {
  if (checkRadio(r)) playerChanged(world, r);
}

// --- Sliders and number fields ---------------------------------------------------------------------

/** `v` on a slider's scale: snapped to its steps from `min`, within `min`..`max`. */
function sliderValue(s: UISlider, v: number): number {
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

/** One step of a slider's: its `step`, else (`step="any"`) a hundredth of its range, as browsers' arrow keys. */
function sliderStep(s: UISlider): number {
  return Number.isFinite(s.step) && s.step > 0 ? s.step : (s.max - s.min) / 100;
}

/**
 * The player moves a slider to `v` (snapped to its steps, within its range): its dirty flag is set. Returns whether the
 * value changed. A drag's caller sends its `input` itself (`change` follows on release); the keys' inputs below send both.
 */
export function dragSlider(s: UISlider, v: number): boolean {
  const next = sliderValue(s, v);
  if (next === s.value) return false;
  s.value = next;
  controlState(s)?.wrote("value");
  return true;
}

function keySlider(world: World, s: UISlider, to: (s: UISlider) => number): void {
  if (s.interactable && dragSlider(s, to(s))) playerChanged(world, s);
}

/** The player steps a slider `n` steps (an arrow key: its `step`, browsers' rule, snapped). Nothing when it isn't interactable. */
export function stepSlider(world: World, s: UISlider, n: number): void {
  keySlider(world, s, (x) => x.value + n * sliderStep(x));
}

/** The player moves a slider `n` pages (Page Up/Down): a tenth of its range, at least one step (browsers'), snapped. */
export function pageSlider(world: World, s: UISlider, n: number): void {
  keySlider(world, s, (x) => x.value + n * Math.max((x.max - x.min) / 10, sliderStep(x)));
}

/** The player moves a slider to an end (Home: `min`, End: `max`). */
export function sliderToEnd(world: World, s: UISlider, end: "min" | "max"): void {
  keySlider(world, s, (x) => x[end]);
}

/** The player steps a number field's value by `steps` of its `step`, within `min`/`max` (its arrow keys); a change is a field change. */
export function stepNumberField(world: World, field: UIInputField, steps: number): void {
  const step = Number.isFinite(field.step) && field.step > 0 ? field.step : 1;
  const now = Number(field.value);
  // An empty (or unreadable) value steps from `min`, else 0, as browsers do.
  const from = field.value.trim() !== "" && Number.isFinite(now) ? now : (field.min ?? 0);
  let v = from + steps * step;
  if (field.max !== null && Number.isFinite(field.max)) v = Math.min(v, field.max);
  if (field.min !== null && Number.isFinite(field.min)) v = Math.max(v, field.min);
  const text = String(Number(v.toFixed(10)));
  if (text === field.value) return;
  field.value = text;
  playerChanged(world, field);
}

/** The player typed into a field: its value, and its dirty flag (the `input` is the typing's own). */
export function playerTyped(field: UIInputField, text: string): void {
  field.value = text;
  controlState(field)?.wrote("value");
}

// --- State: defaults and dirty flags ---------------------------------------------------------------

/** A control's state that HTML keeps beside its value: what is dirty (changed by a script or the player). */
export type FormField = "value" | "checked" | "selected";

/**
 * A control's defaults (what its form's reset puts back: HTML's default value, default checkedness and an option's
 * `selected` attribute) and HTML's dirty flags. One per control: the UI core makes one as it first sees a control (its
 * state as built), or a front end hands over its own (`adoptControlState`), which it keeps before the control is made.
 */
export class FormControlState {
  /** The defaults; one not given resets to HTML's (an empty value, unchecked, not chosen; a slider to its value as built). */
  readonly defaults: { value?: string | number; checked?: boolean; indeterminate?: boolean; selected?: boolean } = {};
  /** HTML's dirty flags: the field was changed by a script, a binding or the player since the last reset. */
  readonly dirty: Record<FormField, boolean> = { value: false, checked: false, selected: false };
  /** @internal What the control was built with, for defaults its front end didn't give (a slider's value, a checkbox's indeterminate). */
  built: { value?: number; indeterminate?: boolean } = {};

  /**
   * A new default for `field`. Returns whether the current value (`current`) follows it: only while nothing changed it
   * (HTML's dirty flags; a value or checkedness that isn't its last default any more counts as changed). `keep` holds it
   * anyway (Svelte's `set_default_value` keeps a value its template gave).
   */
  defaultWritten(field: FormField, value: string | boolean, current: unknown, keep = false): boolean {
    const was = this.defaults[field];
    const follows = !keep && !this.dirty[field] && (field === "selected" || was === undefined || current === was);
    (this.defaults as Record<FormField, unknown>)[field] = value;
    return follows;
  }

  /** A script, a binding or the player changed `field`: a new default leaves it until the form is reset. */
  wrote(field: FormField): void {
    this.dirty[field] = true;
  }
}

const states = new WeakMap<UIComponentType, FormControlState>();

/** True for the controls a form's reset puts back. */
function hasDefaults(c: UIComponentType): boolean {
  return c instanceof UIToggle || c instanceof UIRadio || c instanceof UISlider || c instanceof UIInputField || c instanceof UIOption;
}

/** A control's state (made from the control as it is now when there's none yet: the UI core calls it as it first sees one); null for elements without defaults. */
export function controlState(c: UIComponentType): FormControlState | null {
  const had = states.get(c);
  if (had || !hasDefaults(c)) return had ?? null;
  const s = new FormControlState();
  const d = s.defaults;
  if (c instanceof UIToggle) Object.assign(d, { checked: c.checked, indeterminate: c.indeterminate });
  else if (c instanceof UIRadio) d.checked = c.checked;
  else if (c instanceof UISlider || c instanceof UIInputField) d.value = c.value;
  else if (c instanceof UIOption) d.selected = c.selected;
  states.set(c, s);
  return s;
}

/** A front end's state for a control it made (its defaults, given before the control existed, are the ones its reset uses). */
export function adoptControlState(c: UIComponentType, state: FormControlState): void {
  if (!hasDefaults(c)) return;
  state.built = { value: c instanceof UISlider ? c.value : undefined, indeterminate: c instanceof UIToggle ? c.indeterminate : undefined };
  states.set(c, state);
}

/** Put a control back to its defaults (HTML's reset algorithm for it), clearing its dirty flags. */
function resetControl(c: UIComponentType, s: FormControlState): void {
  const d = s.defaults;
  if (c instanceof UIToggle) {
    c.checked = d.checked ?? false;
    c.indeterminate = d.indeterminate ?? s.built.indeterminate ?? c.indeterminate;
  } else if (c instanceof UIRadio) c.checked = d.checked ?? false;
  else if (c instanceof UISlider) c.value = sliderValue(c, Number(d.value ?? s.built.value ?? c.value));
  else if (c instanceof UIInputField) c.value = String(d.value ?? "");
  else if (c instanceof UIOption) c.selected = d.selected ?? false;
  s.dirty.value = s.dirty.checked = s.dirty.selected = false;
}

/** Put every control in `form` back to its defaults (HTML's reset algorithm), without events. */
export function resetForm(form: UIForm): void {
  const selects = new Set<UISelect>();
  for (const n of descendants(form.owner)) {
    const c = controlOn(n);
    const s = c ? states.get(c) : undefined;
    if (!c || !s) continue;
    resetControl(c, s);
    if (c instanceof UIOption) {
      const select = selectOf(c);
      if (select) selects.add(select);
    }
  }
  for (const select of selects) {
    const chosen = optionsOf(select).filter((o) => o.selected);
    select.value = chosen.length ? optionValue(chosen[0]) : "";
    // The options' defaults are the choice now (not a written value, which would choose only the options with the
    // first one's value: a `multiple` select's other defaults lost); settling still chooses a single select's first.
    selectStates.set(select, { value: select.value, chosen });
    settleSelect(select);
  }
}

// --- Writes by scripts -----------------------------------------------------------------------------

/**
 * A script (or a front end) writes a control's field, as the DOM's property does: a radio checked unchecks its group, an
 * option chosen in a single select unchooses the others, a select's `value` chooses its option at once. Dirty flags are
 * the caller's (a front end's default reaching a control isn't a change); any other field is written as it is.
 */
export function writeControl(c: UIComponentType, field: string, value: unknown): void {
  if (c instanceof UIRadio && field === "checked" && value === true) return void checkRadio(c);
  if (c instanceof UIOption && field === "selected" && value === true) {
    const select = selectOf(c);
    if (select && !select.multiple) return void chooseOption(select, c);
  }
  (c as unknown as Record<string, unknown>)[field] = value;
  if (c instanceof UISelect && field === "value") settleSelect(c);
}

// --- Labels ----------------------------------------------------------------------------------------

/** The control a label labels: the one `for` names (by id, in its canvas), else the first one inside it. */
export function labelledControl(label: UILabel): UIFocusableElement | null {
  if (label.for) {
    for (const n of descendants(canvasNodeOf(label))) {
      if (n.name !== label.for) continue;
      const c = controlOn(n);
      if (c && !(c instanceof UIOption)) return c;
    }
    return null;
  }
  for (const n of descendants(label.owner)) {
    const c = controlOn(n);
    if (c && !(c instanceof UIOption)) return c;
  }
  return null;
}

// --- Activation: what a click, submit or a label does ---------------------------------------------

/** The player changed `c`: its dirty flag, `input` then `change`, and its polled `changed` this frame. */
export function playerChanged(world: World, c: UIFocusableElement): void {
  markChanged(c);
  uiInteractions(world).publishPolled("change", c);
  if (c instanceof UIInputField) {
    // A field's change is its typing's (the front ends make it `input`, and `change` once committed).
    fireUIEvent(world, { type: "change", target: c, bubbles: false, cancelable: false, data: {}, prevented: false });
  } else {
    fireUIEvent(world, uiEventRecord("input", c));
    fireUIEvent(world, uiEventRecord("change", c));
  }
}

/** A player's change's dirty flag: a field's or slider's value, a checkbox's or radio's checkedness, a select's chosen options. */
function markChanged(c: UIFocusableElement): void {
  if (c instanceof UISelect) for (const o of optionsOf(c)) if (o.selected) controlState(o)?.wrote("selected");
  controlState(c)?.wrote(c instanceof UIToggle || c instanceof UIRadio ? "checked" : "value");
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
    playerChanged(world, c);
  } else if (c instanceof UIRadio) {
    if (checkRadio(c)) playerChanged(world, c);
  } else if (c instanceof UISelect) {
    setSelectOpen(c, !c.open);
  } else if (c instanceof UIOption) {
    const select = selectOf(c);
    if (!select || !select.interactable) return;
    const changed = chooseOption(select, c);
    if (!select.multiple) setSelectOpen(select, false);
    if (changed) playerChanged(world, select);
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
      else if (undo && c.node.isValid) playerChanged(world, c);
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
    if (c) return keepsClick(c) ? null : c;
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
      if (!keepsClick(c)) activateControl(world, c);
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
  if (keepsClick(c) || c instanceof UISelect) {
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
export function controlValue(c: UIComponentType): string | null {
  if (c instanceof UIInputField || c instanceof UISelect || c instanceof UIToggle || c instanceof UIRadio) return c.value;
  if (c instanceof UISlider) return String(c.value);
  if (c instanceof UIOption) return optionValue(c);
  if (c instanceof UIProgress) return String(c.value ?? 0);
  if (c instanceof UIMeter) return String(c.value);
  return null;
}

/**
 * A script writes a control's value from text, as the DOM's `value` does (a slider, bar or meter reads it as a number;
 * a select chooses the option with it), through `writeControl`. Not a player change; dirty flags are the caller's.
 */
export function writeControlValue(c: UIComponentType, value: string): void {
  if (c instanceof UISlider) writeControl(c, "value", sliderValue(c, Number(value)));
  else if (c instanceof UIProgress || c instanceof UIMeter) {
    const n = Number(value);
    c.value = value.trim() !== "" && Number.isFinite(n) ? n : c instanceof UIMeter ? 0 : null;
  } else if (c instanceof UIInputField || c instanceof UISelect || c instanceof UIToggle || c instanceof UIRadio || c instanceof UIOption) writeControl(c, "value", value);
}
