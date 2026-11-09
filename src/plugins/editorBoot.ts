// Activates the first-party editor plugins (ADR 0133) as a side effect of being imported. It is
// the first import of `main.tsx`, so every contribution (panels among them) is registered before the
// editor renders. The saved layout drops panels nobody registered, and a plugin module may load
// `layout/store.ts` (to show its panel) before this body runs, so the layout is read again after
// activation. A plugin that throws is rolled back by `activatePlugins`; it must not stop the editor,
// so the rest still start.
import { registerCoreAssetKinds } from "../editor/assetKinds";
import { applyEnabledPlugins } from "./editorApply";

// The editor's own asset kinds first (ADR 0134): plugins' kinds join them.
registerCoreAssetKinds();

// Every plugin on: the project isn't known yet. Opening a project applies its `plugins.disabled`
// (`session.ts`, ADR 0133).
applyEnabledPlugins(undefined);
