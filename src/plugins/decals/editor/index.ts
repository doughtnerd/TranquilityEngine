// The Decals plugin's editor half (ADR 0381): the projector gizmo and its Edit Bounds toggle, the projector's
// Inspector notes, and the Hierarchy's Decal Projector and 2D Decal entries.
import type { EditorPlugin } from "../../../editor/sdk";
import { decalsManifest } from "../manifest";
import { decalTool } from "./decalGizmo";

export const decalsEditorPlugin: EditorPlugin = {
  manifest: decalsManifest,
  activate(context) {
    context.registerViewportTool(decalTool);
    context.registerInspectorSection("engine.DecalProjector", () => import("./DecalSections").then((m) => m.DecalProjectorSection), { single: true });
    // A projector one unit ahead of where it's made, projecting forward (its default pivot puts the node on the box's back face).
    context.registerHierarchyCreateEntry({
      id: "decal-projector",
      label: "Decal Projector",
      name: "Decal Projector",
      components: (position) => [
        { type: "engine.Transform", data: { position } },
        { type: "engine.DecalProjector", data: {} },
      ],
    });
    // A 2D decal stamps a sprite; dropped under a sprite node, it clips to that sprite (its default clip).
    context.registerHierarchyCreateEntry({
      id: "decal-2d",
      label: "Decal 2D",
      name: "Decal 2D",
      after: "sprite",
      components: (position, sprite) => [
        { type: "engine.Transform", data: { position } },
        { type: "engine.Decal2D", data: sprite ? { sprite } : {} },
      ],
    });
  },
};
