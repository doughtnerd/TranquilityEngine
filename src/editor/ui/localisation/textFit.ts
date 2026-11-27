// The text fit check (ADR 0356 §8, ADR 0423 wave F), best effort: every element of Svelte UI whose text is one keyed
// message (`<p>{t("menu.start")}</p>`) and whose rendered box is fixed, laid out in each language and the
// pseudo-language with the engine's line breaking and a text measurer (the editor passes the engine's canvas measuring,
// `render/babylon/ui.ts` `measureText`; tests the UI core's estimate), and reported when its text doesn't fit: more
// lines than the box's height holds, or wider than the box (a word longer than the width, or wrapping off).
//
// Each message is formatted from its key's `examples`; arguments without one take long stand-ins (numbers `88888`,
// strings `WWWWWWWW`). A language without the key falls back through its chain, as the runtime does. The boxes come
// from what the editor rendered (`uiViewEdits.ts` `fitTargets`): an element that sizes to its text in a direction isn't
// fixed in it, and one with no fixed width is skipped and counted. Restored from UI documents' fit check
// (`fitCheck.ts`, retired with them by ADR 0423 wave D), which read sizes from markup attributes instead.
//
// Pure: no DOM; the measurer is a port.
import { fallbackChain, intlTagOf, shippedLanguages, type LanguageSettings } from "../../../engine/localisation/languages";
import { messageArguments } from "../../../engine/localisation/message/check";
import { formatMessage, type MessageArgs } from "../../../engine/localisation/message/format";
import { parseMessage } from "../../../engine/localisation/message/parse";
import { accentMessage, isPseudoLanguage, PSEUDO_LANGUAGE, pseudoWrap } from "../../../engine/localisation/pseudo";
import { translationOf, type ExchangeProject } from "../../../engine/localisation/exchange/model";
import type { TextMeasureRequest } from "../../../engine/ui/uiCoreTypes";

/** Measures text in UI pixels, wrapped to `maxWidth` as `wrap` says (`UICoreHost.measureText`'s contract). */
export type FitMeasure = (request: TextMeasureRequest) => { width: number; height: number };

/** One element to check: where it's written, its key, how its text is set, and its content box (null: not fixed that way). */
export interface FitTarget {
  readonly path: string;
  /** `#id` or `<tag>`. */
  readonly where: string;
  /** 1-based line of the element in its file. */
  readonly line: number;
  readonly key: string;
  /** Its text's font, line height and wrapping (the text itself and the width come from the check). */
  readonly run: Omit<TextMeasureRequest, "text" | "maxWidth">;
  readonly box: { readonly width: number | null; readonly height: number | null };
}

export interface FitOverflow {
  readonly path: string;
  readonly where: string;
  readonly line: number;
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
  /** Keyed elements not checked: no fixed width, not rendered in the open scene, or text that isn't one message. */
  readonly skipped: number;
  readonly overflows: readonly FitOverflow[];
  /** The languages checked. */
  readonly languages: readonly string[];
}

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
  readonly targets: Iterable<FitTarget>;
  /** Keyed elements found but not made targets (not rendered, or text that isn't one message): counted as skipped. */
  readonly unrendered?: number;
  readonly measure: FitMeasure;
  /** Languages to check; default: the shipped languages and `qps-ploc`. */
  readonly languages?: readonly string[];
}

/** Lay out every keyed element with a fixed box in each language and list what overflows. */
export function fitCheck(input: FitInput): FitResult {
  const languages = input.languages ?? [...shippedLanguages(input.project.languages).map((l) => l.code), PSEUDO_LANGUAGE];
  const overflows: FitOverflow[] = [];
  let checked = 0, skipped = input.unrendered ?? 0;
  for (const target of input.targets) {
    const { width, height } = target.box;
    if (width === null) {
      skipped++;
      continue;
    }
    checked++;
    for (const language of languages) {
      const text = shown(input.project, target.key, language);
      if (text === null) continue;
      const needed = input.measure({ ...target.run, text, maxWidth: target.run.wrap === "none" ? Infinity : width });
      const base = { path: target.path, where: target.where, line: target.line, key: target.key, language, text, needed, box: target.box };
      if (height !== null && needed.height > height + 0.5) overflows.push({ ...base, reason: "lines" });
      else if (needed.width > width + 0.5) overflows.push({ ...base, reason: "width" });
    }
  }
  return { checked, skipped, overflows, languages };
}
