import type { CompileOptions, Warning } from "svelte/compiler";

/** How a compile turns CSS into the cascade's rule data: parse now (the data goes into the module), or name a module whose `parseStylesheet` runs when it loads. */
export type SvelteUIStyles = ((css: string, filename: string) => unknown) | { readonly parser: string };

export const DEFAULT_RENDERER: string;
export function svelteUIOptions(filename: string, options?: { renderer?: string; dev?: boolean }): CompileOptions;
export function compileSvelteUI(source: string, options: { filename: string; renderer?: string; dev?: boolean; styles?: SvelteUIStyles }): { code: string; map: unknown; css: string; warnings: Warning[] };
export function compileSvelteUIStyles(css: string, options: { filename: string; renderer?: string; styles: SvelteUIStyles }): { code: string };
export function compileSvelteUIModule(source: string, options: { filename: string; dev?: boolean }): { code: string; map: unknown; warnings: Warning[] };
