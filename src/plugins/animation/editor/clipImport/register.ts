// Editor registration seam: clipImport (T54). Registers clip import settings: takes, loop match, root motion, additive reference, compression report, markers, events and curves.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T54.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerClipImport(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
