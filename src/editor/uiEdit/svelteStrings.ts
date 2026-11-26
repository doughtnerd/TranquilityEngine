// Localised and unlocalised text in a Svelte component's source (ADR 0356 §7, §9, ADR 0419 wave F), read from
// `parse()` through `svelteText.ts`: what the Localisation panel's unkeyed-text list and fit check, and the Inspector's
// Localise control, work from. It's the Svelte counterpart of what UI documents' markup gave them before ADR 0419.
//
// - **Text** is an element's text content and its literal attributes that show text: `placeholder` (fields), `title`,
//   `aria-label`, `alt` (images), `label` (options) and `value` of `<input type="button|submit|reset">`.
// - **Keyed** text is written as one `{t("key")}` (or `{@html tHtml("key")}`) call with a literal key, the whole text
//   content or attribute value; **literal** text is text with letters in it and no `{…}`; text mixing literal parts
//   with expressions or child elements is reported, but can't be localised as it is.
// - `translate="no"` on an element or an ancestor leaves its text out, as in HTML.
//
// Pure.
import type { KeyCall, SvelteElement, SvelteSource } from "./svelteText";

/** Literal attributes that show text, by element (`*`: any element). */
const TEXT_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  "*": ["title", "aria-label"],
  input: ["placeholder"],
  textarea: ["placeholder"],
  img: ["alt"],
  option: ["label"],
  optgroup: ["label"],
};

const BUTTON_INPUTS: ReadonlySet<string> = new Set(["button", "submit", "reset"]);

const hasLetters = (text: string): boolean => /\p{L}/u.test(text);
/** Text as it shows: whitespace collapsed and trimmed. */
const shown = (text: string): string => text.replace(/\s+/g, " ").trim();
const literalOf = (el: SvelteElement, name: string): string | null => {
  const v = el.attributes.find((a) => a.name === name)?.value;
  return v?.kind === "literal" ? v.text : null;
};

/** The names of the attributes of `el` that show text (`value` only on a button-like input). */
export function textAttributesOf(el: SvelteElement): string[] {
  const names = [...TEXT_ATTRIBUTES["*"], ...(TEXT_ATTRIBUTES[el.name] ?? [])];
  if (el.name === "input" && BUTTON_INPUTS.has((literalOf(el, "type") ?? "").toLowerCase())) names.push("value");
  return names;
}

/** True when `el` or an element it's inside says `translate="no"`. */
export function isUntranslated(el: SvelteElement): boolean {
  for (let at: SvelteElement | null = el; at; at = at.parent) if ((literalOf(at, "translate") ?? "").trim().toLowerCase() === "no") return true;
  return false;
}

/** One localisable part of an element: its text content (`text`) or a text attribute, and how it's written. */
export interface LocalisablePart {
  /** `text`, or the attribute's name. */
  readonly field: string;
  readonly state:
    | { readonly kind: "literal"; readonly text: string }
    | { readonly kind: "keyed"; readonly call: KeyCall }
    /** Written with expressions or holding elements: can't be localised as it is. */
    | { readonly kind: "dynamic"; readonly reason: string; readonly text: string };
}

/** How an element's text content is written, or null when it has none (no text, only elements). */
function textPart(source: SvelteSource, el: SvelteElement): LocalisablePart["state"] | null {
  const content = el.content;
  if (content.length === 0) return null;
  const expressions = content.filter((c) => c.kind === "expression");
  const texts = content.filter((c) => c.kind === "text");
  if (expressions.length === 1 && texts.length === 0 && expressions[0].kind === "expression" && expressions[0].call) return { kind: "keyed", call: expressions[0].call };
  const literal = shown(texts.map((t) => (t.kind === "text" ? t.text : "")).join(" "));
  if (expressions.length > 0) {
    const written = source.text.slice(content[0].start, content[content.length - 1].end).trim();
    return { kind: "dynamic", reason: `its text has expressions (${written}): only literal text can be localised; write it as t() in the Code panel`, text: literal || written };
  }
  if (!hasLetters(literal)) return null;
  if (el.children.length > 0) return { kind: "dynamic", reason: "it has elements inside: localise the text of each part, or write it as one message with tHtml() in the Code panel", text: literal };
  return { kind: "literal", text: literal };
}

/** The localisable parts of `el`: its text content and the text attributes it has, each as written. */
export function localisableParts(source: SvelteSource, el: SvelteElement): LocalisablePart[] {
  const out: LocalisablePart[] = [];
  const text = textPart(source, el);
  if (text) out.push({ field: "text", state: text });
  for (const name of textAttributesOf(el)) {
    const a = el.attributes.find((x) => x.name === name);
    if (!a || a.value.kind === "boolean") continue;
    if (a.value.kind === "literal") {
      if (a.value.text.trim() !== "") out.push({ field: name, state: { kind: "literal", text: a.value.text } });
    } else if (a.value.call) out.push({ field: name, state: { kind: "keyed", call: a.value.call } });
    else out.push({ field: name, state: { kind: "dynamic", reason: `${name} is an expression (${a.value.source}): write it as t() in the Code panel`, text: a.value.source } });
  }
  return out;
}

/** Literal text that isn't bound to a key, in a component file. */
export interface UnkeyedText {
  readonly path: string;
  /** `text` (its text content), or the attribute that shows it. */
  readonly field: string;
  /** The literal text (its literal parts, for text mixed with expressions or elements). */
  readonly text: string;
  /** `#id` or `<tag>`. */
  readonly where: string;
  /** The element's id when it has a literal one (Extract to string table suggests a key from it). */
  readonly id: string | null;
  /** Where the element starts: 1-based line, 0-based column (its template location). */
  readonly line: number;
  readonly column: number;
  /** False when it's mixed with expressions or elements, so Localise can't replace it as it is. */
  readonly literal: boolean;
}

/** The id a dismissal of unkeyed text is kept under (`.myco/localisation-ignore.json`): its file, where and field, and the text. */
export const unkeyedId = (u: Pick<UnkeyedText, "path" | "where" | "field" | "text">): string => `${u.path}|${u.where}|${u.field}|${u.text}`;

function lineColumn(text: string, offset: number): { line: number; column: number } {
  const before = text.slice(0, offset);
  const nl = before.lastIndexOf("\n");
  return { line: before.split("\n").length, column: offset - nl - 1 };
}

/** Every piece of unkeyed text in a component's template (not under `translate="no"`), in source order. */
export function unkeyedTextIn(path: string, source: SvelteSource): UnkeyedText[] {
  const out: UnkeyedText[] = [];
  for (const el of source.elements) {
    if (isUntranslated(el)) continue;
    const id = literalOf(el, "id") || null;
    const where = id ? `#${id}` : `<${el.name}>`;
    const at = lineColumn(source.text, el.start);
    for (const part of localisableParts(source, el)) {
      const s = part.state;
      if (s.kind === "keyed") continue;
      if (s.kind === "dynamic" && (part.field !== "text" || !hasLetters(s.text) || s.text.startsWith("{"))) continue; // an attribute expression, or text that's all expressions
      if (s.kind === "literal" && !hasLetters(s.text)) continue;
      out.push({ path, field: part.field, text: s.kind === "literal" ? shown(s.text) : s.text, where, id, ...at, literal: s.kind === "literal" });
    }
  }
  return out;
}

/** The key an element's whole text content shows (`<p>{t("menu.start")}</p>`), or null. */
export function textKeyOf(source: SvelteSource, el: SvelteElement): KeyCall | null {
  const s = textPart(source, el);
  return s?.kind === "keyed" ? s.call : null;
}
