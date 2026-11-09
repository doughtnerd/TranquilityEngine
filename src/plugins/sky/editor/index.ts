// The Sky plugin's editor half (ADR 0134): the `sky` asset kind (New Sky, the Inspector view, opening
// in the Sky panel, accepted by Environment map fields), its asset format and the Sky panel.
import { formatSky, parseSky, type SkySettings } from "../../../engine/sky/skyFormat";
import type { EditorPlugin } from "../../../editor/sdk";
import { skyManifest } from "../manifest";
import { skyThumbnail } from "./thumbnail";
import { createSky, openSkyAsset } from "./skyAssets";

/** A sun over a cloud, stroked in a 24×24 box. */
const SKY_ICON = "M12 3v2M4.2 7.2l1.4 1.4M19.8 7.2l-1.4 1.4M3 13h2M19 13h2M8 13a4 4 0 0 1 8 0M6 20a3 3 0 0 1 .5-6h11a3 3 0 0 1 0 6z";

export const skyEditorPlugin: EditorPlugin = {
  manifest: skyManifest,
  activate(context) {
    context.registerAssetKind({
      id: "sky",
      extensions: [".sky.json"],
      label: "Sky",
      icon: SKY_ICON,
      open: (path) => openSkyAsset(path),
      inspector: () => import("./SkyInspector").then((m) => m.SkyInspector),
      // The New… menu has no submenus, so New Sky makes the default preset; the Sky panel switches presets.
      create: { label: "New Sky", create: (folder) => createSky(folder) },
      referencedAs: ["environment"],
      preview: skyThumbnail,
    });
    context.registerAssetFormat<SkySettings>({
      id: "sky",
      parse: (raw, path) => {
        const { settings, problems } = parseSky(raw, path);
        return { value: settings, problems: problems.map((p) => ({ message: p.message })) };
      },
      format: formatSky,
      writeDelay: 150,
    });
    context.registerPanel({
      id: "sky",
      title: "Sky",
      view: () => import("./SkyPanel").then((m) => m.SkyPanel),
      beside: "particlegraph",
      onDemand: true,
    });
  },
};
