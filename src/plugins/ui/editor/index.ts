// The UI plugin's editor half (ADR 0140): the `uidocument` (`.ui.xml`), `stylesheet` (`.css`) and `svelte`
// (`.svelte`, ADR 0419) asset kinds, which open in the Code panel; UIDocument's field takes UI documents and
// UIView's Svelte components. New UI documents and components are made here (ADR 0149), so disabling the
// plugin takes "New UI Document" and "New Svelte Component" out of the Assets panel.

import type { EditorPlugin } from "../../../editor/sdk";
import { uiManifest } from "../manifest";
import { createUIDocument } from "./uiDocumentAssets";
import { createSvelteComponent } from "./svelteAssets";


/** A page with a header and a column, stroked in a 24×24 box. */
const UI_DOCUMENT_ICON = "M4 4h16v16H4zM4 9h16M9 9v11";
/** Angle brackets, stroked in a 24×24 box. */
const STYLESHEET_ICON = "M9 8l-4 4 4 4M15 8l4 4-4 4";
/** Angle brackets around a slash (a component tag), stroked in a 24×24 box. */
const SVELTE_ICON = "M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14";


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
      // The New… menu's entry, and what the Hierarchy's Create > UI Document writes first (ADR 0149), in ui/ (ADR 0233).
      folder: "ui",
      create: { label: "New UI Document", category: "UI", create: (folder) => createUIDocument(folder) },
    });
    context.registerAssetKind({ id: "stylesheet", extensions: [".css"], label: "Stylesheet", icon: STYLESHEET_ICON, codeEditor: true });
    // Svelte components (ADR 0419), which UIView's field takes. They compile with the project's scripts (the
    // project code linker), and the New… menu writes a starter one in ui/.
    context.registerAssetKind({
      id: "svelte",
      extensions: [".svelte"],
      label: "Svelte Component",
      icon: SVELTE_ICON,
      codeEditor: true,
      referencedAs: ["svelte"],
      folder: "ui",
      create: { label: "New Svelte Component", category: "UI", create: (folder) => createSvelteComponent(folder) },
    });

  },
};
