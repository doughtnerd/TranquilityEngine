// Editor registration seam: scene (T18). Registers dropping models with skins (Skeleton, SkinnedMeshRenderers, an Animator), clips dropped on Animators, bones in the Hierarchy and the bone gizmo, clip previews.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T18.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerScene(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
