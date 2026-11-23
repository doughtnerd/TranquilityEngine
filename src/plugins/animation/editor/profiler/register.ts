// Editor registration seam: profiler (T34). Registers the Animation table of the profiler.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T34.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerProfiler(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
