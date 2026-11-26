/**
 * UI element kinds and text runs (ADR 0271): the one place that knows the closed set of UI element
 * kinds and what each is, and the one function that says what text an element shows.
 *
 * - **The kind table**: per kind, its component type, markup tag, whether it is a leaf (can't have
 *   children), whether it takes the pointer, which pseudo-classes it sets, and whether it paints
 *   anything. The UI core (`UICore.ts`), UI documents (`UIDocument.ts`, the markup and stylesheet
 *   parsers), the Babylon drawing layer and the editor's UI picking read it instead of switching on
 *   component classes themselves.
 * - **`textRunOf`**: an element's resolved text run (text, size, CSS weight, family, line height and
 *   wrapping). The UI core measures exactly this run, uses it as the measure's dirty signature, and
 *   reports it on each laid-out element; the drawing layer draws exactly that run. So measured text is
 *   drawn text.
 *
 * Renderer-neutral and nothing here is public API (ADR 0010).
 */
import { Locale } from "../localisation/Locale";
import { UIButton, UICanvas, UIImage, UIInputField, UIPanel, UIText, type UIComponentType, type UIOverflow, type UITextAlign, type UIWordBreak } from "./components";
import type { UIPseudo, UITag } from "./document/types";
import { fontFamilyOf } from "./fonts";
import { uiBorderEdges } from "./layout";
import type { UIKind, UITextRun, UITextWrap } from "./uiCoreTypes";

/** A UI text line's height, as a multiple of its font size. */
export const UI_LINE_HEIGHT = 1.2;

interface KindSpec<C extends UIComponentType = UIComponentType> {
  readonly kind: UIKind;
  readonly type: abstract new () => C;
  readonly tag: UITag;
  /** Can't have children: UI nodes under it lay out beside it. */
  readonly leaf: boolean;
  /** Takes the pointer (buttons press, input fields focus). */
  readonly interactive: boolean;
  /** Yoga flex shrink: text wraps to what's left; other boxes keep their size. */
  readonly flexShrink: number;
  /** The pseudo-classes this kind sets, beyond `disabled` (every element is disabled when its component is). */
  pseudo?(c: C): Partial<Record<UIPseudo, boolean>>;
  /** Draws something of its own (a fill, border, text or image), opacity aside. */
  paints(c: C): boolean;
  /** Is a graphic in Unity's sense, which stops the pointer while its `raycastTarget` is on (ADR 0385). */
  graphic(c: C): boolean;
}

const visible = (c: { a: number } | null | undefined): boolean => !!c && c.a > 0;
/** A border on any side (ADR 0418: sides may differ). */
const hasBorder = (c: UIPanel): boolean => uiBorderEdges(c).some((w) => w > 0);
const panelPaints = (c: UIPanel): boolean => visible(c.backgroundColor) || (hasBorder(c) && visible(c.borderColor));
/**
 * A panel with a background (a transparent one too: Unity's invisible blocker) or a border; without either it's a layout
 * box. ADR 0423: a panel the player scrolls takes the pointer over its whole box too (a ScrollRect's viewport), so the
 * wheel and drags reach it between its children.
 */
const panelIsGraphic = (c: UIPanel): boolean => c.backgroundColor !== null || hasBorder(c) || isUserScroller(c);
const always = () => true;

/** The kinds, subclasses before the classes they extend (the first whose type matches wins). */
const KINDS: readonly KindSpec[] = [
  { kind: "canvas", type: UICanvas, tag: "Canvas", leaf: false, interactive: false, flexShrink: 0, paints: () => false, graphic: () => false },
  {
    kind: "button", type: UIButton, tag: "Button", leaf: false, interactive: true, flexShrink: 0,
    pseudo: (c: UIButton) => ({ hover: c.hovered, pressed: c.pressed, disabled: !c.interactable }),
    paints: panelPaints,
    graphic: always,
  } as KindSpec<UIButton> as KindSpec,
  {
    kind: "input", type: UIInputField, tag: "InputField", leaf: true, interactive: true, flexShrink: 0,
    pseudo: (c: UIInputField) => ({ focus: c.focused }),
    paints: (c: UIInputField) => panelPaints(c) || textRunOf(c)!.text !== "",
    graphic: always,
  } as KindSpec<UIInputField> as KindSpec,
  { kind: "text", type: UIText, tag: "Text", leaf: true, interactive: false, flexShrink: 1, paints: (c: UIText) => textRunOf(c)!.text.trim() !== "", graphic: always } as KindSpec<UIText> as KindSpec,
  { kind: "image", type: UIImage, tag: "Image", leaf: true, interactive: false, flexShrink: 0, paints: (c: UIImage) => c.image !== "", graphic: always } as KindSpec<UIImage> as KindSpec,
  { kind: "panel", type: UIPanel, tag: "Panel", leaf: false, interactive: false, flexShrink: 0, paints: panelPaints, graphic: panelIsGraphic } as KindSpec<UIPanel> as KindSpec,
];

const BY_KIND = new Map(KINDS.map((k) => [k.kind, k]));
const BY_TAG = new Map(KINDS.map((k) => [k.tag, k]));

/** The markup tags of UI elements. */
export const UI_TAGS: ReadonlySet<UITag> = new Set(KINDS.map((k) => k.tag));

/** Every UI component type the kinds cover (base types; subclasses are found through them). */
export const UI_KIND_TYPES: readonly (abstract new () => UIComponentType)[] = KINDS.map((k) => k.type);

function specOf(c: UIComponentType): KindSpec {
  for (const k of KINDS) if (c instanceof k.type) return k;
  return BY_KIND.get("panel")!;
}

/** An element's kind. */
export function uiKindOf(c: UIComponentType): UIKind {
  return specOf(c).kind;
}

/** The component type a markup tag builds. */
export function uiTypeOfTag(tag: UITag): new () => UIComponentType {
  return BY_TAG.get(tag)!.type as new () => UIComponentType;
}

/** True for kinds that can't have children. */
export function isLeafKind(kind: UIKind): boolean {
  return BY_KIND.get(kind)!.leaf;
}

/** True for kinds that take the pointer. */
export function isInteractiveKind(kind: UIKind): boolean {
  return BY_KIND.get(kind)!.interactive;
}

/** A kind's Yoga flex shrink. */
export function flexShrinkOf(kind: UIKind): number {
  return BY_KIND.get(kind)!.flexShrink;
}

/** The pseudo-classes (`:hover`, `:pressed`, `:focus`, `:disabled`) an element is in now. */
export function uiPseudoState(c: UIComponentType): Record<UIPseudo, boolean> {
  const own = specOf(c).pseudo?.(c) ?? {};
  return { hover: own.hover ?? false, pressed: own.pressed ?? false, focus: own.focus ?? false, disabled: !c.enabled || (own.disabled ?? false) };
}

/** True when the element draws something of its own: a fill, border, text or image (nothing at zero opacity; a canvas never). */
export function isPaintedUI(c: UIComponentType): boolean {
  if (!(c instanceof UICanvas) && c.opacity <= 0) return false;
  return specOf(c).paints(c);
}

/**
 * True when the pointer stops at the element (ADR 0385, Unity's `Graphic.raycastTarget`): its `raycastTarget` is on
 * and it is a graphic (text, an image, a button, an input field, or a panel with a background or a border). Whether
 * it is shown and active is the caller's to check. A canvas never is.
 */
export function isRaycastTarget(c: UIComponentType): boolean {
  if (c instanceof UICanvas || !c.raycastTarget) return false;
  return specOf(c).graphic(c);
}

/**
 * CSS font weight for a `fontWeight` field value: the names `light` (300), `normal` (400), `medium`
 * (500), `semi-bold` (600) and `bold` (700), or a whole number from 1 to 1000 (CSS Fonts 4; the
 * bundled Inter is a variable font, so in-between weights draw as written). Anything else is 400.
 */
export function cssFontWeight(w: string): string {
  switch (w) {
    case "light": return "300";
    case "normal": return "400";
    case "medium": return "500";
    case "semi-bold": return "600";
    case "bold": return "700";
  }
  if (!/^\d{1,4}$/.test(w)) return "400";
  const n = Number(w);
  return n >= 1 && n <= 1000 ? String(n) : "400";
}

const WRAPS: Readonly<Record<UIWordBreak, UITextWrap>> = { "break-word": "word", "break-all": "anywhere", "keep-all": "none" };

/** A `textAlign` value as an edge: `start` and `end` resolved for the direction (ADR 0356 §5). */
function textAlignEdge(align: UITextAlign, direction: "ltr" | "rtl"): UITextRun["align"] {
  if (align === "start") return direction === "rtl" ? "right" : "left";
  if (align === "end") return direction === "rtl" ? "left" : "right";
  return align === "center" || align === "right" || align === "justify" ? align : "left";
}

/**
 * The text an element shows, resolved: a `UIText`'s text, or an input field's value (its placeholder
 * while empty) on one line. Null for kinds without text. A fresh object each call.
 */
export function textRunOf(c: UIComponentType): UITextRun | null {
  if (c instanceof UIInputField) {
    // One line: a line break a script put in the value shows as a space (one for one, so caret indices still match).
    const text = (c.value || c.placeholder).replace(/[\r\n]/g, " ");
    // Drawn from the language's start edge (ADR 0356 §5).
    const direction = Locale.direction;
    return { text, fontSize: c.fontSize, fontWeight: "400", fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: "none", direction, align: textAlignEdge("start", direction) };
  }
  if (c instanceof UIText) {
    const direction = Locale.direction;
    return { text: c.text, fontSize: c.fontSize, fontWeight: cssFontWeight(c.fontWeight), fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: WRAPS[c.wordBreak] ?? "word", direction, align: textAlignEdge(c.textAlign, direction) };
  }
  return null;
}

// --- Overflow (ADR 0418 wave 1, 0423) -------------------------------------------------------------

/**
 * An element's overflow on each axis: `overflowX`/`overflowY`, else `overflow`. As in CSS, `visible` beside an axis that
 * isn't computes to `auto` (a box can't clip one way and spill the other). A canvas: both `visible`.
 */
export function overflowAxes(c: UIComponentType): { readonly x: UIOverflow; readonly y: UIOverflow } {
  if (c instanceof UICanvas) return VISIBLE_BOTH;
  const all = c.overflow ?? "visible";
  let x = c.overflowX ?? all, y = c.overflowY ?? all;
  if (x === "visible" && y !== "visible") x = "auto";
  else if (y === "visible" && x !== "visible") y = "auto";
  return x === "visible" && y === "visible" ? VISIBLE_BOTH : { x, y };
}
const VISIBLE_BOTH = { x: "visible", y: "visible" } as const;

/** True for an element that clips its children (any `overflow` other than `visible`). */
export function clipsChildren(c: UIComponentType): boolean {
  return overflowAxes(c).x !== "visible";
}

/** True for `overflow` `auto` or `scroll` (on either axis): the player scrolls it. */
export function isUserScroller(c: UIComponentType): boolean {
  const { x, y } = overflowAxes(c);
  return x === "auto" || x === "scroll" || y === "auto" || y === "scroll";
}

/** True when the player scrolls `c` along an axis: `auto` or `scroll` there. */
export function userScrollsAxis(o: UIOverflow): boolean {
  return o === "auto" || o === "scroll";
}

/** True when two runs measure and draw the same. */
export function sameTextRun(a: UITextRun | null, b: UITextRun | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  return a.text === b.text && a.fontSize === b.fontSize && a.fontWeight === b.fontWeight && a.fontFamily === b.fontFamily && a.lineHeight === b.lineHeight && a.wrap === b.wrap && a.direction === b.direction && a.align === b.align;
}
