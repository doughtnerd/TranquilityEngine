// Input context assets as a core asset kind (ADR 0143, 0233, 0336, 0433): `*.input.json` files, made with the Assets
// panel's New Input Context and edited in the Input dialog (`ui/input/InputDialog.tsx`), which opening one opens; the
// Inspector's context editor and the Input Context panel it replaced are gone (ADR 0433, Deprecates). A context's file is plain JSON the engine reads (`contexts.ts`); saving it reaches a
// playing World through `Assets.notifyChanged`, which makes its players recompile. Registered at start-up with the
// other core kinds, so this module and its format stay light (no editor SDK, no engine index).
import type { InputContextSpec } from "../engine";
import { inputContextFormat } from "./inputContextModel";
import type { AssetKindContribution } from "./sdk/contributions";
import { openInputDialog } from "./ui/dialogState";

/** A gamepad's cross and buttons, stroked in a 24×24 box. */
const INPUT_ICON = "M6 8h12a4 4 0 0 1 4 4v1a4 4 0 0 1-7 2.6L14 15h-4l-1 .6A4 4 0 0 1 2 13v-1a4 4 0 0 1 4-4zM7 10.5v3M5.5 12h3M16 11h.01M18 13h.01";

export const INPUT_CONTEXT_EXTENSION = ".input.json";

export const inputContextKind: AssetKindContribution<InputContextSpec> = {
  id: "inputContext",
  extensions: [INPUT_CONTEXT_EXTENSION],
  label: "Input Context",
  icon: INPUT_ICON,
  format: inputContextFormat,
  folder: "input",
  open: (path) => openInputDialog(path),
  create: { label: "New Input Context", category: "Input", what: "input contexts" },
  referencedAs: ["inputContext"],
};
