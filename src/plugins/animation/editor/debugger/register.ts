// Editor registration seam: debugger (T52). Registers the live debugger: graph overlay, why-not transitions, live parameters, the recorder.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T52.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerDebugger(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
