/**
 * `t(key, args)`: localised text for UI components (ADR 0419, 0356 §6). The same message as `Locale.t`, and a
 * reactive read of the language: in a Svelte component's template, `$derived` or effect, it runs again when
 * `Locale.epoch` rises (a language switch, a table edit, hot reload), so the text follows the language. Outside
 * one (scripts, plain code) it is `Locale.t`.
 *
 * The engine doesn't depend on Svelte: the UI runtime installs the reactive read when it loads (`setLocaleTracker`).
 */
import { Locale, type MessageArgs } from "./Locale";

let track: (() => void) | null = null;

/**
 * @internal The UI runtime (the Svelte renderer) installs its reactive read of the language: a function that, called
 * inside a reactive context, makes it depend on `Locale.epoch` (Svelte's `createSubscriber` over `onLocaleEpoch`).
 */
export function setLocaleTracker(tracker: (() => void) | null): void {
  track = tracker;
}

/** The message of `key` in the current language, with `args` (as `Locale.t`); in a UI component, it follows language changes. */
export function t(key: string, args?: MessageArgs): string {
  track?.();
  return Locale.t(key, args);
}

const HTML_ESCAPES: Readonly<Record<string, string>> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

/**
 * ADR 0425: the message of `key` as inline HTML, for `{@html tHtml("hud.coins", { count })}` in a Svelte component. A
 * message may carry the inline subset (`You have <b>{count}</b> coins`; translators keep the tags), which then draws as
 * styled runs. Each string argument is escaped, so text from a player (a name) shows as typed and can never add markup;
 * numbers and dates format as in `t`, and a `LocalText` argument is another message, kept as written. Follows language
 * changes as `t` does.
 */
export function tHtml(key: string, args?: MessageArgs): string {
  if (!args) return t(key);
  const safe: Record<string, MessageArgs[string]> = {};
  for (const [k, v] of Object.entries(args)) safe[k] = typeof v === "string" ? v.replace(/[&<>"']/g, (c) => HTML_ESCAPES[c]) : v;
  return t(key, safe);
}
