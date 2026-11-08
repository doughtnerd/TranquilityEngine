// The Physics plugin's editor half (ADR 0137): the Project panel's Physics category (gravity, the 2D and
// 3D backend, layers and the collision matrix) and the "(no physics backend)" note in Add Component.
// Still in `src/editor/`: the collider and joint gizmos (`colliderGizmo.ts`, `jointGizmo.ts`, wired by the
// session and the viewport's picking; they move onto the viewport-tool contribution point once it lands) and
// the Inspector's Edit Collider button. The physics Components have no Inspector sections registered yet.
import type { EditorPlugin } from "../../../editor/sdk";
import { pluginOfComponent } from "../../runtimeContext";
import { physicsManifest } from "../manifest";
import { physicsBackends } from "../runtime";
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
  },
};
