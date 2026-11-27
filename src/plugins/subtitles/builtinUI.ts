// The Subtitles plugin's built-in UI component (ADR 0423 wave B, `projectCode/builtinUI.ts`) for hosts that compile
// Svelte with the engine's build (Vite's `svelteUI()`): the editor, which loads this when the plugin activates, and
// Vitest. It serves the compiled module at its `@myco/ui/` path, with the host's shared Svelte runtime and renderer. A
// game build compiles it into the game's own code instead (ADR 0425); the player never imports this.
import { Assets } from "../../engine/scene/Assets";
import * as SubtitleRows from "./runtime/SubtitleRows.svelte";
import { SUBTITLES_COMPONENT } from "./runtime/SubtitleDisplay";

Assets.addBuiltinSource(Assets.fromObject({ [SUBTITLES_COMPONENT]: SubtitleRows }));
