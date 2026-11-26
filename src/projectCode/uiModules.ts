// Game UI code in a project (ADR 0419): which files are Svelte sources, and the Svelte runtime modules
// compiled components import, which aren't npm packages of the project: the editor provides them from its
// own copy of the engine's Svelte (one instance with the engine's renderer), and a game build bundles them
// from the engine's files into the game's code, tree-shaken (ADR 0421, `uiBundle.ts`). Imports nothing, so
// the build configs can read it.

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
  // ADR 0425: the inline HTML parser, imported by components that use `{@html}` or `bind:innerHTML`.
  "myco/ui-html",
];

const RUNTIME = new Set(UI_RUNTIME_SPECIFIERS);

/** True for an import of one of the UI runtime modules. */
export const isUIRuntimeSpecifier = (specifier: string): boolean => RUNTIME.has(specifier);

/** The engine's renderer (`myco/ui-renderer`) among the engine's files, by path from the engine's root. */
export const UI_RENDERER_SOURCE = "src/plugins/ui/svelte/renderer.ts";

/** ADR 0425: the inline HTML parser (`myco/ui-html`) among the engine's files, by path from the engine's root. */
export const UI_HTML_SOURCE = "src/plugins/ui/svelte/htmlInline.ts";

/** What UI code's `svelte/reactivity` is (ADR 0418 wave 5): Svelte's module with `MediaQuery` on the canvas, by path from the engine's root. */
export const UI_REACTIVITY_SOURCE = "src/plugins/ui/svelte/reactivity.ts";

/** The engine's own modules, by path from the engine's root: what the renderer imports from there stays in the player. */
export const ENGINE_SOURCE_DIR = "src/engine/";

/**
 * The prebuilt player's entry beside `myco.js` (ADR 0421) re-exporting what the renderer (bundled into a game's
 * code) imports from the engine's own modules (`ENGINE_SOURCE_DIR`), by the names it imports, so both share the
 * engine's instance. Engine code only: the player carries no Svelte.
 */
export const UI_HOST_FILE = "myco-ui-host.js";

/** A Svelte component (`*.svelte`). */
export const isSvelteComponentPath = (path: string): boolean => path.endsWith(".svelte");

/** A rune module (`*.svelte.ts`, `*.svelte.js`). */
export const isRuneModulePath = (path: string): boolean => path.endsWith(".svelte.ts") || path.endsWith(".svelte.js");

/** A Svelte source file the project code linker compiles: a component or a rune module, anywhere in the project. */
export const isUISourcePath = (path: string): boolean => isSvelteComponentPath(path) || isRuneModulePath(path);
