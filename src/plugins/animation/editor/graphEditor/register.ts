// Editor registration seam: graphEditor (T51). Registers the graph editor: pose nodes, state machines, transitions, blend spaces, chooser tables, parameters.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T51.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerGraphEditor(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
