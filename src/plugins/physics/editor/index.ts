// The Physics plugin's editor half (ADR 0137, 0142): the Project panel's Physics category (gravity, the 2D and
// 3D backend, layers and the collision matrix), the "(no physics backend)" note in Add Component, the scene
// view's collider tool (outlines, Edit Collider handles, 2D outlines selectable) and joint drawing, both viewport
// tools (ADR 0138), the collider tool bringing the Edit Collider toggle in collider cards' headers (ADR 0266), and (ADR 0146) fetching the physics core and
// the registered backends' code once the editor is idle. The physics Components have no
// Inspector sections registered yet. The overlays themselves are drawn by the engine's Babylon overlay code.
import type { EditorPlugin } from "../../../editor/sdk";
import { pluginOfComponent } from "../../runtimeContext";
import { physicsManifest } from "../manifest";
import { physicsBackends } from "../runtime";
import { colliderTool, colliderWireframes } from "./colliderGizmo";
import { jointTool } from "./jointGizmo";
import { noBackendNote } from "./physicsEditorModel";
import { physicsLayers, physicsSettings } from "./physicsSettingsModel";

export const physicsEditorPlugin: EditorPlugin = {
  manifest: physicsManifest,
  activate(context) {
    // Project settings > Physics, between Time and Rendering as it has always been; it owns project.json's `physics` (ADR 0151),
    // and renaming a layer renames the physics Components that name it (ADR 0262).
    context.registerProjectSettingsSection({
      id: "physics",
      title: "Physics",
      after: "Time",
      keys: [physicsSettings.key],
      names: [physicsLayers],
      view: () => import("./PhysicsSettingsSection").then((m) => m.PhysicsSettingsSection),
    });
    context.registerComponentNote({ id: "physics.no-backend", note: (type) => noBackendNote(type, { pluginOf: pluginOfComponent, backendCount: (d) => physicsBackends(d).length }) });
    context.registerViewportTool(colliderTool);
    // The 3D colliders' wireframes for other plugins' tools (ADR 0295): the Audio plugin's occluder outlines.
    context.registerComponentWireframe(colliderWireframes);
    context.registerViewportTool(jointTool);
    // A project is likely to need physics: its core and every backend's code load while the editor is idle (ADR 0082).
    context.registerIdlePrefetch({
      id: "myco.physics",
      load: () => Promise.allSettled([import("../runtime/core/index"), ...[...physicsBackends("2d"), ...physicsBackends("3d")].map((b) => b.prefetch?.())]),
    });
  },
};
