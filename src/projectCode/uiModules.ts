// Game UI code in a project (ADR 0419): which files are Svelte sources, and the Svelte runtime modules
// compiled components import, which every host provides from its own copy of the engine's Svelte (one
// instance with the engine's renderer) instead of bundling them like npm packages. Imports nothing, so
// the player's build config can read the list.

/** The runtime modules compiled UI code may import: Svelte's client runtime and packages, and the engine's renderer. */
export const UI_RUNTIME_SPECIFIERS: readonly string[] = [
  "svelte",
  "svelte/internal/client",
  "svelte/internal/flags/custom-renderer",
  "svelte/internal/flags/tracing",
  "svelte/animate",
  "svelte/attachments",
  "svelte/easing",
  "svelte/events",
  "svelte/legacy",
  "svelte/motion",
  "svelte/reactivity",
  "svelte/reactivity/window",
  "svelte/store",
  "svelte/transition",
  "myco/ui-renderer",
];

const RUNTIME = new Set(UI_RUNTIME_SPECIFIERS);

/** True for an import of one of the UI runtime modules. */
export const isUIRuntimeSpecifier = (specifier: string): boolean => RUNTIME.has(specifier);

/**
 * Where a UI runtime module is in a game build (ADR 0041), beside `myco.js`: an entry of the prebuilt
 * player with a fixed name (`svelte/index.js`, `svelte/internal/client.js`, `svelte/myco-ui-renderer.js`).
 */
export function uiRuntimeFile(specifier: string): string {
  if (specifier === "myco/ui-renderer") return "svelte/myco-ui-renderer.js";
  return specifier === "svelte" ? "svelte/index.js" : `${specifier}.js`;
}

/** A Svelte component (`*.svelte`). */
export const isSvelteComponentPath = (path: string): boolean => path.endsWith(".svelte");

/** A rune module (`*.svelte.ts`, `*.svelte.js`). */
export const isRuneModulePath = (path: string): boolean => path.endsWith(".svelte.ts") || path.endsWith(".svelte.js");

/** A Svelte source file the project code linker compiles: a component or a rune module, anywhere in the project. */
export const isUISourcePath = (path: string): boolean => isSvelteComponentPath(path) || isRuneModulePath(path);
