// Editor registration seam: twoD (T56). Registers flipbooks from slices and the 2D bone editor with weights.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T56.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerTwoD(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
