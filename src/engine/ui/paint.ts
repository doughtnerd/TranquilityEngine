/**
 * ADR 0437: an element's resolved paint, as ADR 0271's text run is its resolved text. The UI core works out one
 * `UIPaint` per box element each sync (its fill, border colour and widths, corner radii) from the element's fields and
 * its interaction state, and reports it on `UILaidOutElement.paint`; the drawing layer draws exactly that.
 *
 * The Unity-style state colours (`hoverColor`, `pressedColor`, `focusColor`, ADR 0069 and 0340) are inputs here, a
 * fallback look for a state: a button's fill while it's pressed (and hovered), hovered, or shows focus; another
 * focusable element's border while it shows focus. Where the element's own style rules state that look (the rule that
 * gives it its `backgroundColor` or `borderColor` names the state's pseudo-class, `UIPanel._styledStates`, written by the
 * UI host as it restyles it), the style's value, already restyled for the state and transitioned, is drawn instead.
 *
 * Renderer-neutral and not public API (ADR 0010).
 */
import type { Color } from "../core/math";
import { UIButton, UIPanel, UIText, isFocusableUI, type UIComponentType } from "./components";
import { uiInteractions } from "./interactions";
import { uiBorderEdges } from "./layout";
import type { UIPaint, UIRGBA } from "./uiCoreTypes";

/** A state the Unity-style colours paint. */
export type UIPaintState = "hover" | "pressed" | "focus";

/** The states of its own that the rules giving an element its fill and its border colour name (ADR 0437). */
export interface UIStyledStates {
  readonly background: readonly UIPaintState[];
  readonly border: readonly UIPaintState[];
}

const rgba = (c: Color): UIRGBA => [c.r, c.g, c.b, c.a];
/** A fill to draw: null for none, and for a fully transparent colour (it would draw nothing). */
const fill = (c: Color | null | undefined): UIRGBA | null => (c && c.a > 0 ? rgba(c) : null);

/**
 * The paint `c` is drawn with now: a panel's (and every kind built on one: buttons, fields, form controls) and a
 * text's box. Null for kinds without a box of their own to paint (images, canvases).
 */
export function paintOf(c: UIComponentType): UIPaint | null {
  if (c instanceof UIText) {
    const r = Math.max(0, c.borderRadius || 0); // a text's box has one radius (ADR 0432)
    return { background: fill(c.backgroundColor), borderColor: rgba(c.borderColor), borderWidths: uiBorderEdges(c), radii: [r, r, r, r] };
  }
  if (!(c instanceof UIPanel)) return null;
  let background: Color | null = c.backgroundColor;
  let border = c.borderColor;
  const styled = c._styledStates;
  const follows = (states: readonly UIPaintState[] | undefined, ...any: UIPaintState[]) => !!states && any.some((s) => states.includes(s));
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
  // ADR 0422 wave 2: a corner's own radius, or (at -1) borderRadius.
  const corner = (v: number) => (v >= 0 ? v : c.borderRadius);
  return {
    background: fill(background),
    borderColor: rgba(border),
    borderWidths: uiBorderEdges(c),
    radii: [corner(c.borderTopLeftRadius), corner(c.borderTopRightRadius), corner(c.borderBottomRightRadius), corner(c.borderBottomLeftRadius)],
  };
}

/** True when two paints draw the same. */
export function samePaint(a: UIPaint | null, b: UIPaint | null): boolean {
  if (!a || !b) return a === b;
  const same = (p: readonly number[] | null, q: readonly number[] | null) => (!p || !q ? p === q : p.every((v, i) => v === q[i]));
  return same(a.background, b.background) && same(a.borderColor, b.borderColor) && same(a.borderWidths, b.borderWidths) && same(a.radii, b.radii);
}
