// Editor registration seam: the ragdoll builder (ADR 0373, 0375; T55). Generates bodies and limits from bone lengths and
// the skeleton profile's joint ranges (`generateLogic.ts`, over `generateRagdollBones` in the runtime half), edits them in a
// per-bone table and with gizmos, and drops the running character to test them.
// - The Ragdoll card's Inspector section is the builder panel (`RagdollBuilder.tsx`), loaded the first time a Ragdoll is inspected.
// - The viewport tool `myco.ragdoll.builder` draws the bodies and the selected joint's limits and, with "Edit Ragdoll" on,
//   the handles that resize it and set its limits (`ragdollGizmo.ts`).
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
import type { EditorPluginContext } from "../../../../editor/sdk";
import { ragdollTool } from "./ragdollGizmo";

/** @internal */
export function registerRagdollBuilder(context: EditorPluginContext): void {
  context.registerInspectorSection("engine.Ragdoll", () => import("./RagdollBuilder").then((m) => m.RagdollBuilderSection), { single: true });
  context.registerViewportTool(ragdollTool);
}
