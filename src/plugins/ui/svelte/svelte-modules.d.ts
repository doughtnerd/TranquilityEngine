// Declarations for what the UI plugin's Svelte support imports without types of its own (ADR 0419).

declare module "*.svelte" {
  import type { Component } from "svelte";
  const component: Component<Record<string, unknown>>;
  export default component;
}

// Svelte's internal client runtime, pinned with the package (5.59.2, ADR 0419): only `proxy` is used, to make a
// view's props deeply reactive from TypeScript (what `$state({...})` compiles to).
declare module "svelte/internal/client" {
  export function proxy<T>(value: T): T;
}

// Side-effect modules compiled components import (they set a runtime flag); loaded on demand by `runtimeModules.ts`.
declare module "svelte/internal/flags/custom-renderer" {}
declare module "svelte/internal/flags/tracing" {}
