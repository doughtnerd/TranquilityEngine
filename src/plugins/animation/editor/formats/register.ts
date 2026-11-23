// Editor registration seam: formats (T03t). Registers the animation asset kinds (clips, graphs, timelines, masks, skeleton profiles, pose databases) with their formats and reference rewriting.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T03t.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerFormats(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
