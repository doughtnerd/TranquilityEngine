// The Physics plugin's editor half (ADR 0137, 0142): the Project panel's Physics category (gravity, the 2D and
// 3D backend, layers and the collision matrix), the "(no physics backend)" note in Add Component, the scene
// view's collider tool (outlines, Edit Collider handles, 2D outlines selectable) and joint drawing, both viewport
// tools (ADR 0138), and the Edit Collider button in collider cards' headers. The physics Components have no
// Inspector sections registered yet. The overlays themselves are drawn by the engine's Babylon overlay code.
import type { EditorPlugin } from "../../../editor/sdk";
import { pluginOfComponent } from "../../runtimeContext";
import { physicsManifest } from "../manifest";
import { physicsBackends } from "../runtime";
import { colliderTool } from "./colliderGizmo";
import { editColliderAction } from "./EditColliderButton";
import { jointTool } from "./jointGizmo";
import { noBackendNote } from "./physicsEditorModel";

export const physicsEditorPlugin: EditorPlugin = {
  manifest: physicsManifest,
  activate(context) {
    // Project settings > Physics, between Time and Rendering as it has always been.
    context.registerProjectSettingsSection({
      id: "physics",
      title: "Physics",
      after: "Time",
      view: () => import("./PhysicsSettingsSection").then((m) => m.PhysicsSettingsSection),
    });
    context.registerComponentNote({ id: "physics.no-backend", note: (type) => noBackendNote(type, { pluginOf: pluginOfComponent, backendCount: (d) => physicsBackends(d).length }) });
    context.registerViewportTool(colliderTool);
    context.registerViewportTool(jointTool);
    context.registerComponentHeaderAction(editColliderAction);
  },
};
