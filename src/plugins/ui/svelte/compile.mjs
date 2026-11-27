// Compiling game UI components (ADR 0423): `*.svelte` with the engine's custom renderer and external CSS,
// and `*.svelte.ts` rune modules. One place for the options, so every host that compiles (Vitest, the
// editor and the export, through the project code linker) emits the same code and the same scoping hashes (Svelte
// derives a component's hash from the filename, so it must be the same project-relative path everywhere).
// Plain JavaScript (like scriptCompiler.mjs) so Node tooling can import it without a TypeScript step.
import { compile, compileModule } from "svelte/compiler";

/** The renderer module's specifier as compiled components import it (resolved by the bundler or Vitest). */
export const DEFAULT_RENDERER = "myco/ui-renderer";

/** ADR 0429: the inline HTML parser's specifier, which components that use `{@html}` or `bind:innerHTML` import. */
export const HTML_PARSER = "myco/ui-html";

/**
 * ADR 0429: true for a source that uses `{@html}`, `bind:innerHTML` or Svelte's `createRawSnippet` (whose HTML the
 * renderer's `html` hook reads, as `{@html}`'s), so it needs the inline HTML parser.
 */
export function usesInlineHtml(source) {
  return /\{@html\s/.test(source) || /\bbind:innerHTML\b/.test(source) || /\bcreateRawSnippet\b/.test(source);
}

/** The module code that gives the renderer the inline HTML parser. */
function useHtmlParserCode(renderer) {
  return `\nimport { parseInlineHtml as $$mycoParseHtml } from ${JSON.stringify(HTML_PARSER)};\nimport { useHtmlParser as $$mycoUseHtml } from ${JSON.stringify(renderer)};\n$$mycoUseHtml($$mycoParseHtml);\n`;
}

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
 * (ADR 0423: games ship no CSS parser): `styles` is either a function that parses it now (the editor and
 * the export pass the cascade's stylesheet parser) and returns the data, which is written into the module,
 * or `{ parser }`, a module whose `parseStylesheet` the compiled module calls when it loads (for hosts that
 * can't load the parser while compiling, such as Vitest's transform).
 */
export function compileSvelteUI(source, { filename, renderer = DEFAULT_RENDERER, dev = false, styles }) {
  const r = compile(source, svelteUIOptions(filename, { renderer, dev }));
  let code = r.js.code;
  // ADR 0425: the module mounts its own component, with the Svelte and the renderer it was linked with (the editor's
  // shared runtime, or the game's own bundle), so `UIView` never imports Svelte. A `$` name can't clash with the
  // component's own exports (Svelte reserves it).
  const name = /^export default function ([\w$]+)\(/m.exec(code)?.[1];
  if (!name) throw new Error(`${filename}: the compiled component has no default export function.`);
  code += `\nimport { mountView as $$mycoMountView } from ${JSON.stringify(renderer)};\nexport const $mount = (host, props, options) => $$mycoMountView(host, ${name}, props, options);\n`;
  // ADR 0429: `{@html}`, `bind:innerHTML` and raw snippets need the inline HTML parser; only components that use them
  // import it, so other games never load it.
  if (usesInlineHtml(source)) code += useHtmlParserCode(renderer);
  let css = r.css?.code ?? "";
  if (css.trim()) {
    const add = `import { addStyles as $$mycoAddStyles } from ${JSON.stringify(renderer)};\n`;
    if (typeof styles === "function") code += `\n${add}$$mycoAddStyles(${JSON.stringify(filename)}, ${JSON.stringify(styles(css, filename))});\n`;
    else if (styles?.parser) code += `\n${add}import { parseStylesheet as $$mycoParse } from ${JSON.stringify(styles.parser)};\n$$mycoAddStyles(${JSON.stringify(filename)}, $$mycoParse(${JSON.stringify(css)}, ${JSON.stringify(filename)}));\n`;
    else throw new Error(`${filename} has styles, and nothing was given to parse them (the \`styles\` option).`);
  }
  const injected = injectedStylesOf(code);
  if (injected) {
    // `<svelte:options css="injected" />`: the renderer's `addStyles` hook registers the CSS when the component is
    // created; it's parsed here, so games still ship no CSS parser.
    css = injected.code;
    code += `\n${injectStylesCode(injected, { filename, renderer, styles })}`;
  }
  return { code, map: r.js.map, css, warnings: r.warnings };
}

/**
 * The CSS a component compiled with `css: 'injected'` hands the renderer's `addStyles` hook (Svelte's `$$css`):
 * its scoping hash and scoped CSS, or null for a component without injected styles.
 */
export function injectedStylesOf(code) {
  const lit = `('(?:[^'\\\\]|\\\\.)*'|"(?:[^"\\\\]|\\\\.)*")`;
  const m = new RegExp(`const \\$\\$css = \\{\\s*hash: ${lit},\\s*code: ${lit}\\s*\\};`).exec(code);
  if (!m) return null;
  return { hash: readStringLiteral(m[1]), code: readStringLiteral(m[2]) };
}

const ESCAPES = { n: "\n", t: "\t", r: "\r", b: "\b", f: "\f", v: "\v", 0: "\0" };

/** A JavaScript string literal's value (no `eval`: the editor's page may forbid it). */
function readStringLiteral(literal) {
  return literal.slice(1, -1).replace(/\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|\r\n|[\s\S])/g, (_, e) => {
    if (e[0] === "u") return String.fromCodePoint(parseInt(e[1] === "{" ? e.slice(2, -1) : e.slice(1), 16));
    if (e[0] === "x") return String.fromCharCode(parseInt(e.slice(1), 16));
    if (e === "\n" || e === "\r\n" || e === "\r") return ""; // a line continuation
    return ESCAPES[e] ?? e;
  });
}

/** The module code that gives the renderer an injected stylesheet's rule data (`injectStyles`), keyed by its hash. */
function injectStylesCode({ hash, code }, { filename, renderer, styles }) {
  const add = `import { injectStyles as $$mycoInject } from ${JSON.stringify(renderer)};\n`;
  if (typeof styles === "function") return `${add}$$mycoInject(${JSON.stringify(hash)}, ${JSON.stringify(styles(code, filename))});\n`;
  if (styles?.parser) return `${add}import { parseStylesheet as $$mycoParseInjected } from ${JSON.stringify(styles.parser)};\n$$mycoInject(${JSON.stringify(hash)}, $$mycoParseInjected(${JSON.stringify(code)}, ${JSON.stringify(filename)}));\n`;
  throw new Error(`${filename} has styles, and nothing was given to parse them (the \`styles\` option).`);
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

/**
 * Compile a rune module (`*.svelte.ts`, already stripped of types, or `*.svelte.js`). One that makes raw snippets
 * (`createRawSnippet`) gives the renderer the inline HTML parser, as a component that uses `{@html}` does.
 */
export function compileSvelteUIModule(source, { filename, renderer = DEFAULT_RENDERER, dev = false }) {
  const r = compileModule(source, { filename, generate: "client", dev });
  let code = r.js.code;
  if (/\bcreateRawSnippet\b/.test(source)) code += useHtmlParserCode(renderer);
  return { code, map: r.js.map, warnings: r.warnings };
}
