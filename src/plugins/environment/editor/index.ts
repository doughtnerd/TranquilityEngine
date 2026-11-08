// The Environment plugin's editor half (ADR 0140): the `environment` (HDR, EXR, DDS and prefiltered
// `.env` maps) and `cubemap` (six images, ADR 0113) asset kinds, their rendered previews and Inspector
// view, and the Environment fields that take them.
import type { EditorPlugin } from "../../../editor/sdk";
import { environmentManifest } from "../manifest";

/** A globe, stroked in a 24×24 box. */
const ENVIRONMENT_ICON = "M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18";
/** A cube, stroked in a 24×24 box. */
const CUBEMAP_ICON = "M12 3l8 4.5v9L12 21l-8-4.5v-9zM12 12l8-4.5M12 12v9M12 12L4 7.5";

const inspector = () => import("./EnvironmentAssetInspector").then((m) => m.EnvironmentAssetInspector);

export const environmentEditorPlugin: EditorPlugin = {
  manifest: environmentManifest,
  activate(context) {
    context.registerAssetKind({
      id: "environment",
      extensions: [".hdr", ".exr", ".dds", ".env"],
      label: "Environment",
      icon: ENVIRONMENT_ICON,
      inspector,
      referencedAs: ["environment"],
      preview: "environment",
    });
    context.registerAssetKind({
      id: "cubemap",
      extensions: [".cubemap.json"],
      label: "Cubemap",
      icon: CUBEMAP_ICON,
      inspector,
      referencedAs: ["environment"],
      preview: "environment",
    });
  },
};
