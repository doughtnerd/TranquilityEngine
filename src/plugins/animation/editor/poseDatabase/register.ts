// Editor registration seam: poseDatabase (T55). Registers the pose database tool and its bake worker.
// The editor half's `activate()` (`../index.ts`) calls it once per activation; empty until T55.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerPoseDatabase(_context: EditorPluginContext, _on: AnimationEditorIntegrations): void {}
