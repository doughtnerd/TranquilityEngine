// Sample projects' Svelte UI (ADR 0419) in tests: Vitest compiles a sample's components (`import.meta.glob` of its
// `ui/*.svelte`, eager, through vitest.config.mts's `svelteUI()`), and this serves each module as its file's asset
// value, as the editor and the player serve a project's compiled components (`Assets.setCompiledModules`).
import { Assets } from "../scene/Assets";

/** Serve compiled sample components by their project paths (`.../samples/pirates/ui/Hud.svelte` → `ui/Hud.svelte`). */
export function serveSampleUI(modules: Record<string, unknown>): void {
  Assets.setCompiledModules(new Map(Object.entries(modules).map(([path, module]) => [path.replace(/^.*\/samples\/[^/]+\//, ""), module])));
}
