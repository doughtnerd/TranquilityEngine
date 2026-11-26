// The UI plugin's editor half (ADR 0140): the `stylesheet` (`.css`) and `svelte` (`.svelte`, ADR 0419) asset kinds,
// which open in the Code panel; UIView's field takes Svelte components. New components are made here (ADR 0149), so
// disabling the plugin takes "New Svelte Component" out of the Assets panel. (ADR 0419 retired the `uidocument` kind.)

import type { EditorPlugin } from "../../../editor/sdk";
import { loadBuiltinUI } from "../../builtinUILoads";
import { uiManifest } from "../manifest";
import { createSvelteComponent } from "./svelteAssets";


/** Angle brackets, stroked in a 24×24 box. */
const STYLESHEET_ICON = "M9 8l-4 4 4 4M15 8l4 4-4 4";
/** Angle brackets around a slash (a component tag), stroked in a 24×24 box. */
const SVELTE_ICON = "M8 7l-5 5 5 5M16 7l5 5-5 5M14 5l-4 14";


export const uiEditorPlugin: EditorPlugin = {
  manifest: uiManifest,
  activate(context) {
    // The built-in UI component (UIControlMapper's screen, ADR 0419 wave B), compiled with the editor.
    loadBuiltinUI(() => import("../builtinUI")); // the project code load waits for it
    context.registerAssetKind({ id: "stylesheet", extensions: [".css"], label: "Stylesheet", icon: STYLESHEET_ICON, codeEditor: true });
    // Svelte components (ADR 0419), which UIView's field takes. They compile with the project's scripts (the
    // project code linker), and the New… menu (and the Hierarchy's Create > UI View) writes a starter one in ui/.
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
