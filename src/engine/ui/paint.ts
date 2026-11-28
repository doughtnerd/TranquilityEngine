/**
 * ADR 0449: an element's resolved paint, as ADR 0271's text run is its resolved text. The UI core works out one
 * `UIPaint` per box element each sync (its fill, border colour and widths, corner radii) from the element's fields and
 * its interaction state, and reports it on `UILaidOutElement.paint`; the drawing layer draws exactly that.
 *
 * The Unity-style state colours (`hoverColor`, `pressedColor`, `focusColor`, ADR 0069 and 0340) are inputs here, a
 * fallback look for a state: a button's fill while it's pressed (and hovered), hovered, or shows focus; another
 * focusable element's border while it shows focus. Where the element's style rules state that look (the rule that
 * gives it its `backgroundColor` or `borderColor` names the state's pseudo-class, in any compound, not under `:not()`:
 * `UIPanel._styledStates`, written by the styled tree as it restyles it), the style's value, already restyled for the
 * state and transitioned, is drawn instead.
 *
 * Renderer-neutral and not public API (ADR 0010).
 */
import type { Color } from "../core/math";
import { UIButton, UIPanel, UIText, isFocusableUI, type UIComponentType } from "./components";
import { uiInteractions } from "./interactions";
import type { UIPaint, UIRGBA } from "./uiCoreTypes";

/** A state the Unity-style colours paint. */
export type UIPaintState = "hover" | "pressed" | "focus";

/** The states that the rules giving an element its fill and its border colour state the look for (ADR 0449). */
export interface UIStyledStates {
  readonly background: readonly UIPaintState[];
  readonly border: readonly UIPaintState[];
}

// What a paint is made of, read into scratch slots before anything is allocated: [fill? 0/1, r, g, b, a] (fill),
// border colour, border widths, corner radii.
const FILL = 0, BORDER = 5, WIDTHS = 9, RADII = 13, SLOTS = 17;
const scratch = new Float64Array(SLOTS);

/** Writes a colour at `at` (with a present flag first for a fill: none for no colour or a fully transparent one). */
function putFill(at: number, c: Color | null | undefined): void {
  if (c && c.a > 0) {
    scratch[at] = 1;
    putColor(at + 1, c);
  } else scratch[at] = scratch[at + 1] = scratch[at + 2] = scratch[at + 3] = scratch[at + 4] = 0;
}
function putColor(at: number, c: Color): void {
  scratch[at] = c.r;
  scratch[at + 1] = c.g;
  scratch[at + 2] = c.b;
  scratch[at + 3] = c.a;
}
/** A side's border width: its own, else `borderWidth`; never negative (as `uiBorderEdges`). */
const side = (all: number, own: number | null | undefined) => Math.max(0, own === null || own === undefined ? all : Number.isFinite(own) ? own : 0);
function putWidths(c: UIPanel | UIText): void {
  const all = Number.isFinite(c.borderWidth) ? c.borderWidth : 0;
  scratch[WIDTHS] = side(all, c.borderTopWidth);
  scratch[WIDTHS + 1] = side(all, c.borderRightWidth);
  scratch[WIDTHS + 2] = side(all, c.borderBottomWidth);
  scratch[WIDTHS + 3] = side(all, c.borderLeftWidth);
}

/** Whether the four scratch slots at `at` hold `v`'s values. */
const holds = (at: number, v: readonly number[]) => scratch[at] === v[0] && scratch[at + 1] === v[1] && scratch[at + 2] === v[2] && scratch[at + 3] === v[3];
/** The four scratch slots at `at`: `last` when it holds them already, else a new array. */
const quad = <T extends readonly number[]>(at: number, last: T | undefined): T => (last && holds(at, last) ? last : ([scratch[at], scratch[at + 1], scratch[at + 2], scratch[at + 3]] as unknown as T));

/**
 * The paint `c` is drawn with now: a panel's (and every kind built on one: buttons, fields, form controls) and a
 * text's box. Null for kinds without a box of their own to paint (images, canvases). `last`, what it was drawn with
 * before, is returned as it is when it still draws the same, so an unchanged paint allocates nothing (the UI core
 * resolves every element's paint each sync, and the drawing layer compares paints by identity).
 */
export function paintOf(c: UIComponentType, last?: UIPaint | null): UIPaint | null {
  if (c instanceof UIText) {
    putFill(FILL, c.backgroundColor);
    putColor(BORDER, c.borderColor);
    putWidths(c);
    const r = Math.max(0, c.borderRadius || 0); // a text's box has one radius (ADR 0432)
    scratch[RADII] = scratch[RADII + 1] = scratch[RADII + 2] = scratch[RADII + 3] = r;
    return made(last);
  }
  if (!(c instanceof UIPanel)) return null;
  let background: Color | null = c.backgroundColor;
  let border = c.borderColor;
  const styled = c._styledStates;
  const follows = (states: readonly UIPaintState[] | undefined, a: UIPaintState, b?: UIPaintState) => !!states && (states.includes(a) || (!!b && states.includes(b)));
  // Focus colours (ADR 0340) show while the last UI input was navigation: a button's fill (an option's too), the other
  // controls' border (ADR 0428).
  const focusable = isFocusableUI(c) ? c : null;
  const showsFocus = !!focusable && uiInteractions(c._world).showsFocus(focusable);
  if (c instanceof UIButton) {
    if (c.interactable) {
      // Pressed needs hovered too (a press dragged off the button shows it unpressed).
      if (c.pressed && c.hovered) background = follows(styled?.background, "pressed", "hover") ? background : c.pressedColor;
      else if (c.hovered) background = follows(styled?.background, "hover") ? background : c.hoverColor;
      else if (showsFocus) background = follows(styled?.background, "focus") ? background : c.focusColor;
    }
  } else if (focusable && showsFocus && !follows(styled?.border, "focus")) border = focusable.focusColor;
  putFill(FILL, background);
  putColor(BORDER, border);
  putWidths(c);
  // ADR 0422 wave 2: a corner's own radius, or (at -1) borderRadius.
  const corner = (v: number) => (v >= 0 ? v : c.borderRadius);
  scratch[RADII] = corner(c.borderTopLeftRadius);
  scratch[RADII + 1] = corner(c.borderTopRightRadius);
  scratch[RADII + 2] = corner(c.borderBottomRightRadius);
  scratch[RADII + 3] = corner(c.borderBottomLeftRadius);
  return made(last);
}

/** The paint in the scratch slots: `last` when it holds them all, else a new paint sharing `last`'s unchanged parts. */
function made(last: UIPaint | null | undefined): UIPaint {
  const bg = last?.background;
  const sameFill = last !== undefined && last !== null && (scratch[FILL] === 0 ? bg === null : !!bg && holds(FILL + 1, bg));
  if (last && sameFill && holds(BORDER, last.borderColor) && holds(WIDTHS, last.borderWidths) && holds(RADII, last.radii)) return last;
  return {
    background: sameFill ? last!.background : scratch[FILL] === 0 ? null : quad<UIRGBA>(FILL + 1, undefined),
    borderColor: quad(BORDER, last?.borderColor),
    borderWidths: quad(WIDTHS, last?.borderWidths),
    radii: quad(RADII, last?.radii),
  };
}
