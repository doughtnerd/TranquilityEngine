/**
 * UI element kinds and text runs (ADR 0271): the one place that knows the closed set of UI element
 * kinds and what each is, and the one function that says what text an element shows.
 *
 * - **The kind table**: per kind, its component type, markup tag, whether it is a leaf (can't have
 *   children), whether it takes the pointer, which pseudo-classes it sets, and whether it paints
 *   anything. The UI core (`UICore.ts`), the UI host (`host/UIHost.ts`, the stylesheet
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
import { UIAudio, UIButton, UICanvas, UIForm, UIImage, UIInputField, UILabel, UIMeter, UIOption, UIPanel, UIProgress, UIRadio, UISelect, UISlider, UISvg, UIText, UITextArea, UIToggle, UIVideo, type UIComponentType, type UIOverflow, type UITextAlign, type UIWordBreak } from "./components";
import { selectLabel } from "./formControls";
import type { UIPseudo, UIPseudoState, UITag } from "./document/types";
import { fontFamilyOf } from "./fonts";
import { uiBorderEdges } from "./layout";
import type { UIInlineRun, UIKind, UITextRun, UITextWrap } from "./uiCoreTypes";

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
const fieldPseudo = (c: UIInputField) => ({ focus: c.focused, disabled: !c.interactable, "placeholder-shown": c.placeholder !== "" && c.value === "" });
/** ADR 0424: a form control's own look (a checkbox's mark, a slider's thumb, a bar's fill) is always drawn. */
const control = <C extends UIComponentType>(kind: UIKind, type: abstract new () => C, tag: UITag, pseudo: (c: C) => Partial<Record<UIPseudo, boolean>>, leaf = true, interactive = true): KindSpec =>
  ({ kind, type, tag, leaf, interactive, flexShrink: 0, pseudo, paints: always, graphic: always }) as KindSpec<C> as KindSpec;

const KINDS: readonly KindSpec[] = [
  { kind: "canvas", type: UICanvas, tag: "Canvas", leaf: false, interactive: false, flexShrink: 0, paints: () => false, graphic: () => false },
  // ADR 0424: an option is a button in its select's list; it's checked while chosen.
  {
    kind: "option", type: UIOption, tag: "Option", leaf: false, interactive: true, flexShrink: 0,
    pseudo: (c: UIOption) => ({ hover: c.hovered, pressed: c.pressed, focus: c.focused, disabled: !c.interactable, checked: c.selected }),
    paints: panelPaints,
    graphic: always,
  } as KindSpec<UIOption> as KindSpec,
  {
    kind: "button", type: UIButton, tag: "Button", leaf: false, interactive: true, flexShrink: 0,
    pseudo: (c: UIButton) => ({ hover: c.hovered, pressed: c.pressed, focus: c.focused, disabled: !c.interactable }),
    paints: panelPaints,
    graphic: always,
  } as KindSpec<UIButton> as KindSpec,
  {
    kind: "textarea", type: UITextArea, tag: "TextArea", leaf: true, interactive: true, flexShrink: 0,
    pseudo: fieldPseudo,
    paints: (c: UITextArea) => panelPaints(c) || textRunOf(c)!.text !== "",
    graphic: always,
  } as KindSpec<UITextArea> as KindSpec,
  {
    kind: "input", type: UIInputField, tag: "InputField", leaf: true, interactive: true, flexShrink: 0,
    pseudo: fieldPseudo,
    paints: (c: UIInputField) => panelPaints(c) || textRunOf(c)!.text !== "",
    graphic: always,
  } as KindSpec<UIInputField> as KindSpec,
  // ADR 0424: form elements. A select isn't a leaf: its options are its children (laid out in its list, not in it).
  control("toggle", UIToggle, "Toggle", (c) => ({ focus: c.focused, disabled: !c.interactable, checked: c.checked, indeterminate: c.indeterminate })),
  control("radio", UIRadio, "Radio", (c) => ({ focus: c.focused, disabled: !c.interactable, checked: c.checked })),
  control("slider", UISlider, "Slider", (c) => ({ focus: c.focused, disabled: !c.interactable })),
  control("select", UISelect, "Select", (c) => ({ focus: c.focused, disabled: !c.interactable }), false),
  control("progress", UIProgress, "Progress", (c) => ({ indeterminate: c.value === null || !Number.isFinite(c.value) }), true, false),
  control("meter", UIMeter, "Meter", () => ({}), true, false),
  // A label's whole box takes a click (which goes to its control); a form is a panel.
  { kind: "label", type: UILabel, tag: "Label", leaf: false, interactive: false, flexShrink: 0, paints: panelPaints, graphic: always } as KindSpec<UILabel> as KindSpec,
  { kind: "form", type: UIForm, tag: "Form", leaf: false, interactive: false, flexShrink: 0, paints: panelPaints, graphic: panelIsGraphic } as KindSpec<UIForm> as KindSpec,
  // ADR 0425: a text's inline children are its runs, not boxes (it stays a leaf for layout); its background paints its box.
  { kind: "text", type: UIText, tag: "Text", leaf: true, interactive: false, flexShrink: 1, paints: (c: UIText) => visible(c.backgroundColor) || textRunOf(c)!.text.trim() !== "", graphic: always } as KindSpec<UIText> as KindSpec,
  // ADR 0426: an inline SVG and a video draw as images (their own pictures); audio is a box that draws nothing.
  { kind: "image", type: UISvg, tag: "Svg", leaf: true, interactive: false, flexShrink: 0, paints: (c: UISvg) => c.markup !== "", graphic: always } as KindSpec<UISvg> as KindSpec,
  { kind: "image", type: UIVideo, tag: "Video", leaf: true, interactive: false, flexShrink: 0, paints: (c: UIVideo) => c.src !== "" || c._player.current !== null, graphic: always } as KindSpec<UIVideo> as KindSpec,
  { kind: "image", type: UIImage, tag: "Image", leaf: true, interactive: false, flexShrink: 0, paints: (c: UIImage) => c.image !== "", graphic: always } as KindSpec<UIImage> as KindSpec,
  { kind: "panel", type: UIAudio, tag: "Audio", leaf: true, interactive: false, flexShrink: 0, paints: () => false, graphic: () => false } as KindSpec<UIAudio> as KindSpec,
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
  return {
    hover: own.hover ?? false,
    pressed: own.pressed ?? false,
    focus: own.focus ?? false,
    disabled: !c.enabled || (own.disabled ?? false),
    // ADR 0424.
    checked: own.checked ?? false,
    indeterminate: own.indeterminate ?? false,
    "placeholder-shown": own["placeholder-shown"] ?? false,
  };
}

/** True when two pseudo-class states are the same. */
export function samePseudoState(a: Readonly<UIPseudoState>, b: Readonly<UIPseudoState>): boolean {
  return a.hover === b.hover && a.pressed === b.pressed && a.focus === b.focus && a.disabled === b.disabled && !!a.checked === !!b.checked && !!a.indeterminate === !!b.indeterminate && !!a["placeholder-shown"] === !!b["placeholder-shown"];
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
  if (c instanceof UITextArea) {
    // ADR 0424: lines as typed, wrapped at its width unless `wrap` is `off`; a password-like mask doesn't apply.
    const direction = Locale.direction;
    return { text: c.value || c.placeholder, fontSize: c.fontSize, fontWeight: "400", fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: c.wrap === "off" ? "none" : "word", direction, align: textAlignEdge("start", direction) };
  }
  if (c instanceof UISelect) {
    // ADR 0424: the chosen option's label, on one line.
    const direction = Locale.direction;
    return { text: selectLabel(c).replace(/[\r\n]/g, " "), fontSize: c.fontSize, fontWeight: "400", fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: "none", direction, align: textAlignEdge("start", direction) };
  }
  if (c instanceof UIInputField) {
    // One line: a line break a script put in the value shows as a space (one for one, so caret indices still match).
    // ADR 0424: a password's characters show as dots (one each, so caret indices still match).
    const shown = c.value && c.type === "password" ? "•".repeat(c.value.length) : c.value;
    const text = (shown || c.placeholder).replace(/[\r\n]/g, " ");
    // Drawn from the language's start edge (ADR 0356 §5).
    const direction = Locale.direction;
    return { text, fontSize: c.fontSize, fontWeight: "400", fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: "none", direction, align: textAlignEdge("start", direction) };
  }
  if (c instanceof UIText) {
    const direction = Locale.direction;
    const fontFamily = fontFamilyOf(c.font);
    const run = { text: c.text, fontSize: c.fontSize, fontWeight: cssFontWeight(c.fontWeight), fontFamily, lineHeight: UI_LINE_HEIGHT, wrap: WRAPS[c.wordBreak] ?? "word", direction, align: textAlignEdge(c.textAlign, direction) };
    // ADR 0425: inline children make runs (an editable text always has them: its caret and selection are placed by them).
    const runs = inlineRunsOf(c, fontFamily);
    if (!runs) return run;
    let text = "";
    for (const r of runs) text += r.text;
    return c.contentEditable ? { ...run, text, runs, editable: true } : { ...run, text, runs };
  }
  return null;
}

// --- Inline runs (ADR 0425) ----------------------------------------------------------------------

const OBJECT = "￼";

/** A colour as CSS text. */
function cssColor(c: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
}

/** A node's inline children: its UI components that are text or images, in order, shown (active, enabled, not `display: none`). */
function inlineChildren(c: UIText): (UIText | UIImage)[] {
  const world = c._world;
  const out: (UIText | UIImage)[] = [];
  for (const e of world.childEntities(c.owner.entity)) {
    for (const k of world._componentsOf(e)) {
      if ((k instanceof UIText || (k instanceof UIImage && !(k instanceof UISvg) && !(k instanceof UIVideo))) && !k._destroyed) {
        if (k.isActiveAndEnabled && k.display !== "none") out.push(k);
        break;
      }
    }
  }
  return out;
}

/** What a run inherits from its inline ancestors inside the text: decorations, a background, a baseline shift, a font. */
interface InlineContext {
  readonly decoration: string;
  readonly background: string | null;
  readonly shift: number;
  readonly family: string;
  readonly hidden: boolean;
}

/** `text-decoration` lines as a sorted, space-separated set. */
function decorationsOf(own: string, inherited: string): string {
  const set = new Set(inherited ? inherited.split(" ") : []);
  for (const w of own.split(/\s+/)) if (w === "underline" || w === "line-through" || w === "overline") set.add(w);
  return [...set].sort().join(" ");
}

/** A length field as UI pixels when it's a plain number, else `fallback` (`auto`, percentages). */
function pixelsOr(v: unknown, fallback: number): number {
  const n = typeof v === "number" ? v : typeof v === "string" && /^-?(\d+\.?\d*|\.\d+)(px)?$/.test(v.trim()) ? parseFloat(v) : NaN;
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

/**
 * A text element's inline runs (ADR 0425): its own text, then each inline child's runs in order (a child text's own
 * text, then its children's, depth first; an image as one U+FFFC run), with whitespace collapsed across runs as HTML's
 * `white-space: normal` does (unless the text is editable, which keeps it as typed). Null when it has no inline
 * children and isn't editable: plain text, one run, as before.
 */
function inlineRunsOf(c: UIText, family: string): UIInlineRun[] | null {
  const children = inlineChildren(c);
  if (!children.length && !c.contentEditable) return null;
  const out: UIInlineRun[] = [];
  const base: InlineContext = { decoration: "", background: null, shift: 0, family, hidden: false };
  pushRuns(c, base, out, true);
  if (!c.contentEditable) collapseRuns(out);
  else if (!out.length) out.push(textRun(c, "", base, c));
  return out;
}

function textRun(c: UIText, text: string, ctx: InlineContext, owner: UIComponentType): UIInlineRun {
  return {
    text,
    fontSize: c.fontSize,
    fontWeight: cssFontWeight(c.fontWeight),
    fontStyle: c.fontStyle === "normal" ? "normal" : "italic",
    fontFamily: ctx.family,
    color: ctx.hidden ? "rgba(0, 0, 0, 0)" : cssColor(c.color),
    decoration: ctx.hidden ? "" : ctx.decoration,
    background: ctx.hidden ? null : ctx.background,
    verticalAlign: c.verticalAlign === "sub" || c.verticalAlign === "super" ? "baseline" : (c.verticalAlign ?? "baseline"),
    shift: ctx.shift,
    image: null,
    owner,
    source: c,
  };
}

function pushRuns(c: UIText, outer: InlineContext, out: UIInlineRun[], root: boolean): void {
  // The text element itself paints its background over its box (it's drawn by the drawing layer), not behind its runs.
  const shift = c.verticalAlign === "sub" ? -0.25 * c.fontSize : c.verticalAlign === "super" ? 0.45 * c.fontSize : 0;
  const ctx: InlineContext = root
    ? { ...outer, decoration: decorationsOf(c.textDecoration, "") }
    : {
        decoration: decorationsOf(c.textDecoration, outer.decoration),
        background: c.backgroundColor && c.backgroundColor.a > 0 ? cssColor(c.backgroundColor) : outer.background,
        shift: outer.shift + shift,
        family: c.font ? fontFamilyOf(c.font) : outer.family,
        hidden: outer.hidden || !c.visible,
      };
  // A text piece's events go to the element it's in, as a generated `::before`/`::after`'s do (ADR 0428).
  const owner = c._textPiece || c._pseudo ? ownerAbove(c) : c;
  const children = inlineChildren(c);
  // ADR 0428: a `::before` run comes before the element's own text.
  const first = children[0] instanceof UIText && children[0]._pseudo === "before" ? children[0] : null;
  if (first) pushRuns(first, ctx, out, false);
  if (c.text !== "") out.push(textRun(c, c.text, ctx, owner));
  for (const k of children) {
    if (k === first) continue;
    if (k instanceof UIText) {
      // A `<br>`: a line break in the run's style.
      pushRuns(k, ctx, out, false);
      continue;
    }
    const size = c.fontSize;
    const w = pixelsOr(k.width, NaN), h = pixelsOr(k.height, NaN);
    const width = Number.isFinite(w) ? w : Number.isFinite(h) ? h : size;
    const height = Number.isFinite(h) ? h : width;
    out.push({ ...textRun(c, OBJECT, ctx, k), verticalAlign: "baseline", decoration: "", background: null, image: { src: k.image, width, height }, owner: k, source: null });
  }
}

/** The element a text piece belongs to: its parent's component. */
function ownerAbove(c: UIText): UIComponentType {
  const p = c._world.parentEntity(c.owner.entity);
  if (p >= 0) for (const k of c._world._componentsOf(p)) if (k instanceof UIText) return k;
  return c;
}

/**
 * HTML's whitespace collapsing across runs: runs of spaces, tabs and line breaks are one space; a space after a space (in
 * an earlier run too) or at a paragraph's start goes, and spaces before a line break run (`<br>`) or at the end go.
 * Line break runs are exactly "\n" and stay.
 */
function collapseRuns(runs: UIInlineRun[]): void {
  let space = true;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (r.text === "\n" && r.source && isBreak(r)) {
      trimBefore(runs, i);
      space = true;
      continue;
    }
    if (r.image) {
      space = false;
      continue;
    }
    let t = r.text.replace(/[ \t\n\r\f]+/g, " ");
    if (space && t.startsWith(" ")) t = t.slice(1);
    if (t !== "") space = t.endsWith(" ");
    if (t !== r.text) runs[i] = { ...r, text: t };
  }
  trimBefore(runs, runs.length);
}

/** True for a `<br>`'s run: a text whose text is exactly one line break and that has no children. */
function isBreak(r: UIInlineRun): boolean {
  return (r.source as UIText | null)?.text === "\n";
}

/** Drop the trailing space of the text before run `end` (the last run with text there). */
function trimBefore(runs: UIInlineRun[], end: number): void {
  for (let j = end - 1; j >= 0; j--) {
    const r = runs[j];
    if (r.image || (r.text === "\n" && isBreak(r))) return;
    if (r.text === "") continue;
    if (r.text.endsWith(" ")) runs[j] = { ...r, text: r.text.slice(0, -1) };
    return;
  }
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
  return a.text === b.text && a.fontSize === b.fontSize && a.fontWeight === b.fontWeight && a.fontFamily === b.fontFamily && a.lineHeight === b.lineHeight && a.wrap === b.wrap && a.direction === b.direction && a.align === b.align && a.editable === b.editable && sameRuns(a.runs, b.runs);
}

/** ADR 0425: true when two run lists are the same, run by run (style, owner and source included). */
function sameRuns(a: readonly UIInlineRun[] | undefined, b: readonly UIInlineRun[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.text !== y.text || x.fontSize !== y.fontSize || x.fontWeight !== y.fontWeight || x.fontStyle !== y.fontStyle || x.fontFamily !== y.fontFamily || x.color !== y.color || x.decoration !== y.decoration || x.background !== y.background || x.verticalAlign !== y.verticalAlign || x.shift !== y.shift || x.owner !== y.owner || x.source !== y.source) return false;
    if (x.image !== y.image && (!x.image || !y.image || x.image.src !== y.image.src || x.image.width !== y.image.width || x.image.height !== y.image.height)) return false;
  }
  return true;
}

/**
 * ADR 0425: true when two runs measure the same (what the text says and how it's set: colours, decorations and
 * backgrounds aside), so a colour change (a link's hover) redraws without laying out again.
 */
export function sameTextMeasure(a: UITextRun | null, b: UITextRun | null): boolean {
  if (a === b) return true;
  if (!a || !b) return false;
  if (a.text !== b.text || a.fontSize !== b.fontSize || a.fontWeight !== b.fontWeight || a.fontFamily !== b.fontFamily || a.lineHeight !== b.lineHeight || a.wrap !== b.wrap || a.editable !== b.editable) return false;
  const x = a.runs, y = b.runs;
  if (x === y) return true;
  if (!x || !y || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i], q = y[i];
    if (p.text !== q.text || p.fontSize !== q.fontSize || p.fontWeight !== q.fontWeight || p.fontStyle !== q.fontStyle || p.fontFamily !== q.fontFamily || p.verticalAlign !== q.verticalAlign || p.shift !== q.shift) return false;
    if (p.image !== q.image && (!p.image || !q.image || p.image.width !== q.image.width || p.image.height !== q.image.height)) return false;
  }
  return true;
}
