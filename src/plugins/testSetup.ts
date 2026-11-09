// Vitest's setup file (`vitest.config.mts`): every test file starts as the player does, with the
// first-party runtime halves active (ADR 0135) through a plugin set (ADR 0144), so World services such
// as physics start in test Engines. A test that needs a plugin off applies `applyTestPlugins` with it
// disabled, and `applyTestPlugins()` afterwards.
import { applyTestPlugins } from "./testPlugins";

applyTestPlugins();
