// The page globals a fixture's `_config.js` reads (ADR 0419 conformance harness). Svelte's harness runs each test in
// jsdom, so a config can use the global `window` (`new window.InputEvent("input")`, `window.document.title`), the global
// `document` (`document.querySelector("button")`: jsdom's body holds only the mounted target) and the `raf` of
// tests/animation-helpers.js (which also patches `HTMLElement.prototype.animate`, meaningless here). Node has no page,
// and engine code takes a defined global `window` for a browser, so the harness can't define them globally; instead the
// Vitest config imports these into each `_config.js` that names them (`vitest.svelte-conformance.config.mts`).
//
// They stand for the page as a game has it: `window` is the renderer's `<svelte:window>` target (the same object a test
// gets as its `window` argument) with event constructors; `document` is its `<svelte:document>` target, with queries
// answered by the mounted target (the page's only content). Components never see these: a component that reads the
// global `window` or `document` uses the browser beyond the Element subset and the hooks (out of scope, ADR 0419).

/** The page's window: set by the harness once the renderer is loaded. */
export let window: object = {};
/** The page's document: set by the harness for each sample. */
export let document: object = {};
/** Svelte's `raf` test helper (`tick(ms)`), the harness's clock. */
export const raf = {
  tick(ms: number): void {
    tick(ms);
  },
};

let tick: (ms: number) => void = () => {};

const QUERIES = new Set(["querySelector", "querySelectorAll", "getElementsByTagName", "getElementsByClassName", "getElementById"]);

/** Point the globals at this run's window, its document target, the mounted target and the clock. */
export function setPage(page: { window: object; document: object; target: () => object | null; tick: (ms: number) => void }): void {
  window = page.window;
  tick = page.tick;
  const doc = page.document;
  document = new Proxy(doc, {
    get(base, key) {
      const target = page.target() as Record<string | symbol, unknown> | null;
      if (typeof key === "string" && key === "getElementById" && target) {
        return (id: string) => (target.querySelector as (s: string) => unknown).call(target, `[id="${id.replace(/"/g, '\\"')}"]`);
      }
      if (typeof key === "string" && QUERIES.has(key) && target && typeof target[key] === "function") return (target[key] as (...a: unknown[]) => unknown).bind(target);
      const value = Reflect.get(base, key, base);
      return typeof value === "function" ? value.bind(base) : value;
    },
    set(base, key, value) {
      return Reflect.set(base, key, value, base);
    },
  });
}
