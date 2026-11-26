// Compiling game UI components (ADR 0419): `*.svelte` with the engine's custom renderer and external CSS,
// and `*.svelte.ts` rune modules. One place for the options, so every host that compiles (Vitest, the
// editor and the export, through the project code linker) emits the same code and the same scoping hashes (Svelte
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
    discloseVersion: false, // no `window.__svelte`: a game's canvas UI has no page to announce itself to
    experimental: { customRenderer: renderer },
  };
}

/**
 * Compile a component. The module registers its CSS with the renderer when it's imported (`addStyles`, the
 * renderer's named export), so its scoped and `:global` rules reach every view. The CSS goes in as rule data
 * (ADR 0419: games ship no CSS parser): `styles` is either a function that parses it now (the editor and
 * the export pass the cascade's stylesheet parser) and returns the data, which is written into the module,
 * or `{ parser }`, a module whose `parseStylesheet` the compiled module calls when it loads (for hosts that
 * can't load the parser while compiling, such as Vitest's transform).
 */
export function compileSvelteUI(source, { filename, renderer = DEFAULT_RENDERER, dev = false, styles }) {
  const r = compile(source, svelteUIOptions(filename, { renderer, dev }));
  let code = r.js.code;
  // ADR 0421: the module mounts its own component, with the Svelte and the renderer it was linked with (the editor's
  // shared runtime, or the game's own bundle), so `UIView` never imports Svelte. A `$` name can't clash with the
  // component's own exports (Svelte reserves it).
  const name = /^export default function ([\w$]+)\(/m.exec(code)?.[1];
  if (!name) throw new Error(`${filename}: the compiled component has no default export function.`);
  code += `\nimport { mountView as $$mycoMountView } from ${JSON.stringify(renderer)};\nexport const $mount = (host, props) => $$mycoMountView(host, ${name}, props);\n`;
  const css = r.css?.code ?? "";
  if (css.trim()) {
    const add = `import { addStyles as $$mycoAddStyles } from ${JSON.stringify(renderer)};\n`;
    if (typeof styles === "function") code += `\n${add}$$mycoAddStyles(${JSON.stringify(filename)}, ${JSON.stringify(styles(css, filename))});\n`;
    else if (styles?.parser) code += `\n${add}import { parseStylesheet as $$mycoParse } from ${JSON.stringify(styles.parser)};\n$$mycoAddStyles(${JSON.stringify(filename)}, $$mycoParse(${JSON.stringify(css)}, ${JSON.stringify(filename)}));\n`;
    else throw new Error(`${filename} has styles, and nothing was given to parse them (the \`styles\` option).`);
  }
  return { code, map: r.js.map, css, warnings: r.warnings };
}

/**
 * A plain `.css` file a component imports (`import "./theme.css"`) as a module: like a component's
 * `:global` rules, it applies to every view in the World. `styles` as for `compileSvelteUI`.
 */
export function compileSvelteUIStyles(css, { filename, renderer = DEFAULT_RENDERER, styles }) {
  const add = `import { addStyles as $$mycoAddStyles } from ${JSON.stringify(renderer)};\n`;
  if (typeof styles === "function") return { code: `${add}$$mycoAddStyles(${JSON.stringify(filename)}, ${JSON.stringify(styles(css, filename))});\n` };
  if (styles?.parser) return { code: `${add}import { parseStylesheet as $$mycoParse } from ${JSON.stringify(styles.parser)};\n$$mycoAddStyles(${JSON.stringify(filename)}, $$mycoParse(${JSON.stringify(css)}, ${JSON.stringify(filename)}));\n` };
  throw new Error(`${filename}: nothing was given to parse styles with (the \`styles\` option).`);
}

/** Compile a rune module (`*.svelte.ts`, already stripped of types, or `*.svelte.js`). */
export function compileSvelteUIModule(source, { filename, dev = false }) {
  const r = compileModule(source, { filename, generate: "client", dev });
  return { code: r.js.code, map: r.js.map, warnings: r.warnings };
}
