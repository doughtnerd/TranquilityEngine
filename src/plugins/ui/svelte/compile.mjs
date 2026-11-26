// Compiling game UI components (ADR 0419): `*.svelte` with the engine's custom renderer and external CSS,
// and `*.svelte.ts` rune modules. One place for the options, so every host that compiles (Vitest now; the
// editor and the export in 0419 wave A part 2) emits the same code and the same scoping hashes (Svelte
// derives a component's hash from the filename, so it must be the same project-relative path everywhere).
// Plain JavaScript (like scriptCompiler.mjs) so Node tooling can import it without a TypeScript step.
import { compile, compileModule } from "svelte/compiler";

/** The renderer module's specifier as compiled components import it (resolved by the bundler or Vitest). */
export const DEFAULT_RENDERER = "myco/ui-renderer";

/**
 * The compiler options for a component: the custom renderer, `css: 'external'` (the only CSS mode a custom
 * renderer has), runes always (no legacy-mode runtime), and `dev` in the editor (template locations).
 */
export function svelteUIOptions(filename, { renderer = DEFAULT_RENDERER, dev = false } = {}) {
  return {
    filename,
    generate: "client",
    css: "external",
    runes: true,
    dev,
    experimental: { customRenderer: renderer },
  };
}

/**
 * Compile a component. The module registers its CSS with the renderer when it's imported (`addStyles`, the
 * renderer's named export), so its scoped and `:global` rules reach every view; at export the rules will be
 * registered as parsed data instead of text (ADR 0419: games ship no CSS parser).
 */
export function compileSvelteUI(source, { filename, renderer = DEFAULT_RENDERER, dev = false }) {
  const r = compile(source, svelteUIOptions(filename, { renderer, dev }));
  let code = r.js.code;
  const css = r.css?.code ?? "";
  if (css.trim()) {
    code += `\nimport { addStyles as $$mycoAddStyles } from ${JSON.stringify(renderer)};\n$$mycoAddStyles(${JSON.stringify(filename)}, ${JSON.stringify(css)});\n`;
  }
  return { code, map: r.js.map, css, warnings: r.warnings };
}

/** Compile a rune module (`*.svelte.ts`, already stripped of types, or `*.svelte.js`). */
export function compileSvelteUIModule(source, { filename, dev = false }) {
  const r = compileModule(source, { filename, generate: "client", dev });
  return { code: r.js.code, map: r.js.map, warnings: r.warnings };
}
