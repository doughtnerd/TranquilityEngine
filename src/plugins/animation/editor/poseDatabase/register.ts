// Editor registration seam: poseDatabase (T55). Registers the pose database tool's scene view part; the rest of the tool is
// the `posedb` asset kind's Inspector view (`formats/assetKinds.ts` names it: `PoseDatabaseEditor.tsx`, with the Bake card
// and the baked file's summary) and the bake worker (`bakeRunner.ts`, started by the first bake).
// - The viewport tool `myco.animation.matchDebug` draws the selected Animator's predicted trajectory and matched frame while
//   playing, when the Pose Database tool's debug view is on (`poseDbDebug.ts`; `setMatchDebugSource` gives it data).
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { matchDebugTool } from "./poseDbDebug";

/** @internal */
export function registerPoseDatabase(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  context.registerViewportTool(matchDebugTool);
}
