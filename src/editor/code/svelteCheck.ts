// Type checking inside Svelte components (ADR 0432): each project component (`*.svelte`) becomes TypeScript through
// svelte2tsx, the transform svelte-check uses, for the Code panel's TypeScript service (code/monaco.ts), and the
// service's errors in that TypeScript map back to the component through svelte2tsx's source map. Imports of a
// component (`./Hud.svelte`) resolve to its TypeScript, so components, rune modules and scripts see each other's
// types. Editor only: svelte2tsx (and the TypeScript compiler it parses scripts with) load on first use, and games
// never load either. No Monaco here, so it is tested with the TypeScript compiler.
import svelteTypes from "../../../node_modules/svelte/types/index.d.ts?raw"; // not in the package's exports, so by path
import svelteElements from "../../../node_modules/svelte/elements.d.ts?raw";
import svelteShims from "../../../node_modules/svelte2tsx/svelte-shims-v4.d.ts?raw";
import { decodeMappings, originalPosition, type DecodedMappings } from "./sourceMaps";

/**
 * What the HTML elements of generated components accept: Svelte's HTML typings (`svelte/elements`), as
 * `svelte/svelte-html.d.ts` declares them, plus any other attribute. Engine elements take their UI component's
 * fields as attributes (`text`, `max-length`, `interactable`…), which no HTML typing lists, so attribute names
 * aren't checked; HTML's attributes keep their types, event handlers get their event types, and every expression
 * is checked.
 */
const SVELTE_HTML = `/// <reference lib="dom" />
import type * as svelteElements from "svelte/elements";
type MycoElement<Key> = Key extends keyof ElementTagNameMap ? ElementTagNameMap[Key] : Key extends keyof SVGElementTagNameMap ? SVGElementTagNameMap[Key] : any;
declare global {
  namespace svelteHTML {
    function mapElementTag<K extends keyof ElementTagNameMap>(tag: K): ElementTagNameMap[K];
    function mapElementTag<K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K];
    function mapElementTag(tag: any): any;
    function createElement<Elements extends IntrinsicElements, Key extends keyof Elements>(
      element: Key | undefined | null,
      attrs: (string extends Key ? svelteElements.HTMLAttributes<any> : Elements[Key]) & EngineAttributes,
    ): MycoElement<Key>;
    function createElement<Elements extends IntrinsicElements, Key extends keyof Elements, T>(
      element: Key | undefined | null,
      attrsEnhancers: T,
      attrs: (string extends Key ? svelteElements.HTMLAttributes<any> : Elements[Key]) & T & EngineAttributes,
    ): MycoElement<Key>;
    /** Engine elements' attributes: their UI component's fields, in kebab-case (ADR 0423). */
    interface EngineAttributes { readonly [name: string]: unknown }
    interface HTMLAttributes<T extends EventTarget = any> {}
    interface SVGAttributes<T extends EventTarget = any> {}
    interface IntrinsicElements extends svelteElements.SvelteHTMLElements {
      [name: string]: { [name: string]: any };
    }
  }
}
export {};
`;

/**
 * The declarations generated components need, by path (`node_modules/…`, served at `file:///node_modules/…` beside
 * the engine's): Svelte's (its modules, the runes and `svelte/elements`), svelte2tsx's shims, and the HTML elements'
 * typings above.
 */
export const SVELTE_CHECK_TYPES: ReadonlyMap<string, string> = new Map([
  ["node_modules/svelte/package.json", JSON.stringify({ name: "svelte", types: "types/index.d.ts" })],
  ["node_modules/svelte/types/index.d.ts", svelteTypes],
  ["node_modules/svelte/elements.d.ts", svelteElements],
  ["node_modules/svelte2tsx/svelte-shims-v4.d.ts", svelteShims],
  ["node_modules/.myco-svelte/svelte-html.d.ts", SVELTE_HTML],
]);

/** A span of a component, 1-based: where a type error in its TypeScript came from. */
export interface ComponentRange {
  readonly line: number;
  readonly column: number;
  readonly endLine: number;
  readonly endColumn: number;
}

/** A component as TypeScript, for the TypeScript service. */
export interface ComponentTypeScript {
  /** The component's project path. */
  readonly path: string;
  /** Where its TypeScript goes (project path): what an import of the component resolves to. */
  readonly generated: string;
  readonly code: string;
  /**
   * Whether its errors are reported: its script is TypeScript (`lang="ts"`), or it has none. A JavaScript component
   * is typed for its importers but not checked, as svelte-check leaves JavaScript alone.
   */
  readonly checked: boolean;
  /** A syntax error that stopped the transform (the component is then typed as any component). */
  readonly error: (ComponentRange & { readonly message: string }) | null;
  /** The component's span a span of the TypeScript (offset and length) came from, or null for code svelte2tsx added. */
  sourceRange(start: number, length: number): ComponentRange | null;
}

/**
 * Where a component's TypeScript goes: `Hud.svelte.ts`, which an import of `./Hud.svelte` resolves to (TypeScript
 * tries the specifier with `.ts` added). When a rune module already has that name (`taken`), `Hud.svelte.tsx`, which
 * such an import then doesn't reach (it resolves to the rune module, which TypeScript tries first).
 */
export function generatedPathOf(path: string, taken: (path: string) => boolean = () => false): string {
  return taken(`${path}.ts`) ? `${path}.tsx` : `${path}.ts`;
}

type Svelte2tsx = typeof import("svelte2tsx").svelte2tsx;
let transform: Promise<Svelte2tsx> | null = null;

/** svelte2tsx, loaded once (it brings the TypeScript compiler and Svelte's parser, which the editor loads on demand anyway). */
function loadTransform(): Promise<Svelte2tsx> {
  transform ??= import("svelte2tsx").then(
    (m) => m.svelte2tsx,
    (err: unknown) => {
      transform = null;
      throw err;
    },
  );
  return transform;
}

/** Offsets where each line of `text` starts. */
function lineStarts(text: string): number[] {
  const out = [0];
  for (let i = 0; i < text.length; i++) if (text.charCodeAt(i) === 10) out.push(i + 1);
  return out;
}

/** The 0-based line and column of `offset` in text with `starts` (from `lineStarts`). */
function positionOf(starts: readonly number[], offset: number): { line: number; column: number } {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return { line: lo, column: offset - starts[lo] };
}

const IGNORE_START = "/*Ωignore_startΩ*/";
const IGNORE_END = "/*Ωignore_endΩ*/";

// The spans svelte2tsx marks as its own (between IGNORE_START and IGNORE_END), as [start, end) offsets.
function ignoredSpans(code: string): [number, number][] {
  const out: [number, number][] = [];
  for (let at = code.indexOf(IGNORE_START); at >= 0; at = code.indexOf(IGNORE_START, at + 1)) {
    const end = code.indexOf(IGNORE_END, at);
    out.push([at, end < 0 ? code.length : end + IGNORE_END.length]);
  }
  return out;
}

/** Whether a component's `<script>` (not `<script module>` alone) is TypeScript, or it has no script. */
function isTypeScriptComponent(source: string): boolean {
  const scripts = [...source.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1]);
  return scripts.length === 0 || scripts.some((attrs) => /\blang\s*=\s*["']?(ts|typescript)\b/.test(attrs));
}

/** A Svelte syntax error as a component range (Svelte's lines are 1-based, its columns 0-based) and its first line. */
function syntaxError(err: unknown): ComponentRange & { readonly message: string } {
  const e = err as { message?: string; start?: { line?: number; column?: number }; end?: { line?: number; column?: number } };
  const line = e?.start?.line ?? 1;
  const column = (e?.start?.column ?? 0) + 1;
  const end = e?.end?.line !== undefined && e.end.column !== undefined ? { line: e.end.line, column: e.end.column + 1 } : { line, column: column + 1 };
  return { line, column, endLine: end.line, endColumn: Math.max(end.column, end.line === line ? column + 1 : 1), message: String(e?.message ?? err).split("\n")[0] };
}

/** What an unreadable component is typed as: any component. */
const ANY_COMPONENT = 'import type { Component } from "svelte";\ndeclare const component: Component<any>;\nexport default component;\n';

/**
 * The TypeScript of component `path` with text `source`, written to `generated` (`generatedPathOf`). A syntax error
 * svelte2tsx can't get past types it as any component and is returned as `error`.
 */
export async function componentTypeScript(path: string, source: string, generated: string = generatedPathOf(path)): Promise<ComponentTypeScript> {
  const svelte2tsx = await loadTransform();
  const checked = isTypeScriptComponent(source);
  const run = (emitOnTemplateError: boolean) => svelte2tsx(source, { filename: path, isTsFile: checked, mode: "ts", emitOnTemplateError });
  let out: ReturnType<Svelte2tsx>;
  let error: ComponentTypeScript["error"] = null;
  try {
    out = run(false);
  } catch (err) {
    // A syntax error is reported, and the TypeScript of what can be read still types the component when svelte2tsx gets past it.
    error = syntaxError(err);
    try {
      out = run(true);
    } catch {
      return { path, generated, code: ANY_COMPONENT, checked, error, sourceRange: () => null };
    }
  }
  const code = out.code;
  const mappings: DecodedMappings = decodeMappings(out.map.mappings);
  const generatedStarts = lineStarts(code);
  const ignored = ignoredSpans(code);
  const toSource = (offset: number) => {
    const at = positionOf(generatedStarts, offset);
    return originalPosition(mappings, at.line, at.column);
  };
  return {
    path,
    generated,
    code,
    checked,
    error,
    sourceRange(start, length) {
      if (ignored.some(([from, to]) => start >= from && start < to)) return null;
      const from = toSource(start);
      if (!from) return null;
      const last = length > 0 ? toSource(start + length - 1) : null;
      // The last character's position, one past it; a span the map splits across lines ends where it starts.
      const to = last && (last.line > from.line || (last.line === from.line && last.column >= from.column)) ? { line: last.line, column: last.column + 1 } : { line: from.line, column: from.column + Math.max(length, 1) };
      return { line: from.line + 1, column: from.column + 1, endLine: to.line + 1, endColumn: to.column + 1 };
    },
  };
}
