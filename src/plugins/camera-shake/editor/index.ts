// The Camera Shake plugin's editor half (ADR 0435 "Editor"): the Inspector sections under ShakeImpulseSource (its
// preset's envelope plot) and CameraShake (its noise profile), each with a Test button that shakes the running game in
// Play mode, and the scene view's reach rings around selected impulse sources.
import type { EditorPlugin } from "../../../editor/sdk";
import { cameraShakeManifest } from "../manifest";
import { shakeReachTool } from "./shakeGizmo";

export const cameraShakeEditorPlugin: EditorPlugin = {
  manifest: cameraShakeManifest,
  activate(context) {
    context.registerViewportTool(shakeReachTool);
    context.registerInspectorSection("engine.ShakeImpulseSource", () => import("./ShakeSections").then((m) => m.ImpulseSourceSection), { single: true });
    context.registerInspectorSection("engine.CameraShake", () => import("./ShakeSections").then((m) => m.CameraShakeSection), { single: true });
  },
};
