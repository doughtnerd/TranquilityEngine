/**
 * Keyboard and gamepad UI navigation (ADR 0340).
 *
 * - `engine.UIActions` is an engine action set: `navigate` (vec2), `submit`, `cancel`, `next`, `previous`.
 *   Its bindings are the engine context `ui` (not the default context), which is active for a player
 *   only while their World's UI has a focused element (on a canvas that player drives), at
 *   `UI_CONTEXT_PRIORITY`, above game contexts: its arrows, d-pad, Enter and Escape don't also reach
 *   the game, and with nothing focused the game gets every control.
 * - `engine.UINavigation` (input phase, after `engine.InputEvaluate`) acts on them: it moves the
 *   World's one focus (kept in the interaction log, ADR 0309) through the UI core's last layout with a
 *   spatial search or explicit neighbours, in tree order for `next` and `previous`, clicks on `submit`,
 *   and records `cancel` on the canvas. Its events are published for the current frame, which hasn't
 *   run a script yet, so every script phase of the frame sees them.
 * - Canvases trap focus (`modal`), take it when they become active (`autoFocus`, `firstSelected`), and
 *   name the player whose actions drive them (`player`).
 * - ADR 0423: an element scrolled out of its scrolling ancestors' view is still found (by where it is), and focus it
 *   moves to is scrolled into view (`nearest`, smoothly where `scroll-behavior` says so).
 */
import { getDataComponentDef } from "../core/data";
import { defineBuiltinSystem } from "../core/systems";
import type { World } from "../core/World";
import type { GameObject } from "../scene/GameObject";
import { actionView, button, defineActions, vec2 } from "../input/actions";
import type { TriggerSpec } from "../input/contextTypes";
import { addContextSource, defineInputContext } from "../input/contexts";
import { takesLocalInput } from "../input/deviceEntities";
import { playerNodes, InputPlayer } from "../input/players";
import { UIButton, UICanvas, UIInputField, UIOption, UIPanel, UIRadio, UISelect, UISlider, isFocusableUI, type UIFocusableElement } from "./components";
import { uiClickRecord, checkRadio, controlChanged, optionsOf, radioGroup, reconcileSelect, selectOf, setSelectOpen, sliderValue } from "./formControls";
import { uiInteractions, type UIInteractions, type UILayoutSource } from "./interactions";
import type { UILaidOutElement } from "./uiCoreTypes";
import type { UIRect } from "./layout";
import { uiScrollIntoView } from "./scrolling";

/**
 * The part of an element that's drawn (ADR 0418): its box as drawn (wave 3: transformed, so the search uses the
 * transformed box's centre), clipped by its `overflow: hidden` ancestors, as axis-aligned bounds. ADR 0423: scrolling
 * ancestors don't cut it (an element scrolled out of view is where it is, and navigation scrolls it back).
 */
function shownBox(e: UILaidOutElement): UIRect {
  return e.reach ?? e.bounds;
}

/** True when an `overflow: hidden` ancestor clips the element away entirely (or a scale of 0 flattens it), so the player can't see it to pick it. A scrolling ancestor doesn't. */
function clippedAway(e: UILaidOutElement): boolean {
  if ((!e.clip && !e.transform) || e.width <= 0 || e.height <= 0) return false;
  const r = shownBox(e);
  return r.width <= 0 || r.height <= 0;
}

/** The name of the engine context holding `UIActions`' bindings. */
export const UI_CONTEXT = "ui";

/** The `ui` context's priority: above any game context, so a focused menu takes its controls first. */
export const UI_CONTEXT_PRIORITY = 1000;

/** Repeat while held: at once, then after 0.4 s every 0.1 s. */
const REPEAT: readonly TriggerSpec[] = [{ pressed: true }, { pulse: { delay: 0.4, interval: 0.1 } }];

/**
 * The built-in UI actions (ADR 0340), read by `engine.UINavigation`. Their bindings are the `ui`
 * context's (arrow keys, the d-pad and the left stick; Enter, Space and the south button; Escape and
 * the east button; Tab and Shift+Tab), which players rebind like any other context.
 */
export const UIActions = defineActions(
  "engine.UIActions",
  {
    navigate: vec2({ triggers: REPEAT }),
    submit: button(),
    cancel: button(),
    next: button({ triggers: REPEAT }),
    previous: button({ triggers: REPEAT }),
  },
  { key: "uiActions" },
);

const A = (name: string) => `engine.UIActions:${name}`;

defineInputContext({
  name: UI_CONTEXT,
  mappings: [
    { action: A("navigate"), composite: "dpad", up: "<Keyboard>/arrowup", down: "<Keyboard>/arrowdown", left: "<Keyboard>/arrowleft", right: "<Keyboard>/arrowright" },
    { action: A("navigate"), control: "<Gamepad>/dpad" },
    // A stick moves focus only when pushed well over (a resting stick's drift never does).
    { action: A("navigate"), control: "<Gamepad>/leftStick", modifiers: [{ deadzone: { min: 0.5 } }] },
    { action: A("submit"), control: "<Keyboard>/enter" },
    { action: A("submit"), control: "<Keyboard>/space" },
    { action: A("submit"), control: "<Gamepad>/buttonSouth" },
    { action: A("cancel"), control: "<Keyboard>/escape" },
    { action: A("cancel"), control: "<Gamepad>/buttonEast" },
    { action: A("previous"), composite: "modifier", modifier: "<Keyboard>/shift", control: "<Keyboard>/tab" },
    { action: A("next"), control: "<Keyboard>/tab" },
  ],
});

// --- Focus rules --------------------------------------------------------------------------------

/** True for a button or input field that can take focus now (layout aside): focusable, active, enabled, shown, and (buttons) interactable. */
function canFocus(c: UIFocusableElement): boolean {
  if (!c.node.isValid || !c.focusable || !c.isActiveAndEnabled || c.display === "none") return false;
  return c.interactable;
}

const isFocusableComp = isFocusableUI;

/** The UICanvas above an element's node. */
function canvasAbove(node: GameObject): UICanvas | null {
  for (let n: GameObject | null = node; n?.isValid; n = n.parent) {
    const c = n.getComponent(UICanvas);
    if (c) return c;
  }
  return null;
}

/** The focusable component on a node, or null. */
function focusableOn(node: GameObject | null): UIFocusableElement | null {
  if (!node?.isValid) return null;
  const c = node.getComponent(UIPanel);
  return isFocusableUI(c) ? c : null;
}

/** The last layout, indexed: what navigation searches. */
class Layout {
  readonly byComp = new Map<UIFocusableElement, UILaidOutElement>();
  /** Focusable elements by canvas, in tree order (as `elements()` lists them; `zIndex` changes only the draw order). */
  readonly candidates = new Map<UICanvas, UILaidOutElement[]>();

  constructor(readonly source: UILayoutSource | null) {
    if (!source) return;
    for (const e of source.elements()) {
      if (!isFocusableComp(e.comp)) continue;
      this.byComp.set(e.comp, e);
      if (!e.visible || !canFocus(e.comp) || clippedAway(e)) continue;
      let list = this.candidates.get(e.canvas);
      if (!list) this.candidates.set(e.canvas, (list = []));
      list.push(e);
    }
  }

  /** The active canvases, ascending sortOrder. */
  activeCanvases(): UICanvas[] {
    return (this.source?.canvases() ?? []).filter((c) => c.visible && c.comp.isActiveAndEnabled).map((c) => c.comp);
  }

  canvasOf(c: UIFocusableElement): UICanvas | null {
    return this.byComp.get(c)?.canvas ?? canvasAbove(c.owner);
  }

  /** Still focusable: not taken out, and (once laid out) shown. Not yet laid out counts as shown. */
  keeps(c: UIFocusableElement): boolean {
    if (!canFocus(c)) return false;
    const laid = this.byComp.get(c);
    return !laid || laid.visible;
  }

  list(canvas: UICanvas | null): UILaidOutElement[] {
    return (canvas && this.candidates.get(canvas)) || [];
  }

  /** The canvas's `firstSelected` if it's focusable there, else its first focusable element. */
  initialOf(canvas: UICanvas): UIFocusableElement | null {
    const list = this.list(canvas);
    const first = focusableOn(canvas.firstSelected);
    if (first && list.some((e) => e.comp === first)) return first;
    return (list[0]?.comp as UIFocusableElement | undefined) ?? null;
  }

  /** The highest-sortOrder active modal canvas that has a focusable element: focus can't leave it. */
  trap(): UICanvas | null {
    let best: UICanvas | null = null;
    for (const c of this.activeCanvases()) if (c.modal && this.list(c).length) best = c;
    return best;
  }
}

/**
 * @internal The UI core's routing of a press on `c` (null: on no element): whether it focuses `c`
 * (focusable, and not outside a modal canvas), and whether a modal canvas keeps focus (so a press that
 * focuses nothing doesn't take it away).
 */
export function pointerFocus(layout: UILayoutSource, c: UIFocusableElement | null): { readonly focus: boolean; readonly trapped: boolean } {
  const l = new Layout(layout);
  const trap = l.trap();
  return { focus: !!c && canFocus(c) && (!trap || l.canvasOf(c) === trap), trapped: trap !== null };
}

// --- The ui context ---------------------------------------------------------------------------

const UI_ENTRY = [{ context: UI_CONTEXT, priority: UI_CONTEXT_PRIORITY }] as const;
const NONE = [] as const;

// Active for a player while the World's focused element is on a canvas that player drives.
addContextSource((world, index) => {
  const focused = uiInteractions(world).focused;
  if (!focused || !focused.node.isValid || !focused.isActiveAndEnabled) return NONE;
  const player = canvasAbove(focused.owner)?.player ?? -1;
  return player < 0 || player === index ? UI_ENTRY : NONE;
});

// --- The system -------------------------------------------------------------------------------

type Direction = "up" | "down" | "left" | "right";

interface NavState {
  /** Canvases active at the last run, to see which became active. */
  active: Set<UICanvas>;
  /** autoFocus canvases waiting for a focusable element. */
  pending: Set<UICanvas>;
  /** Each player's `navigate` direction at the last run while it was held, by player index. */
  held: Map<number, Direction>;
  /** Players with a rebind pending at the last run: the press that finishes one is the rebind's, not the UI's. */
  rebinding: Set<GameObject>;
}

const states = new WeakMap<World, NavState>();

/** How much being off-axis costs, per UI pixel, against distance along the direction. */
const OFF_AXIS_PENALTY = 2;

interface Actions {
  navigate: { x: number; y: number } | null;
  submit: boolean;
  cancel: boolean;
  next: boolean;
  previous: boolean;
}

/**
 * What the players driving `canvas` performed this frame (any of them). A pending rebind takes a
 * player's presses, including the one that finishes it: the rebind runs earlier in the frame and has
 * already removed its request, so a player who had one at the last run is skipped too (else the
 * captured arrow would move focus, Enter click, Escape cancel the menu).
 * `navigate` also counts as performed when its direction changed while it stayed held (rolling from one arrow key to
 * the next, or a stick swept round): the action's triggers see one long press there, and would only repeat it.
 */
function readActions(world: World, canvas: UICanvas | null, state: NavState): Actions {
  const out: Actions = { navigate: null, submit: false, cancel: false, next: false, previous: false };
  const only = canvas?.player ?? -1;
  // `engine.RebindRequest` (input/rebind.ts), looked up by id: importing it here would load the evaluator early and reorder built-in systems.
  const rebinding = getDataComponentDef("engine.RebindRequest");
  const wasRebinding = state.rebinding;
  state.rebinding = new Set();
  for (const node of playerNodes(world)) {
    if (rebinding && node.hasData(rebinding)) {
      state.rebinding.add(node);
      continue;
    }
    if (wasRebinding.has(node)) continue;
    if (only >= 0 && node.getData(InputPlayer)!.index !== only) continue;
    const a = actionView(node, UIActions);
    if (!a) continue;
    const index = node.getData(InputPlayer)!.index;
    const v = a.vector2("navigate");
    const dir = v.x !== 0 || v.y !== 0 ? direction(v) : null;
    const before = state.held.get(index) ?? null;
    if (dir) state.held.set(index, dir);
    else state.held.delete(index);
    if (!out.navigate && dir && (a.performed("navigate") || (before !== null && before !== dir))) out.navigate = { x: v.x, y: v.y };
    out.submit ||= a.performed("submit");
    out.cancel ||= a.performed("cancel");
    out.next ||= a.performed("next");
    out.previous ||= a.performed("previous");
  }
  return out;
}

function run(world: World): void {
  if (!takesLocalInput(world)) return;
  const log = uiInteractions(world);
  let state = states.get(world);
  if (!state) states.set(world, (state = { active: new Set(), pending: new Set(), held: new Map(), rebinding: new Set() }));
  const layout = new Layout(log.layout);

  // Focus on something that can't have it any more is lost (a script's doing: no events).
  const was = log.focused;
  if (was && !layout.keeps(was)) {
    const canvas = was.node.isValid ? layout.canvasOf(was) : null;
    log.focus(null, "script");
    if (canvas?.autoFocus) state.pending.add(canvas);
  }

  const before = log.focused;
  // autoFocus: canvases that became active take focus (higher sortOrder last, so it wins).
  const active = layout.activeCanvases();
  const now = new Set(active);
  for (const c of active) if (!state.active.has(c) && c.autoFocus) state.pending.add(c);
  for (const c of state.pending) if (!now.has(c)) state.pending.delete(c);
  state.active = now;
  for (const c of active) {
    if (!state.pending.has(c)) continue;
    const first = layout.initialOf(c);
    if (!first) continue;
    state.pending.delete(c);
    log.focus(first, "navigation");
  }

  // A modal canvas keeps focus.
  const trap = layout.trap();
  if (trap && (!log.focused || layout.canvasOf(log.focused) !== trap)) log.focus(layout.initialOf(trap), "navigation");

  // The canvas navigation acts in: the focused element's, else the trap, else the top screen canvas with a focusable element.
  const focused = log.focused;
  let canvas = focused ? layout.canvasOf(focused) : trap;
  if (!canvas) for (const c of active) if (c.mode === "screen" && layout.list(c).length) canvas = c;

  const requests = log.takeRequests();
  const act = readActions(world, canvas, state);
  if (requests.length || act.navigate || act.submit || act.cancel || act.next || act.previous) log.navigating = true;

  for (const r of requests) {
    if (r === "cancel") log.setTyping(false);
    else step(log, layout, canvas, r === "next" ? 1 : -1);
  }
  // ADR 0424: a focused control takes the arrows it uses (a slider's and a radio group's left and right, an open select's
  // list); Tab and Shift+Tab stay within an open select's list.
  if (act.navigate && !controlTakes(world, log, direction(act.navigate))) move(log, layout, canvas, direction(act.navigate));
  if (act.next && !listStep(log, 1)) step(log, layout, canvas, 1);
  if (act.previous && !listStep(log, -1)) step(log, layout, canvas, -1);
  const target = log.focused;
  if (act.submit && target) {
    // ADR 0424: `submit` clicks any control but a field (a field starts typing); the click's default action activates it.
    if (!(target instanceof UIInputField)) {
      // Its activation is a click's (a checkbox toggles before the click's handlers, HTML's order).
      const click = uiClickRecord(world, target, {}, (prevented) => {
        // A select opened from the keyboard puts focus on its chosen option, for the arrows.
        if (!prevented && target instanceof UISelect && target.open) {
          const first = reconcileSelect(target)[0] ?? optionsOf(target).find((o) => o.interactable);
          if (first) log.focus(first, "script");
        }
      });
      log.publishNow("click", target, click.after, click.before);
    } else if (!log.isTyping(target)) log.setTyping(true);
  }
  if (act.cancel && target) {
    if (target instanceof UIInputField && log.isTyping(target)) log.setTyping(false);
    else if (target instanceof UIOption && selectOf(target)?.open) setSelectOpen(selectOf(target)!, false);
    else if (target instanceof UISelect && target.open) setSelectOpen(target, false);
    else {
      const on = layout.canvasOf(target);
      if (on) log.publishNow("cancel", on);
    }
  }
  // ADR 0423: what navigation focused shows: its scrolling ancestors scroll it into view.
  if (target && target !== before) uiScrollIntoView(world, target, { block: "nearest", inline: "nearest" });
}

/**
 * ADR 0424: `navigate` on a focused control that uses the arrows: an option in an open select's list moves up and down
 * the list (left and right do nothing there); a slider steps left and right; a named radio checks the previous or next
 * of its group left and right. Up and down leave a slider or radio, so a gamepad never gets stuck. Returns whether the
 * control took it.
 */
function controlTakes(world: World, log: UIInteractions, dir: Direction): boolean {
  const c = log.focused;
  if (c instanceof UIOption && selectOf(c)?.open) {
    if (dir === "up" || dir === "down") listStep(log, dir === "down" ? 1 : -1);
    return true;
  }
  if (dir !== "left" && dir !== "right") return false;
  const sign = dir === "right" ? 1 : -1;
  if (c instanceof UISlider) {
    if (!c.interactable) return true;
    const step = Number.isFinite(c.step) && c.step > 0 ? c.step : (c.max - c.min) / 100;
    const v = sliderValue(c, c.value + sign * step);
    if (v !== c.value) {
      c.value = v;
      controlChanged(world, c);
    }
    return true;
  }
  if (c instanceof UIRadio && c.name) {
    const group = radioGroup(c).filter((r) => r.interactable && r.focusable && r.isActiveAndEnabled && r.display !== "none");
    const i = group.indexOf(c);
    if (group.length < 2 || i < 0) return true;
    const next = group[(i + sign + group.length) % group.length];
    log.focus(next, "navigation");
    if (checkRadio(next)) controlChanged(world, next);
    return true;
  }
  return false;
}

/** ADR 0424: with focus on an option in an open select's list, move it to the next or previous enabled option (not past the ends). Returns whether it was there. */
function listStep(log: UIInteractions, delta: 1 | -1): boolean {
  const c = log.focused;
  const select = c instanceof UIOption ? selectOf(c) : null;
  if (!select?.open) return false;
  const options = optionsOf(select).filter((o) => o.interactable && o.isActiveAndEnabled);
  const i = options.indexOf(c as UIOption);
  const next = options[Math.min(options.length - 1, Math.max(0, i + delta))];
  if (next && next !== c) log.focus(next, "navigation");
  return true;
}

/** A `navigate` value's direction: its larger axis (+Y up). */
function direction(v: { x: number; y: number }): Direction {
  if (Math.abs(v.x) > Math.abs(v.y)) return v.x > 0 ? "right" : "left";
  return v.y > 0 ? "up" : "down";
}

const EXPLICIT: Record<Direction, "navUp" | "navDown" | "navLeft" | "navRight"> = { up: "navUp", down: "navDown", left: "navLeft", right: "navRight" };

/** `navigate`: an explicit neighbour, else the spatial search (`auto`); with nothing focused, the canvas's first element. */
function move(log: UIInteractions, layout: Layout, canvas: UICanvas | null, dir: Direction): void {
  const from = log.focused;
  if (!from) {
    const first = canvas ? layout.initialOf(canvas) : null;
    if (first) log.focus(first, "navigation");
    return;
  }
  if (from.navigation === "none") return;
  const list = layout.list(canvas);
  const explicit = focusableOn(from[EXPLICIT[dir]]);
  if (explicit && list.some((e) => e.comp === explicit)) {
    log.focus(explicit, "navigation");
    return;
  }
  if (from.navigation !== "auto") return;
  const origin = layout.byComp.get(from);
  if (!origin) return;
  const best = search(origin, list, dir);
  if (best) log.focus(best.comp as UIFocusableElement, "navigation");
}

/**
 * The nearest candidate in a direction, CSS spatial navigation's way (simplified): a candidate counts
 * when its centre lies beyond the origin's edge that way, inside a 90° cone opening from that edge, or
 * when it lines up with the origin across the direction (their spans overlap). Its score is the
 * distance from the edge to its centre along the direction, plus a penalty for how far its centre is
 * off the origin's span across it. Lowest wins; ties go to the earlier in tree order.
 */
function search(origin: UILaidOutElement, list: readonly UILaidOutElement[], dir: Direction): UILaidOutElement | null {
  const horizontal = dir === "left" || dir === "right";
  const sign = dir === "right" || dir === "down" ? 1 : -1;
  // Along: the direction's axis; across: the other. Spans as [min, max].
  // The drawn part of each box (ADR 0418: clipped by `overflow: hidden` ancestors).
  const along = (el: UILaidOutElement): [number, number] => {
    const e = shownBox(el);
    return horizontal ? [e.x, e.x + e.width] : [e.y, e.y + e.height];
  };
  const across = (el: UILaidOutElement): [number, number] => {
    const e = shownBox(el);
    return horizontal ? [e.y, e.y + e.height] : [e.x, e.x + e.width];
  };
  const [oa0, oa1] = along(origin);
  const [oc0, oc1] = across(origin);
  const edge = sign > 0 ? oa1 : oa0;
  let best: UILaidOutElement | null = null;
  let bestScore = Infinity;
  for (const e of list) {
    if (e === origin) continue;
    const [a0, a1] = along(e);
    const [c0, c1] = across(e);
    const distance = sign * ((a0 + a1) / 2 - edge);
    if (distance <= 0) continue;
    const centre = (c0 + c1) / 2;
    const offAxis = centre < oc0 ? oc0 - centre : centre > oc1 ? centre - oc1 : 0;
    const overlaps = c0 < oc1 && c1 > oc0;
    if (!overlaps && offAxis > distance) continue;
    const score = distance + OFF_AXIS_PENALTY * offAxis;
    if (score < bestScore) [best, bestScore] = [e, score];
  }
  return best;
}

/** `next` / `previous`: the canvas's focusable elements in tree order, wrapping. */
function step(log: UIInteractions, layout: Layout, canvas: UICanvas | null, delta: 1 | -1): void {
  const list = layout.list(canvas);
  if (!list.length) return;
  const from = log.focused;
  const i = from ? list.findIndex((e) => e.comp === from) : -1;
  const next = i < 0 ? (delta > 0 ? 0 : list.length - 1) : (i + delta + list.length) % list.length;
  log.focus(list[next].comp as UIFocusableElement, "navigation");
}

// After the actions are evaluated, before action event scripts (which are scripts: they see this frame's UI events).
defineBuiltinSystem({ name: "engine.UINavigation", phase: "input", after: ["engine.InputEvaluate"], before: ["engine.InputEventScripts"], run: (w) => run(w) });
