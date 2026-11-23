// Editor registration seam: skeleton (T54). Registers the bone map and chain editors, retarget preview and bake.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T54.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerSkeleton(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
