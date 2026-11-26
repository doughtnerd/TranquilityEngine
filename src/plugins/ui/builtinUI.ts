// The UI plugin's built-in UI component (ADR 0419 wave B, `projectCode/builtinUI.ts`) for hosts that compile Svelte with
// the engine's build (Vite's `svelteUI()`): the editor, which loads this when the plugin activates, and Vitest. It serves
// the compiled module at its `@myco/ui/` path, with the host's shared Svelte runtime and renderer. A game build
// compiles it into the game's own code instead (ADR 0421); the player never imports this.
import { Assets } from "../../engine/scene/Assets";
import * as ControlMapper from "./builtin/ControlMapper.svelte";
import { CONTROL_MAPPER_COMPONENT } from "./runtime/UIControlMapper";

Assets.addBuiltinSource(Assets.fromObject({ [CONTROL_MAPPER_COMPONENT]: ControlMapper }));
