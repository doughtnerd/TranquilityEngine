// The Navigation plugin's editor half (ADR 0065, 0134): the `formation` asset kind (the Inspector view that
// paints a formation's mask, accepted by NavGroup's formation asset field) and its asset format. The rest of
// navigation's editor UI (navigation settings, the debug panel, baking, gizmos and previews) still lives in
// `src/editor/`. The Assets panel's New Navigation Formation entry is still built in
// (`createFormation` in `src/editor/formationAssets.ts`): add `create` here when that entry is removed there.
import type { EditorPlugin } from "../../../editor/sdk";
import { navigationManifest } from "../manifest";
import { formationFormat } from "./formationFormat";

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
      referencedAs: ["formation"],
    });
    context.registerAssetFormat(formationFormat);
  },
};
