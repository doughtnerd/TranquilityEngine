/**
 * HTML tag names and the UI elements they make (ADR 0419): game UI written in Svelte uses HTML tags, which
 * the engine's renderer maps onto the UI core's element kinds. The cascade matches the tag as written
 * (`div`, `button`), so the stylesheet parser accepts these names in selectors too. Renderer-neutral data;
 * not public API.
 */
import type { UITag } from "../document/types";

const PANEL = ["div", "section", "nav", "main", "header", "footer", "article", "aside", "ul", "ol", "li", "form", "fieldset", "figure", "dialog", "menu", "address", "hgroup", "search", "details"];
const TEXT = ["span", "p", "h1", "h2", "h3", "h4", "h5", "h6", "label", "strong", "em", "b", "i", "small", "a", "code", "pre", "blockquote", "figcaption", "legend", "summary"];

/** Every HTML tag with a UI element of its own, by lowercase name. */
export const HTML_TAGS: ReadonlyMap<string, UITag> = new Map<string, UITag>([
  ...PANEL.map((t) => [t, "Panel"] as const),
  ...TEXT.map((t) => [t, "Text"] as const),
  ["img", "Image"],
  ["button", "Button"],
  ["input", "InputField"],
  ["textarea", "InputField"],
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
