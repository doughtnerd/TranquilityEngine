/**
 * HTML tag names and the UI elements they make (ADR 0419): game UI written in Svelte uses HTML tags, which
 * the engine's renderer maps onto the UI core's element kinds. The cascade matches the tag as written
 * (`div`, `button`), so the stylesheet parser accepts these names in selectors too. Renderer-neutral data;
 * not public API.
 *
 * ADR 0424: HTML's form elements have kinds of their own: `<textarea>`, `<select>`/`<option>`, `<progress>`, `<meter>`,
 * `<label>` and `<form>`, and `<input>` by its `type` (`uiTagOfInput`): `checkbox`, `radio` and `range` are a Toggle,
 * a Radio and a Slider, the text-like types an InputField.
 */
import type { UITag } from "../document/types";

const PANEL = ["div", "section", "nav", "main", "header", "footer", "article", "aside", "ul", "ol", "li", "fieldset", "figure", "dialog", "menu", "address", "hgroup", "search", "details", "optgroup"];
const TEXT = ["span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "strong", "em", "b", "i", "small", "a", "code", "pre", "blockquote", "figcaption", "legend", "summary",
  // ADR 0425: the other phrasing elements, inline runs inside a text element; `br` is a line break run.
  "u", "s", "sub", "sup", "mark", "del", "ins", "strike", "abbr", "cite", "kbd", "samp", "var", "dfn", "q", "time", "data", "bdi", "bdo", "br"];

/** Every HTML tag with a UI element of its own, by lowercase name. */
export const HTML_TAGS: ReadonlyMap<string, UITag> = new Map<string, UITag>([
  ...PANEL.map((t) => [t, "Panel"] as const),
  ...TEXT.map((t) => [t, "Text"] as const),
  ["img", "Image"],
  ["button", "Button"],
  ["input", "InputField"],
  ["textarea", "TextArea"],
  ["select", "Select"],
  ["option", "Option"],
  ["progress", "Progress"],
  ["meter", "Meter"],
  ["label", "Label"],
  ["form", "Form"],
  // ADR 0426: an inline SVG (its shapes stay an SVG subtree, drawn as an image), video and audio.
  ["svg", "Svg"],
  ["video", "Video"],
  ["audio", "Audio"],
]);

/**
 * ADR 0426: the SVG elements kept inside an `<svg>` (by lowercase name): its shapes, groups, text, references, definitions
 * and paint servers. They aren't UI elements: the renderer keeps them as the `<svg>`'s SVG document.
 */
export const SVG_CONTENT_TAGS: ReadonlySet<string> = new Set([
  "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "g", "text", "tspan", "textpath", "use", "defs", "symbol",
  "lineargradient", "radialgradient", "stop", "pattern", "clippath", "mask", "marker", "image", "title", "desc", "switch", "foreignobject", "style",
]);

/** The UI element an HTML tag makes, or null for a tag without one (the renderer makes those a Panel, with a warning). */
export function uiTagOfHtml(tag: string): UITag | null {
  return HTML_TAGS.get(tag.toLowerCase()) ?? null;
}

/** ADR 0424: `<input type>`s that make an InputField, and the field `type` each is (the others are plain text). */
const FIELD_TYPES: ReadonlyMap<string, "text" | "password" | "number"> = new Map([
  ["text", "text"], ["search", "text"], ["email", "text"], ["tel", "text"], ["url", "text"], ["password", "password"], ["number", "number"],
]);

/**
 * ADR 0424: the UI element an `<input>` of `type` makes: a Toggle (`checkbox`), a Radio (`radio`), a Slider (`range`),
 * else an InputField; `known` is false for a type the UI has no control for (`date`, `color`, `file`…), drawn as a text field.
 */
export function uiTagOfInput(type: string | null | undefined): { readonly tag: UITag; readonly fieldType: "text" | "password" | "number"; readonly known: boolean } {
  const t = (type ?? "text").toLowerCase();
  if (t === "checkbox") return { tag: "Toggle", fieldType: "text", known: true };
  if (t === "radio") return { tag: "Radio", fieldType: "text", known: true };
  if (t === "range") return { tag: "Slider", fieldType: "text", known: true };
  const fieldType = FIELD_TYPES.get(t);
  return { tag: "InputField", fieldType: fieldType ?? "text", known: fieldType !== undefined };
}
