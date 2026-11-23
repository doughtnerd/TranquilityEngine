// Editor registration seam: formats (T03t). Registers the animation asset kinds (clips, graphs, timelines, masks, skeleton profiles, pose databases) with their formats and reference rewriting.
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { ANIMATION_ASSET_KINDS } from "./assetKinds";

/** @internal */
export function registerFormats(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  for (const kind of ANIMATION_ASSET_KINDS) context.registerAssetKind(kind);
}
