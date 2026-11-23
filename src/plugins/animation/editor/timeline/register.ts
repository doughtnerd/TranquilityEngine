// Editor registration seam: timeline (T53). Registers the Timeline window: tracks, bindings, blends, camera cuts, nested timelines.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T53.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerTimeline(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
