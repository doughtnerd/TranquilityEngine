// The Navigation plugin's editor half (ADR 0065, 0134): the `formation` asset kind (the Inspector view that
// paints a formation's mask, accepted by NavGroup's formation asset field, New Navigation Formation) and its asset
// format; the Navigation category of Project settings (agent types, areas, avoidance, Bake All); the navigation
// counters under the Worlds panel while playing; and the Inspector sections of the NavChunk (bake plan, Bake), NavAgent,
// NavAvoidanceObstacle, NavGroup (formation preview) and the three volume components; the bake runner (`navBake.ts`,
// in a worker); the scene view's navigation drawing and selection previews (`navGizmo.ts`, `navPreviews.ts`, viewport
// tools, ADR 0138) and the Scene toolbar's Nav popover that switches them (a toolbar item, ADR 0142).
import type { EditorPlugin } from "../../../editor/sdk";
import { navigationManifest } from "../manifest";
import { createFormation } from "./formationAssets";
import { formationFormat } from "./formationFormat";
import { navOverlayTool } from "./navGizmo";
import { navPreviewTool } from "./navPreviews";

/** A grid of slots with the front row on top, stroked in a 24×24 box (the icon formations have always had). */
const FORMATION_ICON = "M5 5h3v3H5zM10.5 5h3v3h-3zM16 5h3v3h-3zM8 11h3v3H8zM13 11h3v3h-3zM10.5 17h3v3h-3z";

export const navigationEditorPlugin: EditorPlugin = {
  manifest: navigationManifest,
  activate(context) {
    context.registerAssetKind({
      id: "formation",
      extensions: [".formation.json"],
      label: "Formation",
      icon: FORMATION_ICON,
      inspector: () => import("./FormationInspector").then((m) => m.NavFormationInspector),
      create: { label: "New Navigation Formation", create: (folder) => createFormation(folder) },
      referencedAs: ["formation"],
    });
    context.registerAssetFormat(formationFormat);
    // Project settings > Navigation, after Graphics as it has always been.
    context.registerProjectSettingsSection({
      id: "navigation",
      title: "Navigation",
      after: "Graphics",
      view: () => import("./NavSettingsSection").then((m) => m.NavSettingsSection),
    });
    // The play-mode counters below the Worlds panel.
    context.registerPanelExtension({ id: "navigation-debug", panel: "worlds", view: () => import("./NavDebugPanel").then((m) => m.NavDebugPanel) });
    context.registerInspectorSection("engine.NavChunk", () => import("./NavComponentInspectors").then((m) => m.NavChunkPlanSection), { rootOnly: true });
    context.registerInspectorSection("engine.NavChunk", () => import("./NavChunkInspector").then((m) => m.NavChunkBakeSection), { rootOnly: true });
    context.registerInspectorSection("engine.NavAgent", () => import("./NavComponentInspectors").then((m) => m.NavAgentSection), { single: true });
    context.registerInspectorSection("engine.NavAvoidanceObstacle", () => import("./NavComponentInspectors").then((m) => m.NavAvoidanceObstacleSection), { single: true });
    context.registerInspectorSection("engine.NavGroup", () => import("./NavGroupSection").then((m) => m.NavGroupSection), { rootOnly: true });
    context.registerInspectorSection("engine.NavResolutionVolume", () => import("./NavComponentInspectors").then((m) => m.NavResolutionVolumeSection), { single: true });
    context.registerInspectorSection("engine.NavModifierVolume", () => import("./NavComponentInspectors").then((m) => m.NavModifierVolumeSection), { single: true });
    context.registerInspectorSection("engine.NavCostVolume", () => import("./NavComponentInspectors").then((m) => m.NavCostVolumeSection), { single: true });
    context.registerViewportTool(navOverlayTool);
    context.registerViewportTool(navPreviewTool);
    context.registerSceneToolbarItem({
      id: "myco.navigation.overlay",
      label: "Navigation overlay",
      buttonText: "Nav",
      buttonClass: "nav-overlay",
      title: "Draw the baked navmesh, links and flight volume in the scene view",
      view: () => import("./NavOverlayForm").then((m) => m.NavOverlayForm),
    });
  },
};
