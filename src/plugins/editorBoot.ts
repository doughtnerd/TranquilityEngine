// Activates the first-party editor plugins (ADR 0133) as a side effect of being imported. It is
// the first import of `main.tsx`, so every contribution (panels among them) is registered before the
// editor renders. The saved layout drops panels nobody registered, and a plugin module may load
// `layout/store.ts` (to show its panel) before this body runs, so the layout is read again after
// activation. A plugin that throws is rolled back by `activatePlugins`; it must not stop the editor,
// so the rest still start.
import { errorStatus } from "../editor/messages";
import { reloadLayout } from "../editor/layout/store";
import { activatePlugins, isPluginActive, type EditorPlugin } from "../editor/sdk/plugins";
import { status } from "../editor/state";
import { EDITOR_PLUGINS } from "./editor";
import { RUNTIME_PLUGINS, activateRuntimePlugins } from "./runtime";

const report = (name: string, err: unknown) => {
  console.error(`Plugin ${name} failed to activate`, err);
  status.value = errorStatus(`Plugin ${name} failed to activate`, err);
};

// The runtime halves first (ADR 0135): the editor's own World draws with them (the sky), and Play uses them.
try {
  activateRuntimePlugins(RUNTIME_PLUGINS);
} catch (err) {
  report("(runtime)", err);
}

// All together, so dependencies order correctly. A failing plugin is rolled back and left out, then
// the rest are tried again (already-active plugins are skipped).
let remaining: readonly EditorPlugin[] = EDITOR_PLUGINS;
while (remaining.length > 0) {
  try {
    activatePlugins(remaining);
    break;
  } catch (err) {
    const failed = remaining.find((p) => !isPluginActive(p.manifest.name));
    if (!failed) {
      report("(unknown)", err);
      break;
    }
    report(failed.manifest.name, err);
    remaining = remaining.filter((p) => p !== failed);
  }
}

reloadLayout();
