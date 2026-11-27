// Action set assets as a core asset kind (ADR 0433, 0233): `*.actions.json` files, made with the Assets panel's
// New Action Set and edited in the Input dialog (opening one opens the dialog on it). New Action Set writes a set
// with one button action under a free id (`game.New`, `game.New2`…), lists the file in project.json's
// `input.actionSets` so the boot defines it, and opens the dialog with the set's name selected for typing. Deleting
// or renaming the file updates the list through the asset reference module (0148). Registered at start-up with the
// other core kinds, so this module stays light: the dialog loads on first use.
import type { ActionSetFile } from "../engine/input/actionAssets";
import { ACTION_SET_EXTENSION } from "../engine/input/actionAssets";
import { actionSetFormat } from "./actionSetModel";
import type { AssetKindContribution } from "./sdk/contributions";
import { openInputDialog } from "./ui/dialogState";

/** A list of actions with a play arrow, stroked in a 24×24 box. */
const ACTION_SET_ICON = "M4 6h10M4 12h10M4 18h10M17 9l4 3-4 3z";

export const actionSetKind: AssetKindContribution<ActionSetFile> = {
  id: "actionSet",
  extensions: [ACTION_SET_EXTENSION],
  label: "Action Set",
  icon: ACTION_SET_ICON,
  format: actionSetFormat,
  folder: "input",
  open: (path) => openInputDialog(path),
  create: { label: "New Action Set", category: "Input", create: (folder) => import("./actionSetCreate").then((m) => m.createActionSet(folder)) },
};
