/**
 * The engine's ICU MessageFormat 1 formatter (ADR 0356 §2), on `Intl`: CLDR plural categories from `Intl.PluralRules`,
 * numbers from `Intl.NumberFormat`, dates and times from `Intl.DateTimeFormat`. It formats `parse.ts`'s tree and never
 * throws:
 *
 * - a missing argument (absent, null or undefined) stays `{name}` and is reported through `onMissing`;
 * - a plural or selectordinal picks `=N` (compared before the offset), then the language's category of `n − offset`,
 *   then `other`, then the first branch; `#` is `n − offset`, formatted;
 * - a select picks the branch named by the value, then `other`, then the first branch;
 * - a language tag `Intl` refuses falls back to the runtime's default locale; options it refuses (an unknown currency)
 *   fall back to plain formatting.
 *
 * `Intl` objects are cached per tag and options.
 *
 * Pure; no plugin, no DOM.
 */
import type { MessageNode, OptionNode, PluralNode } from "./ast";
import { numberStyleOptions } from "./numberStyle";
import { parseMessage } from "./parse";

/** A value a message argument takes. Objects (a `LocalText`, ADR 0356 §6) format as their `toString()`. */
export type MessageArg = string | number | bigint | boolean | Date | null | undefined | { toString(): string };
export type MessageArgs = Readonly<Record<string, MessageArg>>;

const cache = new Map<string, unknown>();

/** A cached `Intl` object; the default locale when `tag` is refused, plain options when `options` are. */
function intl<T>(kind: string, make: (tag: string | undefined, options: object) => T, tag: string, options: object = {}): T {
  const key = `${kind}|${tag}|${JSON.stringify(options)}`;
  let v = cache.get(key) as T | undefined;
  if (v === undefined) {
    for (const [t, o] of [[tag, options], [undefined, options], [tag, {}], [undefined, {}]] as const) {
      try { v = make(t, o); break; } catch { /* next */ }
    }
    cache.set(key, v);
  }
  return v!;
}

const numberFormat = (tag: string, options?: Intl.NumberFormatOptions) => intl("n", (t, o) => new Intl.NumberFormat(t, o), tag, options);
const pluralRules = (tag: string, ordinal: boolean) => intl("p", (t, o) => new Intl.PluralRules(t, o), tag, { type: ordinal ? "ordinal" : "cardinal" });
const dateFormat = (tag: string, options: Intl.DateTimeFormatOptions) => intl("d", (t, o) => new Intl.DateTimeFormat(t, o), tag, options);

/** The plural categories `tag` has (`Intl.PluralRules`), cardinal or ordinal. */
export const pluralCategories = (tag: string, ordinal = false): readonly string[] => pluralRules(tag, ordinal).resolvedOptions().pluralCategories;

const isMissing = (v: MessageArg): v is null | undefined => v === null || v === undefined;

function formatNumber(value: number | bigint, tag: string, options?: Intl.NumberFormatOptions): string {
  try { return numberFormat(tag, options).format(value); } catch { return String(value); }
}

function formatDate(value: Date | number, tag: string, options: Intl.DateTimeFormatOptions): string {
  try { return dateFormat(tag, options).format(value); } catch { return String(value); }
}

/** An argument's value as text (`{name}` without a type). */
function plain(value: MessageArg, tag: string): string {
  if (typeof value === "number" || typeof value === "bigint") return formatNumber(value, tag);
  if (value instanceof Date) return formatDate(value, tag, { dateStyle: "medium" });
  try { return String(value); } catch { return ""; }
}

const toNumber = (v: MessageArg): number => (typeof v === "number" ? v : typeof v === "bigint" ? Number(v) : typeof v === "string" && v.trim() !== "" ? Number(v) : NaN);

function chooseBranch(options: readonly OptionNode[], key: string, exact: number | null): OptionNode | undefined {
  if (exact !== null) {
    const hit = options.find((o) => o.key.startsWith("=") && Number(o.key.slice(1)) === exact);
    if (hit) return hit;
  }
  return options.find((o) => o.key === key) ?? options.find((o) => o.key === "other") ?? options[0];
}

interface Context {
  args: MessageArgs;
  tag: string;
  onMissing?: (name: string) => void;
}

function formatNodes(nodes: readonly MessageNode[], ctx: Context, pound: string | null): string {
  let out = "";
  for (const node of nodes) {
    switch (node.type) {
      case "text": out += node.value; break;
      case "pound": out += pound ?? "#"; break;
      default: {
        const value = ctx.args[node.name];
        if (isMissing(value)) {
          ctx.onMissing?.(node.name);
          if (node.type === "plural" || node.type === "select") out += formatNodes(chooseBranch(node.options, "other", null)?.value ?? [], ctx, `{${node.name}}`);
          else out += `{${node.name}}`;
          break;
        }
        switch (node.type) {
          case "argument": out += plain(value, ctx.tag); break;
          case "number": {
            const n = typeof value === "bigint" ? value : toNumber(value);
            out += typeof n === "number" && Number.isNaN(n) ? plain(value, ctx.tag) : formatNumber(n, ctx.tag, numberStyleOptions(node.style).options);
            break;
          }
          case "date": case "time": {
            const style = (["short", "medium", "long", "full"] as const).find((s) => s === node.style) ?? "medium";
            const d = value instanceof Date ? value : typeof value === "number" ? value : NaN;
            out += typeof d === "number" && Number.isNaN(d) ? plain(value, ctx.tag) : formatDate(d, ctx.tag, node.type === "date" ? { dateStyle: style } : { timeStyle: style });
            break;
          }
          case "plural": out += formatPlural(node, value, ctx); break;
          case "select": out += formatNodes(chooseBranch(node.options, String(value), null)?.value ?? [], ctx, null); break;
        }
      }
    }
  }
  return out;
}

function formatPlural(node: PluralNode, value: MessageArg, ctx: Context): string {
  const n = toNumber(value);
  if (Number.isNaN(n)) return formatNodes(chooseBranch(node.options, "other", null)?.value ?? [], ctx, plain(value, ctx.tag));
  const shifted = n - node.offset;
  let category = "other";
  try { category = pluralRules(ctx.tag, node.ordinal).select(shifted); } catch { /* other */ }
  const branch = chooseBranch(node.options, category, n);
  return formatNodes(branch?.value ?? [], ctx, formatNumber(shifted, ctx.tag));
}

/**
 * A parsed message formatted in language `tag` (an `Intl` tag: the language's `intl`, else its code). Never throws.
 * `onMissing` hears each missing argument's name.
 */
export function formatMessage(ast: readonly MessageNode[], args: MessageArgs | null | undefined, tag: string, onMissing?: (name: string) => void): string {
  try {
    return formatNodes(ast, { args: args ?? {}, tag, onMissing }, null);
  } catch {
    // Unreachable by design (every Intl call is guarded); a formatter bug must not throw into a game.
    return "";
  }
}

/** A message's text parsed and formatted (a runtime-written message, ADR 0356 §6 `Locale.format`). Never throws. */
export const formatMessageText = (message: string, args: MessageArgs | null | undefined, tag: string, onMissing?: (name: string) => void): string =>
  formatMessage(parseMessage(message).ast, args, tag, onMissing);
