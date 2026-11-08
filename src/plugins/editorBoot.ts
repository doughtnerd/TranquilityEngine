// Activates the first-party editor plugins (ADR 0133) as a side effect of being imported. It is
// the first import of `main.tsx`, so every contribution (panels among them) is registered before
// `layout/store.ts` loads the saved layout, which drops panels nobody registered. A plugin that
// throws is rolled back by `activatePlugins`; it must not stop the editor, so the rest still start.
import { errorStatus } from "../editor/messages";
import { activatePlugins, isPluginActive, type EditorPlugin } from "../editor/sdk/plugins";
import { status } from "../editor/state";
import { EDITOR_PLUGINS } from "./editor";

const report = (name: string, err: unknown) => {
  console.error(`Plugin ${name} failed to activate`, err);
  status.value = errorStatus(`Plugin ${name} failed to activate`, err);
};

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
