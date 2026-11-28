import type { CompileOptions } from "svelte/compiler";
import type { Plugin } from "vite";
export const RENDERER: string;
export function svelteOptions(filename: string, extra?: Partial<CompileOptions>): CompileOptions;
export function svelteUI(options?: { dev?: boolean }): Plugin;
