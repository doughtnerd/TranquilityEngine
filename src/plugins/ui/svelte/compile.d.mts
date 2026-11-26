import type { CompileOptions, Warning } from "svelte/compiler";

export const DEFAULT_RENDERER: string;
export function svelteUIOptions(filename: string, options?: { renderer?: string; dev?: boolean }): CompileOptions;
export function compileSvelteUI(source: string, options: { filename: string; renderer?: string; dev?: boolean }): { code: string; map: unknown; css: string; warnings: Warning[] };
export function compileSvelteUIModule(source: string, options: { filename: string; dev?: boolean }): { code: string; map: unknown; warnings: Warning[] };
