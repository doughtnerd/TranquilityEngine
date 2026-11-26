// The engine's built-in UI components (ADR 0419 wave B): Svelte components the engine's own components mount with a
// `UIView` (`UIControlMapper`, `SubtitleDisplay`), served as assets at `@myco/ui/` paths. The player carries no Svelte
// (ADR 0421), so each host provides them as it provides a project's components:
//   - the editor and Vitest compile them with the engine's build (Vite's `svelteUI()`, `plugins/builtinUIModules.ts`),
//     with the shared runtime;
//   - a game build compiles the ones the project uses into the game's own code, bundled with the runtime it uses
//     (`export/webBuild.ts`), and the player serves each module at its path, as it serves a project's components.
// Imports nothing, so the build configs and the export can read it.

/** A built-in UI component. */
export interface BuiltinUIComponent {
  /** The asset path it's served at (what the engine's component mounts). */
  readonly path: string;
  /** Its source, by path from the engine's root. */
  readonly source: string;
  /** The engine components that mount it, by class name: a project naming one (in a scene, prefab or script) uses it. */
  readonly usedBy: readonly string[];
}

export const BUILTIN_UI_COMPONENTS: readonly BuiltinUIComponent[] = [
  { path: "@myco/ui/ControlMapper.svelte", source: "src/plugins/ui/builtin/ControlMapper.svelte", usedBy: ["UIControlMapper"] },
  { path: "@myco/ui/Subtitles.svelte", source: "src/plugins/subtitles/runtime/SubtitleRows.svelte", usedBy: ["SubtitleDisplay"] },
];

/**
 * The built-in components a project uses: those whose engine component's class name, or its type id (`engine.<name>`,
 * as scenes and prefabs save it), appears in one of `texts` (the project's scenes, prefabs, scripts and UI code).
 */
export function usedBuiltinUI(texts: Iterable<string>): BuiltinUIComponent[] {
  const all = [...texts];
  return BUILTIN_UI_COMPONENTS.filter((c) => c.usedBy.some((name) => all.some((text) => new RegExp(`\\b${name}\\b`).test(text))));
}
