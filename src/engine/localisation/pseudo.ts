/**
 * Pseudo-localisation (ADR 0356 §9): Microsoft's pseudo-languages for QA. `qps-ploc` shows every keyed message
 * accented and expanded inside `[!! … !!]` (`Start game` → `[!! Šţàŕţ ĝàɱé ~~ !!]`), so untranslated literal text
 * stands out plain and truncation cuts off the brackets; `qps-plocm` is the same, mirrored right to left.
 *
 * Only a message's literal text changes: arguments, plural and select keywords and `#` are kept through the syntax
 * tree, and argument values (a player's name) format as given. The expansion follows the IBM guidance: +100% for text
 * under 10 characters, falling linearly to +30% at 70 characters and beyond.
 *
 * Pure; no plugin, no DOM.
 */
import type { MessageNode } from "./message/ast";

export const PSEUDO_LANGUAGE = "qps-ploc";
export const PSEUDO_MIRRORED_LANGUAGE = "qps-plocm";
export const PSEUDO_LANGUAGES: readonly string[] = [PSEUDO_LANGUAGE, PSEUDO_MIRRORED_LANGUAGE];

/** True for one of the two pseudo-language codes (case-insensitively). */
export const isPseudoLanguage = (code: string): boolean => PSEUDO_LANGUAGES.includes(code.toLowerCase());

const ACCENTS: Readonly<Record<string, string>> = {
  a: "à", b: "ƀ", c: "ç", d: "ð", e: "é", f: "ƒ", g: "ĝ", h: "ĥ", i: "î", j: "ĵ", k: "ķ", l: "ļ", m: "ɱ",
  n: "ñ", o: "ö", p: "þ", q: "ǫ", r: "ŕ", s: "š", t: "ţ", u: "û", v: "ṽ", w: "ŵ", x: "ẋ", y: "ý", z: "ž",
  A: "À", B: "Ɓ", C: "Ç", D: "Ð", E: "É", F: "Ƒ", G: "Ĝ", H: "Ĥ", I: "Î", J: "Ĵ", K: "Ķ", L: "Ļ", M: "Ṁ",
  N: "Ñ", O: "Ö", P: "Þ", Q: "Ǫ", R: "Ŕ", S: "Š", T: "Ţ", U: "Û", V: "Ṽ", W: "Ŵ", X: "Ẋ", Y: "Ý", Z: "Ž",
};

/** ASCII letters accented (`Start` → `Šţàŕţ`); everything else as it is. */
const accentText = (text: string): string => text.replace(/[A-Za-z]/g, (c) => ACCENTS[c] ?? c);

/** A message tree with its literal text accented; arguments, keywords and `#` untouched. */
export function accentMessage(ast: readonly MessageNode[]): MessageNode[] {
  return ast.map((node): MessageNode => {
    if (node.type === "text") return { ...node, value: accentText(node.value) };
    if (node.type === "plural" || node.type === "select") return { ...node, options: node.options.map((o) => ({ ...o, value: accentMessage(o.value) })) };
    return node;
  });
}

/** Extra characters for text of `length` characters: +100% under 10, falling to +30% at 70 and beyond. */
function pseudoExpansion(length: number): number {
  const ratio = length < 10 ? 1 : length >= 70 ? 0.3 : 1 - (0.7 * (length - 10)) / 60;
  return Math.ceil(length * ratio);
}

const OPEN = "[!! ";
const CLOSE = " !!]";
/** Right-to-left override and pop directional formatting: `qps-plocm` draws its text mirrored. */
const RLO = "‮";
const PDF = "‬";

/**
 * A formatted (already accented) message wrapped for a pseudo-language: brackets, then `~` padding up to the
 * expansion, and for `qps-plocm` a right-to-left override around it all.
 */
export function pseudoWrap(formatted: string, code: string): string {
  const length = [...formatted].length;
  const padding = Math.max(0, pseudoExpansion(length) - OPEN.length - CLOSE.length);
  const out = `${OPEN}${formatted}${padding > 0 ? ` ${"~".repeat(padding)}` : ""}${CLOSE}`;
  return code.toLowerCase() === PSEUDO_MIRRORED_LANGUAGE ? `${RLO}${out}${PDF}` : out;
}
