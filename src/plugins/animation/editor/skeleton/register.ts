// Editor registration seam: skeleton (T54). Registers the bone map and retarget cards of a model's Import Settings, and the
// skeleton profile (chain) editor. The editor half's `activate()` (`../index.ts`) calls it once per activation.
// - Bone map and retarget: cards of the `model` kind's Import Settings (the kind is the Meshes plugin's, so they join through
//   the editor SDK's `registerImportSettingsSection`): they edit the same draft as the model's own rows, and the shell's Apply
//   and Revert write them (`BoneMapEditor.tsx`, `RetargetPanel.tsx`).
// - The chain editor is the `skelprofile` kind's Inspector view (`formats/assetKinds.ts` names it: `ProfileEditor.tsx`).
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";

/** @internal */
export function registerSkeleton(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  context.registerImportSettingsSection({ id: "myco.animation.boneMap", kind: "model", title: "Bone Map", view: () => import("./BoneMapEditor").then((m) => m.BoneMapEditor) });
  context.registerImportSettingsSection({ id: "myco.animation.retarget", kind: "model", title: "Retarget", view: () => import("./RetargetPanel").then((m) => m.RetargetPanel) });
}
