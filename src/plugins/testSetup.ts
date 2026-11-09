// Vitest's setup file (`vitest.config.mts`): every test file starts as the player does, with the
// first-party runtime halves active (ADR 0135), so World services such as physics start in test
// Engines. A test that needs a plugin off deactivates it (and reactivates it afterwards). The editor's
// core asset kinds are registered too, as at editor boot (`editorBoot.ts`); editor plugins are
// activated by the tests that need them.
import { registerCoreAssetKinds } from "../editor/assetKinds";
import { activateRuntimePlugins, RUNTIME_PLUGINS } from "./runtime";

activateRuntimePlugins(RUNTIME_PLUGINS);
registerCoreAssetKinds();
