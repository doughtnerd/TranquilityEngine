/// <reference path="./svelte-modules.d.ts" />
// The UI runtime modules (ADR 0419) as a host that links project code in memory (the editor, the dedicated
// server) provides them: each specifier compiled UI code may import (`projectCode/uiModules.ts`) loads the
// engine's own copy, so components share one Svelte instance with the renderer `UIView` mounts through. Each
// loads on demand, as its import would: the flag modules set their flag only when some component imports them.
// A game build bundles the same modules into its own code instead, tree-shaken (ADR 0421, projectCode/uiBundle.ts).
import { UI_RUNTIME_SPECIFIERS } from "../../../projectCode/uiModules";

type Loader = () => Promise<object>;

const LOADERS: Readonly<Record<string, Loader>> = {
  svelte: () => import("svelte"),
  "svelte/internal/client": () => import("svelte/internal/client"),
  "svelte/internal/flags/custom-renderer": () => import("svelte/internal/flags/custom-renderer"),
  "svelte/internal/flags/tracing": () => import("svelte/internal/flags/tracing"),
  "svelte/animate": () => import("svelte/animate"),
  "svelte/attachments": () => import("svelte/attachments"),
  "svelte/easing": () => import("svelte/easing"),
  "svelte/events": () => import("svelte/events"),
  "svelte/legacy": () => import("svelte/legacy"),
  "svelte/motion": () => import("svelte/motion"),
  "svelte/reactivity": () => import("svelte/reactivity"),
  "svelte/reactivity/window": () => import("svelte/reactivity/window"),
  "svelte/store": () => import("svelte/store"),
  "svelte/transition": () => import("svelte/transition"),
  "myco/ui-renderer": () => import("./renderer"),
};

for (const s of UI_RUNTIME_SPECIFIERS) if (!LOADERS[s]) throw new Error(`No loader for the UI runtime module "${s}".`);

/** Load the UI runtime module `specifier` (one of `UI_RUNTIME_SPECIFIERS`): its module namespace. */
export function loadUIRuntimeModule(specifier: string): Promise<object> {
  const load = LOADERS[specifier];
  if (!load) return Promise.reject(new Error(`"${specifier}" isn't a UI runtime module.`));
  return load();
}
