// Vitest's setup file (`vitest.config.mts`): every test file starts as the player does, with the
// first-party runtime halves active (ADR 0135), so World services such as physics start in test
// Engines. A test that needs a plugin off deactivates it (and reactivates it afterwards).
import { activateRuntimePlugins, RUNTIME_PLUGINS } from "./runtime";

activateRuntimePlugins(RUNTIME_PLUGINS);
