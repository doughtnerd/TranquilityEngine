// The text fit check (ADR 0356 §8), best effort: every UI document element bound to a key (`t:text`, `t:placeholder`,
// `t:value`) whose box has a fixed size, laid out in each language and the pseudo-language with the engine's line
// breaking and a text measurer (the editor passes the engine's canvas measuring, `render/babylon/ui.ts`
// `measureText`; tests the UI core's estimate), and reported when its text doesn't fit: more lines than the box's
// height holds, or wider than the box (a word longer than the width, or wrapping off).
//
// Each message is formatted from its key's `examples`; arguments without one take long stand-ins (numbers `88888`,
// strings `WWWWWWWW`). A language without the key falls back through its chain, as the runtime does. What it doesn't
// do: resolve stylesheet rules or flex layout (a box is sized only by its own `width`, `height`, `font-size` and
// `word-break` attributes), so elements sized by their parent are skipped and counted.
//
// Pure: no DOM; the measurer is a port.
import { fallbackChain, intlTagOf, shippedLanguages, type LanguageSettings } from "../../../engine/localisation/languages";
import { messageArguments } from "../../../engine/localisation/message/check";
import { formatMessage, type MessageArgs } from "../../../engine/localisation/message/format";
import { parseMessage } from "../../../engine/localisation/message/parse";
import { accentMessage, isPseudoLanguage, PSEUDO_LANGUAGE, pseudoWrap } from "../../../engine/localisation/pseudo";
import { translationOf, type ExchangeProject } from "../../../engine/localisation/exchange/model";
import { hasBinding, parseMarkup } from "../../../engine/ui/document/markup";
import type { MarkupElement } from "../../../engine/ui/document/types";
import { UI_LINE_HEIGHT } from "../../../engine/ui/elementKinds";
import { UI_FONT_FAMILY } from "../../../engine/ui/fonts";
import type { TextMeasureRequest, UITextWrap } from "../../../engine/ui/uiCoreTypes";

/** Measures text in UI pixels, wrapped to `maxWidth` as `wrap` says (`UICoreHost.measureText`'s contract). */
export type FitMeasure = (request: TextMeasureRequest) => { width: number; height: number };

export interface FitOverflow {
  readonly path: string;
  /** `#id` or the element's tag. */
  readonly where: string;
  readonly key: string;
  readonly language: string;
  readonly text: string;
  /** `lines`: taller than the box; `width`: wider than it. */
  readonly reason: "lines" | "width";
  readonly needed: { readonly width: number; readonly height: number };
  readonly box: { readonly width: number | null; readonly height: number | null };
}

export interface FitResult {
  /** Elements laid out (each in every language). */
  readonly checked: number;
  /** Keyed elements not checked: no fixed width, or a key template. */
  readonly skipped: number;
  readonly overflows: readonly FitOverflow[];
  /** The languages checked. */
  readonly languages: readonly string[];
}

const WRAPS: Readonly<Record<string, UITextWrap>> = { "break-word": "word", "break-all": "anywhere", "keep-all": "none" };

const px = (raw: string | undefined): number | null => {
  if (raw === undefined) return null;
  const m = /^\s*(\d+(?:\.\d+)?)(px)?\s*$/.exec(raw);
  return m ? Number(m[1]) : null;
};

const attr = (el: MarkupElement, ...names: string[]) => el.attributes.find((a) => names.includes(a.name))?.value;

/** The message `key` shows in `code`, through its chain (a pseudo-language: the reference's, transformed). */
function messageIn(project: ExchangeProject, key: string, code: string): { text: string; pseudo: boolean; tag: string } | null {
  const s: LanguageSettings = project.languages;
  const pseudo = isPseudoLanguage(code);
  const chain = pseudo ? fallbackChain(s, s.reference) : fallbackChain(s, code);
  for (const t of project.tables) {
    const e = t.table.strings.find((x) => x.key === key);
    if (!e) continue;
    for (const c of chain) {
      const text = c === s.reference ? e.text : translationOf(t, c)?.strings[key]?.text;
      if (text !== undefined) return { text, pseudo, tag: intlTagOf(s, pseudo ? s.reference : code) };
    }
    return null;
  }
  return null;
}

/** The arguments a fit check formats with: the key's examples, then long stand-ins. */
function fitArgs(text: string, examples: Readonly<Record<string, string | number>>): MessageArgs {
  const out: Record<string, string | number | Date> = { ...examples };
  for (const [name, kinds] of messageArguments(parseMessage(text).ast)) {
    if (name in out) continue;
    if ([...kinds].some((k) => k === "number" || k === "plural" || k === "selectordinal")) out[name] = 88888;
    else if ([...kinds].some((k) => k === "date" || k === "time")) out[name] = new Date(2000, 11, 28, 23, 59);
    else if (kinds.has("select")) out[name] = "other";
    else out[name] = "WWWWWWWW";
  }
  return out;
}

function shown(project: ExchangeProject, key: string, code: string): string | null {
  const m = messageIn(project, key, code);
  if (!m) return null;
  const examples = project.tables.flatMap((t) => t.table.strings).find((e) => e.key === key)?.examples ?? {};
  const ast = parseMessage(m.text).ast;
  const args = fitArgs(m.text, examples);
  return m.pseudo ? pseudoWrap(formatMessage(accentMessage(ast), args, m.tag), code) : formatMessage(ast, args, m.tag);
}

export interface FitInput {
  readonly project: ExchangeProject;
  /** UI documents: path → markup text. */
  readonly documents: Iterable<readonly [string, string]>;
  /** Another project file's text, for `<Use src>`. */
  read(path: string): string | null;
  readonly measure: FitMeasure;
  /** Languages to check; default: the shipped languages and `qps-ploc`. */
  readonly languages?: readonly string[];
}

/** Lay out every keyed element with a fixed box in each language and list what overflows. */
export function fitCheck(input: FitInput): FitResult {
  const languages = input.languages ?? [...shippedLanguages(input.project.languages).map((l) => l.code), PSEUDO_LANGUAGE];
  const overflows: FitOverflow[] = [];
  let checked = 0, skipped = 0;
  for (const [path, source] of input.documents) {
    const markup = parseMarkup(source, path, (p) => input.read(p));
    const walk = (el: MarkupElement) => {
      if (el.file === path) {
        for (const a of el.attributes) {
          if (!a.name.startsWith("t:") || !a.value.trim()) continue;
          const key = a.value.trim();
          const width = px(attr(el, "width")), height = px(attr(el, "height"));
          if (hasBinding(key) || width === null) {
            skipped++;
            continue;
          }
          checked++;
          const fontSize = px(attr(el, "fontSize", "font-size")) ?? 16;
          const wrap = el.tag === "InputField" ? "none" : (WRAPS[attr(el, "wordBreak", "word-break") ?? "break-word"] ?? "word");
          for (const language of languages) {
            const text = shown(input.project, key, language);
            if (text === null) continue;
            const needed = input.measure({ text, fontSize, fontWeight: "400", fontFamily: UI_FONT_FAMILY, lineHeight: UI_LINE_HEIGHT, wrap, maxWidth: wrap === "none" ? Infinity : width });
            const where = attr(el, "id") ? `#${attr(el, "id")}` : el.tag;
            const box = { width, height };
            if (height !== null && needed.height > height + 0.5) overflows.push({ path, where, key, language, text, reason: "lines", needed, box });
            else if (needed.width > width + 0.5) overflows.push({ path, where, key, language, text, reason: "width", needed, box });
          }
        }
      }
      el.children.forEach(walk);
      if (el.template) walk(el.template);
    };
    if (markup.root) walk(markup.root);
  }
  return { checked, skipped, overflows, languages };
}
