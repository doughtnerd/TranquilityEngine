// `svelte/reactivity` as game UI imports it (ADR 0419: its `MediaQuery` follows canvas `@media`, ADR 0418 wave 5):
// Svelte's own module, with `MediaQuery` asking the engine renderer's window target (`matchMedia`, evaluated against the
// canvas in UI pixels) instead of the browser's window. Svelte's `MediaQuery` calls the global `window.matchMedia`,
// which in a game is the page, not the canvas, and doesn't exist at all in Node. Compiled UI code gets this module for
// `svelte/reactivity`: the editor's runtime modules (`runtimeModules.ts`), a game's UI bundle (`projectCode/uiBundle.ts`)
// and Vitest's components (`vite.shared.ts`'s `svelteUI()`).
import { createSubscriber } from "svelte/reactivity";
import renderer from "./renderer";
import type { UIGlobalWindow, UIMediaQueryList } from "./globalTargets";

export * from "svelte/reactivity";

/** Keywords that are valid media queries without parentheses (Svelte's list, sveltejs/svelte#15930). */
const KEYWORDS = new Set(["all", "print", "screen", "and", "or", "not", "only"]);

/**
 * A media query and whether it matches the canvas now (`current`), reactively, as Svelte's `MediaQuery` is for the
 * browser's window: `new MediaQuery("min-width: 800px")` (parentheses added as Svelte adds them).
 */
export class MediaQuery {
  readonly #list: UIMediaQueryList;
  readonly #subscribe: () => void;

  constructor(query: string, _fallback?: boolean) {
    const final = /\(.+\)/.test(query) || query.split(/[\s,]+/).some((k) => KEYWORDS.has(k.trim())) ? query : `(${query})`;
    const window = renderer.globalTarget!("window") as UIGlobalWindow;
    const list = (this.#list = window.matchMedia(final));
    this.#subscribe = createSubscriber((update) => {
      list.addEventListener("change", update);
      return () => list.removeEventListener("change", update);
    });
  }

  get current(): boolean {
    this.#subscribe();
    return this.#list.matches;
  }
}
