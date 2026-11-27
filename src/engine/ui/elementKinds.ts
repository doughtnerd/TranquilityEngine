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
import { UIAudio, UIButton, UICanvas, UIForm, UIImage, UIInputField, UILabel, UIMeter, UIOption, UIPanel, UIProgress, UIRadio, UISelect, UISlider, UISvg, UIText, UITextArea, UIToggle, UIVideo, type UIComponentType, type UIOverflow, type UITextAlign, type UIVerticalAlign, type UIWhiteSpaceCollapse, type UIWordBreak } from "./components";
import { selectLabel } from "./formControls";
import { uiInteractions } from "./interactions";
import type { UIPseudo, UIPseudoState, UITag } from "./document/types";
import { fontFamilyOf } from "./fonts";
import { uiBorderEdges, uiEdges } from "./layout";
import type { UIInlineAtomSize, UIInlineBox, UIInlineRun, UIKind, UITextRun, UITextWrap } from "./uiCoreTypes";

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
  // ADR 0428: a text and its runs are `:hover` under the pointer and `:active` pressed (per run); a border paints too.
  {
    kind: "text", type: UIText, tag: "Text", leaf: true, interactive: false, flexShrink: 1,
    pseudo: (c: UIText) => ({ hover: uiInteractions(c._world).isTextHovered(c), pressed: uiInteractions(c._world).isTextPressed(c) }),
    paints: (c: UIText) => visible(c.backgroundColor) || (uiBorderEdges(c).some((w) => w > 0) && visible(c.borderColor)) || textRunOf(c)!.text.trim() !== "",
    graphic: always,
  } as KindSpec<UIText> as KindSpec,
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

/**
 * ADR 0428: the base direction an element's text is laid out in: its own `direction`, else the nearest ancestor's below
 * its canvas (HTML's `dir`), else the current language's (ADR 0356 §5), as before `direction` existed.
 */
function textDirectionOf(c: UIComponentType): "ltr" | "rtl" {
  const world = c._world;
  for (let e = c.owner.entity; e >= 0; e = world.parentEntity(e)) {
    for (const k of world._componentsOf(e)) {
      if (k instanceof UICanvas) return Locale.direction;
      const d = (k as { direction?: string | null }).direction;
      if (isUIKind(k) && (d === "ltr" || d === "rtl")) return d;
    }
  }
  return Locale.direction;
}

/** A `textAlign` value as an edge: `start` and `end` resolved for the direction (ADR 0356 §5). */
function textAlignEdge(align: UITextAlign, direction: "ltr" | "rtl"): UITextRun["align"] {
  if (align === "start") return direction === "rtl" ? "right" : "left";
  if (align === "end") return direction === "rtl" ? "left" : "right";
  return align === "center" || align === "right" || align === "justify" ? align : "left";

}
/**
 * ADR 0428: an atomic inline box's size (its margin box and baseline), as its UI core last laid it out; null while it
 * hasn't been (it takes no room).
 */
export type UIInlineAtomSizes = (c: UIComponentType) => UIInlineAtomSize | null;

/**
 * The text an element shows, resolved: a `UIText`'s text, or an input field's value (its placeholder
 * while empty) on one line. Null for kinds without text. A fresh object each call. ADR 0428: `atoms` gives the sizes of
 * atomic inline boxes inside a text (the UI core's layouts of them); without it they take no room.
 */
export function textRunOf(c: UIComponentType, atoms?: UIInlineAtomSizes): UITextRun | null {
  if (c instanceof UITextArea) {
    // ADR 0424: lines as typed, wrapped at its width unless `wrap` is `off`; a password-like mask doesn't apply.
    const direction = textDirectionOf(c);
    return { text: c.value || c.placeholder, fontSize: c.fontSize, fontWeight: "400", fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: c.wrap === "off" ? "none" : "word", direction, align: textAlignEdge("start", direction) };
  }
  if (c instanceof UISelect) {
    // ADR 0424: the chosen option's label, on one line.
    const direction = textDirectionOf(c);
    return { text: selectLabel(c).replace(/[\r\n]/g, " "), fontSize: c.fontSize, fontWeight: "400", fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: "none", direction, align: textAlignEdge("start", direction) };
  }
  if (c instanceof UIInputField) {
    // One line: a line break a script put in the value shows as a space (one for one, so caret indices still match).
    // ADR 0424: a password's characters show as dots (one each, so caret indices still match).
    const shown = c.value && c.type === "password" ? "•".repeat(c.value.length) : c.value;
    const text = (shown || c.placeholder).replace(/[\r\n]/g, " ");
    // Drawn from the language's start edge (ADR 0356 §5).
    const direction = textDirectionOf(c);
    return { text, fontSize: c.fontSize, fontWeight: "400", fontFamily: fontFamilyOf(c.font), lineHeight: UI_LINE_HEIGHT, wrap: "none", direction, align: textAlignEdge("start", direction) };
  }
  if (c instanceof UIText) {
    const direction = textDirectionOf(c);
    const fontFamily = fontFamilyOf(c.font);
    // ADR 0428: `text-wrap-mode: nowrap` keeps lines whole (an editable text wraps, as `pre-wrap`).
    const nowrap = !c.contentEditable && c.textWrapMode === "nowrap";
    const wrap: UITextWrap = nowrap ? "none" : (WRAPS[c.wordBreak] ?? "word");
    const run = { text: c.text, fontSize: c.fontSize, fontWeight: cssFontWeight(c.fontWeight), fontFamily, lineHeight: UI_LINE_HEIGHT, wrap, direction, align: textAlignEdge(c.textAlign, direction) };
    // ADR 0425: inline children make runs (an editable text always has them: its caret and selection are placed by them).
    // ADR 0428: so does plain text whose spaces take room at a line's end (`break-spaces`): the inline layout places them.
    const inline = inlineRunsOf(c, fontFamily, atoms ?? NO_ATOMS);
    if (!inline) return { ...run, text: whiteSpaceText(c.text, c.whiteSpaceCollapse) };
    const { runs, boxes } = inline;
    let text = "";
    for (const r of runs) text += r.text;
    // A text that doesn't wrap still wraps inside a run that does (`white-space: normal` on a span in it).
    const runWrap: UITextWrap = nowrap && runs.some((r) => !r.nowrap && !r.image && !r.atom && r.text !== "\n") ? (WRAPS[c.wordBreak] ?? "word") : wrap;
    const out: UITextRun = { ...run, wrap: runWrap, text, runs, ...(boxes.length ? { boxes } : {}) };
    return c.contentEditable ? { ...out, editable: true } : out;
  }
  return null;
}

const NO_ATOMS: UIInlineAtomSizes = () => null;

// --- White space (ADR 0428) ----------------------------------------------------------------------

/** Tabs as spaces up to the next multiple of 8 columns (CSS's default `tab-size`), counting from each line's start. */
function expandTabs(text: string, column = 0): string {
  if (!text.includes("\t")) return text;
  let out = "";
  for (const ch of text) {
    if (ch === "\n") column = 0;
    if (ch === "\t") {
      const n = 8 - (column % 8);
      out += " ".repeat(n);
      column += n;
      continue;
    }
    out += ch;
    if (ch !== "\n") column++;
  }
  return out;
}

/**
 * A plain text's text under its white space rules (CSS Text 4): `collapse` makes each run of spaces, tabs and line breaks
 * one space and drops it at the start and end; `preserve-breaks` keeps line breaks and does that to the spaces around
 * and between them; `preserve` and `break-spaces` keep everything, tabs as spaces to the next tab stop.
 */
function whiteSpaceText(text: string, mode: UIWhiteSpaceCollapse): string {
  switch (mode) {
    case "preserve-breaks":
      return text.replace(/\r\n?/g, "\n").split("\n").map((l) => l.replace(/[ \t\f\r]+/g, " ").trim()).join("\n");
    case "preserve":
    case "break-spaces":
      return expandTabs(text.replace(/\r\n?/g, "\n"));
    default:
      return text.replace(/[ \t\n\r\f]+/g, " ").trim();
  }
}

// --- Inline runs (ADR 0425) ----------------------------------------------------------------------

const OBJECT = "￼";

/** A colour as CSS text. */
function cssColor(c: { r: number; g: number; b: number; a: number }): string {
  return `rgba(${Math.round(c.r * 255)}, ${Math.round(c.g * 255)}, ${Math.round(c.b * 255)}, ${c.a})`;
}

/** A plain image inside a text: an inline image run (not an inline SVG or video, which are boxes of their own). */
const isPlainImage = (c: UIComponentType): c is UIImage => c instanceof UIImage && !(c instanceof UISvg) && !(c instanceof UIVideo);

/**
 * ADR 0428: true for an element inside a text that lays out as an atomic inline box, in a Yoga tree of its own, rather
 * than as runs of the text: `display: inline-block` or `inline-flex`, and every element that isn't phrasing text or a
 * plain image (a button, a form control, an SVG, a video or audio element, a panel).
 */
export function isInlineAtom(c: UIComponentType): boolean {
  if (c instanceof UICanvas) return false;
  if (c.display === "inline-block" || c.display === "inline-flex") return true;
  return !(c instanceof UIText) && !isPlainImage(c);
}

/** A node's inline children: its UI components, in order, shown (active, enabled, not `display: none`). */
function inlineChildren(c: UIText): Exclude<UIComponentType, UICanvas>[] {
  const world = c._world;
  const out: Exclude<UIComponentType, UICanvas>[] = [];
  for (const e of world.childEntities(c.owner.entity)) {
    for (const k of world._componentsOf(e)) {
      if (!isUIKind(k) || k instanceof UICanvas || k._destroyed) continue;
      if (k.isActiveAndEnabled && k.display !== "none") out.push(k);
      break;
    }
  }
  return out;
}

/** True for one of the UI kinds' components. */
function isUIKind(k: unknown): k is UIComponentType {
  for (const t of UI_KIND_TYPES) if (k instanceof t) return true;
  return false;
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

/** An element's own baseline shift: `sub` lowers, `super` raises (ADR 0425), by its font size (a text's, else its text's). */
function shiftOf(va: UIVerticalAlign, fontSize: number): number {
  return va === "sub" ? -0.25 * fontSize : va === "super" ? 0.45 * fontSize : 0;
}

/** Its `vertical-align` as a run takes it: `sub` and `super` are shifts, so `baseline`. */
const alignOf = (va: UIVerticalAlign): UIVerticalAlign => (va === "sub" || va === "super" ? "baseline" : (va ?? "baseline"));

/** What building a text's runs carries: the runs, its inline boxes, the atomic boxes' sizes, and whether it's editable. */
interface RunBuild {
  readonly out: UIInlineRun[];
  readonly boxes: UIInlineBox[];
  readonly atoms: UIInlineAtomSizes;
  readonly editable: boolean;
}

/**
 * A text element's inline runs (ADR 0425): its own text, then each inline child's runs in order (a child text's own
 * text, then its children's, depth first; an image or (ADR 0428) an atomic inline box as one U+FFFC run), with white
 * space collapsed across runs by each run's rules (unless the text is editable, which keeps it as typed). Null when it
 * has no inline children, isn't editable and keeps no spaces at line ends: plain text, one run, as before.
 */
function inlineRunsOf(c: UIText, family: string, atoms: UIInlineAtomSizes): { runs: UIInlineRun[]; boxes: UIInlineBox[] } | null {
  const children = inlineChildren(c);
  if (!children.length && !c.contentEditable && c.whiteSpaceCollapse !== "break-spaces") return null;
  const b: RunBuild = { out: [], boxes: [], atoms, editable: c.contentEditable };
  const base: InlineContext = { decoration: "", background: null, shift: 0, family, hidden: false };
  pushRuns(c, base, b, true);
  if (!c.contentEditable) collapseRuns(b.out);
  else if (!b.out.length) b.out.push(textRun(c, "", base, c, true));
  return { runs: b.out, boxes: b.boxes };
}

function textRun(c: UIText, text: string, ctx: InlineContext, owner: UIComponentType, editable: boolean): UIInlineRun {
  const run: UIInlineRun = {
    text,
    fontSize: c.fontSize,
    fontWeight: cssFontWeight(c.fontWeight),
    fontStyle: c.fontStyle === "normal" ? "normal" : "italic",
    fontFamily: ctx.family,
    color: ctx.hidden ? "rgba(0, 0, 0, 0)" : cssColor(c.color),
    decoration: ctx.hidden ? "" : ctx.decoration,
    background: ctx.hidden ? null : ctx.background,
    verticalAlign: alignOf(c.verticalAlign),
    shift: ctx.shift,
    image: null,
    owner,
    source: c,
  };
  if (editable) return run;
  // ADR 0428: the white space rules that change line breaking, only where they apply (plain runs compare as before).
  const nowrap = c.textWrapMode === "nowrap";
  const keepSpaces = c.whiteSpaceCollapse === "break-spaces" || (nowrap && c.whiteSpaceCollapse === "preserve");
  return nowrap || keepSpaces ? { ...run, ...(nowrap ? { nowrap } : {}), ...(keepSpaces ? { keepSpaces } : {}) } : run;
}

/** ADR 0428: an inline element's box (its padding, border and horizontal margins), or null when it has none of them. */
function boxOf(c: UIText, first: number, last: number, ctx: InlineContext): UIInlineBox | null {
  const padding = uiEdges(c.padding, c.paddingTop, c.paddingRight, c.paddingBottom, c.paddingLeft).map((v) => Math.max(0, v)) as [number, number, number, number];
  const margins = uiEdges(c.margin, c.marginTop, c.marginRight, c.marginBottom, c.marginLeft);
  const border = uiBorderEdges(c);
  const margin: [number, number] = [margins[3], margins[1]];
  if (!padding.some((v) => v > 0) && !border.some((v) => v > 0) && margin[0] === 0 && margin[1] === 0) return null;
  const bg = c.backgroundColor && c.backgroundColor.a > 0 && !ctx.hidden ? cssColor(c.backgroundColor) : null;
  return { owner: c, first, last, margin, border, padding, fontSize: c.fontSize, shift: ctx.shift, background: bg, borderColor: ctx.hidden ? "rgba(0, 0, 0, 0)" : cssColor(c.borderColor), radius: Math.max(0, c.borderRadius || 0) };
}

function pushRuns(c: UIText, outer: InlineContext, b: RunBuild, root: boolean): void {
  const out = b.out;
  // The text element itself paints its background over its box (it's drawn by the drawing layer), not behind its runs.
  // ADR 0428: so does an inline element with a box (padding, a border or margins): its runs don't paint it again.
  const boxIndex = root ? -1 : b.boxes.length;
  if (!root) b.boxes.push(null as unknown as UIInlineBox); // its place, outer boxes before inner ones
  const first = out.length;
  const ownShift = shiftOf(c.verticalAlign, c.fontSize);
  const ownBackground = c.backgroundColor && c.backgroundColor.a > 0 ? cssColor(c.backgroundColor) : null;
  const ctx: InlineContext = root
    ? { ...outer, decoration: decorationsOf(c.textDecoration, "") }
    : {
        decoration: decorationsOf(c.textDecoration, outer.decoration),
        background: ownBackground ?? outer.background,
        shift: outer.shift + ownShift,
        family: c.font ? fontFamilyOf(c.font) : outer.family,
        hidden: outer.hidden || !c.visible,
      };
  const box = root ? null : boxOf(c, first, first, ctx);
  const inner: InlineContext = box ? { ...ctx, background: outer.background } : ctx;
  // A text piece's events go to the element it's in, as a generated `::before`/`::after`'s do (ADR 0428).
  const owner = c._textPiece || c._pseudo ? ownerAbove(c) : c;
  const children = inlineChildren(c);
  // ADR 0428: a `::before` comes before the element's own text (a run, or an atomic box when it's `inline-block`).
  const before = children[0] instanceof UIText && children[0]._pseudo === "before" ? children[0] : null;
  const rest = before ? children.slice(1) : children;
  if (before) pushChild(c, before, inner, b);
  if (c.text !== "") out.push(textRun(c, c.text, inner, owner, b.editable));
  for (const k of rest) pushChild(c, k, inner, b);
  if (boxIndex >= 0) {
    if (box && out.length > first) b.boxes[boxIndex] = { ...box, last: out.length - 1 };
    else b.boxes.splice(boxIndex, 1);
  }
}

/** One inline child's runs: an atomic inline box's object run, a child text's runs, or an image's object run. */
function pushChild(c: UIText, k: Exclude<UIComponentType, UICanvas>, inner: InlineContext, b: RunBuild): void {
  const out = b.out;
  if (isInlineAtom(k)) {
    // ADR 0428: an atomic inline box: one object run, the size of its own layout's margin box.
    const va = (k as { verticalAlign?: UIVerticalAlign }).verticalAlign ?? "baseline";
    const size = b.atoms(k) ?? { width: 0, height: 0, baseline: 0 };
    out.push({ ...textRun(c, OBJECT, inner, k, b.editable), verticalAlign: alignOf(va), shift: inner.shift + shiftOf(va, c.fontSize), decoration: "", background: null, atom: { width: size.width, height: size.height, baseline: size.baseline }, owner: k, source: null });
    return;
  }
  if (k instanceof UIText) {
    // A child text, a `<br>` (a line break in the run's style) or a generated `::before`/`::after` (ADR 0428).
    pushRuns(k, inner, b, false);
    return;
  }
  const img = k as UIImage;
  const size = c.fontSize;
  const w = pixelsOr(img.width, NaN), h = pixelsOr(img.height, NaN);
  const width = Number.isFinite(w) ? w : Number.isFinite(h) ? h : size;
  const height = Number.isFinite(h) ? h : width;
  const va = img.verticalAlign ?? "baseline";
  out.push({ ...textRun(c, OBJECT, inner, img, b.editable), verticalAlign: alignOf(va), shift: inner.shift + shiftOf(va, c.fontSize), decoration: "", background: null, image: { src: img.image, width, height }, owner: img, source: null });
}

/** The element a text piece belongs to: its parent's component. */
function ownerAbove(c: UIText): UIComponentType {
  const p = c._world.parentEntity(c.owner.entity);
  if (p >= 0) for (const k of c._world._componentsOf(p)) if (k instanceof UIText) return k;
  return c;
}

/** ADR 0428: a run's white space rules for collapsing (its source text's; objects and line breaks have none). */
function collapseOf(r: UIInlineRun): UIWhiteSpaceCollapse {
  return (r.source as UIText | null)?.whiteSpaceCollapse ?? "collapse";
}

/** A run whose spaces collapse (and so can be dropped at a line's end or before a line break). */
const collapsible = (r: UIInlineRun) => {
  const m = collapseOf(r);
  return m === "collapse" || m === "preserve-breaks";
};

/**
 * White space collapsing across runs (HTML's, by each run's `white-space-collapse`, ADR 0428): in a run that collapses,
 * spaces, tabs and line breaks are one space, and a space after a collapsible space (in an earlier run too) or at a line's
 * start goes; `preserve-breaks` keeps line breaks (spaces around them go); `preserve` and `break-spaces` keep everything
 * (tabs as spaces). Collapsible spaces before a line break (a `<br>` run, a kept one) or at the end go. `<br>` runs are
 * exactly "\n" and stay.
 */
function collapseRuns(runs: UIInlineRun[]): void {
  let space = true; // at a line's start, or after a collapsible space
  let column = 0;
  for (let i = 0; i < runs.length; i++) {
    const r = runs[i];
    if (isBreak(r)) {
      trimBefore(runs, i);
      space = true;
      column = 0;
      continue;
    }
    if (r.image || r.atom) {
      space = false;
      column++;
      continue;
    }
    const mode = collapseOf(r);
    let t = r.text;
    if (mode === "collapse") {
      t = t.replace(/[ \t\n\r\f]+/g, " ");
      if (space && t.startsWith(" ")) t = t.slice(1);
      if (t !== "") space = t.endsWith(" ");
    } else if (mode === "preserve-breaks") {
      t = t.replace(/\r\n?/g, "\n").replace(/[ \t\f\r]+/g, " ").replace(/ ?\n ?/g, "\n");
      if (space && t.startsWith(" ")) t = t.slice(1);
      if (t.startsWith("\n")) trimBefore(runs, i);
      if (t !== "") space = t.endsWith(" ") || t.endsWith("\n");
    } else {
      t = expandTabs(t.replace(/\r\n?/g, "\n"), column);
      if (t.startsWith("\n")) trimBefore(runs, i);
      if (t !== "") space = t.endsWith("\n");
    }
    const nl = t.lastIndexOf("\n");
    column = nl < 0 ? column + t.length : t.length - nl - 1;
    if (t !== r.text) runs[i] = { ...r, text: t };
  }
  trimBefore(runs, runs.length);
}

/** True for a `<br>`'s run (ADR 0428: the host marks `<br>` elements; text that is only a line break isn't one). */
function isBreak(r: UIInlineRun): boolean {
  return r.text === "\n" && !!(r.source as UIText | null)?._lineBreak;
}

/** Drop the trailing collapsible space of the text before run `end` (the last run with text there). */
function trimBefore(runs: UIInlineRun[], end: number): void {
  for (let j = end - 1; j >= 0; j--) {
    const r = runs[j];
    if (r.image || r.atom || isBreak(r)) return;
    if (r.text === "") continue;
    if (r.text.endsWith(" ") && collapsible(r)) runs[j] = { ...r, text: r.text.slice(0, -1) };
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
  return a.text === b.text && a.fontSize === b.fontSize && a.fontWeight === b.fontWeight && a.fontFamily === b.fontFamily && a.lineHeight === b.lineHeight && a.wrap === b.wrap && a.direction === b.direction && a.align === b.align && a.editable === b.editable && sameRuns(a.runs, b.runs) && sameBoxes(a.boxes, b.boxes, true);
}

/** ADR 0428: true when two atomic boxes' sizes are the same. */
function sameAtom(x: UIInlineAtomSize | null | undefined, y: UIInlineAtomSize | null | undefined): boolean {
  return x === y || (!!x && !!y && x.width === y.width && x.height === y.height && x.baseline === y.baseline) || (!x && !y);
}

/** ADR 0428: true when two box lists are the same (with `paint`, their colours too; else only what lays them out). */
function sameBoxes(a: readonly UIInlineBox[] | undefined, b: readonly UIInlineBox[] | undefined, paint: boolean): boolean {
  if (a === b) return true;
  const x = a ?? [], y = b ?? [];
  if (x.length !== y.length) return false;
  const same = (p: readonly number[], q: readonly number[]) => p.every((v, i) => v === q[i]);
  for (let i = 0; i < x.length; i++) {
    const p = x[i], q = y[i];
    if (p.owner !== q.owner || p.first !== q.first || p.last !== q.last || p.fontSize !== q.fontSize || p.shift !== q.shift || !same(p.margin, q.margin) || !same(p.border, q.border) || !same(p.padding, q.padding)) return false;
    if (paint && (p.background !== q.background || p.borderColor !== q.borderColor || p.radius !== q.radius)) return false;
  }
  return true;
}

/** ADR 0425: true when two run lists are the same, run by run (style, owner and source included). */
function sameRuns(a: readonly UIInlineRun[] | undefined, b: readonly UIInlineRun[] | undefined): boolean {
  if (a === b) return true;
  if (!a || !b || a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.text !== y.text || x.fontSize !== y.fontSize || x.fontWeight !== y.fontWeight || x.fontStyle !== y.fontStyle || x.fontFamily !== y.fontFamily || x.color !== y.color || x.decoration !== y.decoration || x.background !== y.background || x.verticalAlign !== y.verticalAlign || x.shift !== y.shift || x.owner !== y.owner || x.source !== y.source || !!x.nowrap !== !!y.nowrap || !!x.keepSpaces !== !!y.keepSpaces) return false;
    if (x.image !== y.image && (!x.image || !y.image || x.image.src !== y.image.src || x.image.width !== y.image.width || x.image.height !== y.image.height)) return false;
    if (!sameAtom(x.atom, y.atom)) return false;
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
  if (!sameBoxes(a.boxes, b.boxes, false)) return false;
  const x = a.runs, y = b.runs;
  if (x === y) return true;
  if (!x || !y || x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const p = x[i], q = y[i];
    if (p.text !== q.text || p.fontSize !== q.fontSize || p.fontWeight !== q.fontWeight || p.fontStyle !== q.fontStyle || p.fontFamily !== q.fontFamily || p.verticalAlign !== q.verticalAlign || p.shift !== q.shift || !!p.nowrap !== !!q.nowrap || !!p.keepSpaces !== !!q.keepSpaces) return false;
    if (p.image !== q.image && (!p.image || !q.image || p.image.width !== q.image.width || p.image.height !== q.image.height)) return false;
    if (!sameAtom(p.atom, q.atom)) return false;
  }
  return true;
}
