// Editor registration seam: graphEditor (T51). Registers the Animation Graph panel (pose nodes, state machines,
// transitions, blend spaces, chooser tables, linked graphs, layers, parameters, rig entries), which `*.animgraph.json`
// files open in (the kind's `panel` and Inspector summary, `formats/assetKinds.ts`), and the rig gizmos in the scene view.
// The editor half's `activate()` (`../index.ts`) calls it once per activation.
import type { EditorPluginContext } from "../../../../editor/sdk";
import type { AnimationEditorIntegrations } from "../registration";
import { ANIM_GRAPH_PANEL } from "./panelId";
import { rigGizmoTool } from "./rigGizmo";

/** @internal */
export function registerGraphEditor(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  context.registerPanel({
    id: ANIM_GRAPH_PANEL,
    title: "Animation Graph",
    view: () => import("./AnimGraphPanel").then((m) => m.AnimGraphPanel),
    // Opened by double-clicking a graph; a tab beside the Scene view, as the other graph editors.
    beside: "scene",
    onDemand: true,
  });
  // Rig entries' gizmos (IK targets, poles, spring colliders, look-at limits) over the selected character.
  context.registerViewportTool(rigGizmoTool);
}
