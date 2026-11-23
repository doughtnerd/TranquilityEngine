// Registers the built-in panels (ADR 0182) as a side effect of being imported. It is the first import of
// `main.tsx`, ahead of the plugins (`editorBoot.ts`) and of any module that loads the layout store, so the
// first layout read from storage already finds every built-in panel in the catalog.
import { registerBuiltinPanels } from "./ui/panels.builtin";
import { registerBuiltinSettingsSections } from "./ui/settings/builtinSections";

registerBuiltinPanels();
// Project Settings > Languages and Subtitles (ADR 0354 L7, 0357 S5): built-in categories that own core keys.
registerBuiltinSettingsSections();
