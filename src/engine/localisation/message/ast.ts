/**
 * Contract (ADR 0356 §2): the syntax tree of an ICU MessageFormat 1 message, as `parse.ts` produces it and `format.ts`
 * and `check.ts` read it. Every node carries its source span (`start` inclusive, `end` exclusive, in UTF-16 units of
 * the message), so the editor can highlight it and problems can point at it.
 *
 * Pure; no plugin, no DOM.
 */

interface Span {
  start: number;
  end: number;
}

/** Literal text, quoting already resolved (`''` is one apostrophe). */
export interface TextNode extends Span { type: "text"; value: string }
/** `{name}`. */
export interface ArgumentNode extends Span { type: "argument"; name: string }
/** `{name, number}`, `{name, number, integer}`, `{name, number, ::skeleton}`; `style` as written, trimmed, or null. */
export interface NumberNode extends Span { type: "number"; name: string; style: string | null }
/** `{name, date, short}` or `{name, time, …}`; `style` as written, trimmed, or null. */
export interface DateTimeNode extends Span { type: "date" | "time"; name: string; style: string | null }
/** One branch of a plural, selectordinal or select: `one {…}`, `=0 {…}`, `other {…}`. */
export interface OptionNode extends Span { key: string; value: MessageNode[] }
/** `{name, plural, offset:1 …}` or `{name, selectordinal, …}`. */
export interface PluralNode extends Span { type: "plural"; name: string; ordinal: boolean; offset: number; options: OptionNode[] }
/** `{name, select, …}`. */
export interface SelectNode extends Span { type: "select"; name: string; options: OptionNode[] }
/** `#` inside a plural branch: the number minus the offset, formatted. */
export interface PoundNode extends Span { type: "pound" }

export type MessageNode = TextNode | ArgumentNode | NumberNode | DateTimeNode | PluralNode | SelectNode | PoundNode;

/** Something wrong with a message: an `error` makes it malformed (skipped at runtime), a `warning` is a lint. */
export interface MessageProblem {
  severity: "error" | "warning";
  message: string;
  start: number;
  end: number;
}

/** What the parse returns (it never throws): the tree, best effort when malformed (the broken part as text). */
export interface MessageParse {
  ast: MessageNode[];
  problems: MessageProblem[];
}

/** How an argument is used, for the translation checks. */
export type ArgumentKind = "simple" | "number" | "date" | "time" | "plural" | "selectordinal" | "select";
