/**
 * Checks on messages (ADR 0356 §2), used by the editor, the export and the import preview:
 *
 * - the message parses (its errors);
 * - a translation uses only argument names its reference message uses, each of a compatible kind: a choice can't
 *   change kind (a `plural` can't become a `select`), a number can't become a date; a plain `{name}` goes with any kind
 *   (Japanese often writes `{count}枚` for a plural);
 * - every plural and selectordinal has the categories the language needs (`Intl.PluralRules(…).resolvedOptions()`:
 *   "Polish needs few and many"); `=N` branches don't count; `other` is reported by the parse.
 *
 * Pure; no plugin, no DOM.
 */
import type { ArgumentKind, MessageNode, MessageProblem } from "./ast";
import { pluralCategories } from "./format";
import { parseMessage } from "./parse";

/** Each argument name a message uses, with every kind it is used as. */
export function messageArguments(ast: readonly MessageNode[]): Map<string, Set<ArgumentKind>> {
  const out = new Map<string, Set<ArgumentKind>>();
  const walk = (nodes: readonly MessageNode[]) => {
    for (const n of nodes) {
      if (n.type === "text" || n.type === "pound") continue;
      const kind: ArgumentKind = n.type === "argument" ? "simple" : n.type === "plural" ? (n.ordinal ? "selectordinal" : "plural") : n.type;
      let kinds = out.get(n.name);
      if (!kinds) out.set(n.name, (kinds = new Set()));
      kinds.add(kind);
      if (n.type === "plural" || n.type === "select") for (const o of n.options) walk(o.value);
    }
  };
  walk(ast);
  return out;
}

/** The group a kind belongs to for the kind check; null for a plain `{name}`, which goes with any. */
function kindGroup(kind: ArgumentKind): "number" | "date" | "select" | null {
  switch (kind) {
    case "simple": return null;
    case "number": case "plural": case "selectordinal": return "number";
    case "date": case "time": return "date";
    case "select": return "select";
  }
}

const describeKind = (k: ArgumentKind) => (k === "simple" ? "a plain argument" : `a ${k}`);

/** The plural problems of a message in language `tag`: categories the language needs that a plural lacks. */
export function pluralProblems(ast: readonly MessageNode[], tag: string, languageName = tag): MessageProblem[] {
  const out: MessageProblem[] = [];
  const walk = (nodes: readonly MessageNode[]) => {
    for (const n of nodes) {
      if (n.type !== "plural" && n.type !== "select") continue;
      if (n.type === "plural") {
        const keys = new Set(n.options.map((o) => o.key));
        const missing = pluralCategories(tag, n.ordinal).filter((c) => c !== "other" && !keys.has(c));
        if (missing.length) {
          out.push({
            severity: "error",
            message: `${languageName} needs ${missing.length > 1 ? `${missing.slice(0, -1).join(", ")} and ${missing[missing.length - 1]}` : missing[0]} in the ${n.ordinal ? "selectordinal" : "plural"} of "${n.name}"`,
            start: n.start, end: n.end,
          });
        }
      }
      for (const o of n.options) walk(o.value);
    }
  };
  walk(ast);
  return out;
}

/**
 * Every problem of `translation` (a message in language `tag`) against `reference` (the reference language's message):
 * its parse problems, argument names the reference doesn't use, kind changes, and missing plural categories.
 */
export function checkTranslation(reference: string, translation: string, tag: string, languageName = tag): MessageProblem[] {
  const ref = parseMessage(reference);
  const tr = parseMessage(translation);
  const out: MessageProblem[] = [...tr.problems];
  const refArgs = messageArguments(ref.ast);
  const find = (name: string): { start: number; end: number } => {
    let at = { start: 0, end: translation.length };
    const walk = (nodes: readonly MessageNode[]): boolean => nodes.some((n) => {
      if (n.type === "text" || n.type === "pound") return false;
      if (n.name === name) { at = { start: n.start, end: n.end }; return true; }
      return (n.type === "plural" || n.type === "select") && n.options.some((o) => walk(o.value));
    });
    walk(tr.ast);
    return at;
  };
  for (const [name, kinds] of messageArguments(tr.ast)) {
    const refKinds = refArgs.get(name);
    if (!refKinds) {
      out.push({ severity: "error", message: `"${name}" isn't an argument of the reference text`, ...find(name) });
      continue;
    }
    for (const k of kinds) {
      const g = kindGroup(k);
      if (g === null) continue;
      const clash = [...refKinds].find((r) => kindGroup(r) !== null && kindGroup(r) !== g);
      if (clash) out.push({ severity: "error", message: `"${name}" is ${describeKind(clash)} in the reference text, not ${describeKind(k)}`, ...find(name) });
    }
  }
  out.push(...pluralProblems(tr.ast, tag, languageName));
  return out;
}

/** Every problem of a reference message in language `tag`: its parse problems and missing plural categories. */
export function checkMessage(message: string, tag: string, languageName = tag): MessageProblem[] {
  const parsed = parseMessage(message);
  return [...parsed.problems, ...pluralProblems(parsed.ast, tag, languageName)];
}
