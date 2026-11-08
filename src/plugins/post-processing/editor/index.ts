// The Post-processing plugin's editor half (ADR 0140): the `lut` asset kind (`.cube` colour lookup
// tables), taken by PostProcessing's colour grading field.
import type { EditorPlugin } from "../../../editor/sdk";
import { postProcessingManifest } from "../manifest";

/** A grid, stroked in a 24×24 box. */
const LUT_ICON = "M4 4h16v16H4zM4 12h16M12 4v16M8 4v16M16 4v16";

export const postProcessingEditorPlugin: EditorPlugin = {
  manifest: postProcessingManifest,
  activate(context) {
    context.registerAssetKind({ id: "lut", extensions: [".cube"], label: "Colour LUT", icon: LUT_ICON, referencedAs: ["lut"] });
  },
};
