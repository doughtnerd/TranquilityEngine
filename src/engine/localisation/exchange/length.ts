/**
 * Message length for `maxLength` (ADR 0356 §1, §8): graphemes (user-perceived characters, through `Intl.Segmenter`, so
 * `é` written as `e` + combining accent and a flag emoji count as one), measured on the longest text the message can
 * show. A plural or select counts its longest branch; an argument counts as its example value (the key's `examples`)
 * formatted as text, or as nothing when the key has no example for it, so `{count} coins` is held to the limit with
 * the example a designer gave; `#` counts as the plural's example number.
 *
 * Checked per language in the Localisation panel and on import, where a translation over its key's limit is skipped.
 *
 * Pure; no plugin, no DOM.
 */
import type { MessageNode } from "../message/ast";
import { parseMessage } from "../message/parse";

let segmenter: Intl.Segmenter | null | undefined;

/** Graphemes of `text` (code points where the platform has no `Intl.Segmenter`). */
export function graphemeLength(text: string): number {
  if (segmenter === undefined) {
    try {
      segmenter = typeof Intl.Segmenter === "function" ? new Intl.Segmenter(undefined, { granularity: "grapheme" }) : null;
    } catch {
      segmenter = null;
    }
  }
  if (!segmenter) return [...text].length;
  let n = 0;
  for (const _ of segmenter.segment(text)) n++;
  return n;
}

type Examples = Readonly<Record<string, string | number>>;

/** The longest text `nodes` can show, as a string (graphemes are counted on it). */
function longest(nodes: readonly MessageNode[], examples: Examples, pound: string): string {
  let out = "";
  for (const n of nodes) {
    switch (n.type) {
      case "text":
        out += n.value;
        break;
      case "pound":
        out += pound;
        break;
      case "argument":
      case "number":
      case "date":
      case "time":
        out += examples[n.name] !== undefined ? String(examples[n.name]) : "";
        break;
      case "plural":
      case "select": {
        const inner = n.type === "plural" ? (examples[n.name] !== undefined ? String(examples[n.name]) : "") : pound;
        let best = "";
        for (const o of n.options) {
          const s = longest(o.value, examples, inner);
          if (graphemeLength(s) > graphemeLength(best)) best = s;
        }
        out += best;
        break;
      }
    }
  }
  return out;
}

/** Graphemes of the longest text the message `text` can show, arguments as their `examples` (absent: nothing). */
export function messageLength(text: string, examples: Examples = {}): number {
  const parsed = parseMessage(text);
  return graphemeLength(longest(parsed.ast, examples, ""));
}

/** True when `text` is longer than `maxLength` (graphemes, `messageLength`); never with no limit. */
export function overLength(text: string, maxLength: number | undefined, examples: Examples = {}): boolean {
  return maxLength !== undefined && messageLength(text, examples) > maxLength;
}
