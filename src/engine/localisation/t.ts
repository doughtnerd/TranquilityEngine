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
