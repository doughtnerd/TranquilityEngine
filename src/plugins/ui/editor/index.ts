// The UI plugin's editor half (ADR 0140): the `uidocument` (`.ui.xml`) and `stylesheet` (`.css`) asset
// kinds, which open in the Code panel; UIDocument's field takes UI documents. New UI documents are made
// here (ADR 0149), so disabling the plugin takes "New UI Document" out of the Assets panel.
import type { EditorPlugin } from "../../../editor/sdk";
import { uiManifest } from "../manifest";
import { createUIDocument } from "./uiDocumentAssets";

/** A page with a header and a column, stroked in a 24×24 box. */
const UI_DOCUMENT_ICON = "M4 4h16v16H4zM4 9h16M9 9v11";
/** Angle brackets, stroked in a 24×24 box. */
const STYLESHEET_ICON = "M9 8l-4 4 4 4M15 8l4 4-4 4";

export const uiEditorPlugin: EditorPlugin = {
  manifest: uiManifest,
  activate(context) {
    context.registerAssetKind({
      id: "uidocument",
      extensions: [".ui.xml"],
      label: "UI Document",
      icon: UI_DOCUMENT_ICON,
      codeEditor: true,
      referencedAs: ["uidocument"],
      // The New… menu's entry, and what the Hierarchy's Create > UI Document writes first (ADR 0149).
      create: { label: "New UI Document", create: (folder) => createUIDocument(folder) },
    });
    context.registerAssetKind({ id: "stylesheet", extensions: [".css"], label: "Stylesheet", icon: STYLESHEET_ICON, codeEditor: true });
  },
};
