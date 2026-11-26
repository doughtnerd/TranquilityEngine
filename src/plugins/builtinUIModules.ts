// The engine's built-in UI components (ADR 0419 wave B, `projectCode/builtinUI.ts`) for hosts that compile Svelte with
// the engine's build (Vite's `svelteUI()`): the editor and Vitest. Importing this serves each compiled module at its
// `@myco/ui/` path, with the host's shared Svelte runtime and renderer. A game build compiles them into the game's own
// code instead (ADR 0421); the player never imports this.
import { Assets } from "../engine/scene/Assets";
import { BUILTIN_UI_COMPONENTS } from "../projectCode/builtinUI";
import * as ControlMapper from "./ui/builtin/ControlMapper.svelte";
import * as SubtitleRows from "./subtitles/runtime/SubtitleRows.svelte";

const modules: Record<string, unknown> = {
  "src/plugins/ui/builtin/ControlMapper.svelte": ControlMapper,
  "src/plugins/subtitles/runtime/SubtitleRows.svelte": SubtitleRows,
};

Assets.addBuiltinSource(
  Assets.fromObject(
    Object.fromEntries(
      BUILTIN_UI_COMPONENTS.map((c) => {
        const module = modules[c.source];
        if (!module) throw new Error(`The built-in UI component ${c.source} isn't imported by builtinUIModules.ts.`);
        return [c.path, module];
      }),
    ),
  ),
);
