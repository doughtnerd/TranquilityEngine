// The Lines plugin's editor half (ADR 0382): the line point tool and its Edit Points toggle, the width curve and
// colour gradient section of both Components' Inspector cards, and the Hierarchy's Line and Trail entries (3D and 2D).
import type { EditorPlugin } from "../../../editor/sdk";
import { linesManifest } from "../manifest";
import { linePointsTool } from "./linePointsTool";

const section = () => import("./LineSections").then((m) => m.RibbonSection);

export const linesEditorPlugin: EditorPlugin = {
  manifest: linesManifest,
  activate(context) {
    context.registerViewportTool(linePointsTool);
    context.registerInspectorSection("engine.LineRenderer", section, { single: true });
    context.registerInspectorSection("engine.TrailRenderer", section, { single: true });
    // A new line runs one unit along +X from where it's made, in its node's space so it moves with the node (a line
    // made from scripts or the Inspector defaults to world space, as in Unity).
    const line = (mode: "3d" | "2d") => (position: [number, number, number]) => [
      { type: "engine.Transform", data: { position } },
      { type: "engine.LineRenderer", data: { mode, useWorldSpace: false, positions: [[0, 0, 0], [1, 0, 0]] } },
    ];
    const trail = (mode: "3d" | "2d") => (position: [number, number, number]) => [
      { type: "engine.Transform", data: { position } },
      { type: "engine.TrailRenderer", data: { mode } },
    ];
    context.registerHierarchyCreateEntry({ id: "line", label: "Line", name: "Line", components: line("3d") });
    context.registerHierarchyCreateEntry({ id: "trail", label: "Trail", name: "Trail", after: "line", components: trail("3d") });
    context.registerHierarchyCreateEntry({ id: "line-2d", label: "Line 2D", name: "Line 2D", after: "sprite", components: line("2d") });
    context.registerHierarchyCreateEntry({ id: "trail-2d", label: "Trail 2D", name: "Trail 2D", after: "line-2d", components: trail("2d") });
  },
};
