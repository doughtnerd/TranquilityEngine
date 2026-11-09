// Tests' plugin set (ADR 0144): Vitest's setup file makes every first-party runtime half active through
// it, as the player does; a test that needs plugins off applies it with them disabled, and applies it
// again afterwards to restore the default. No editor imports: every test file's setup loads it.
import { throwOnPluginProblem } from "./pluginSet";
import { createRuntimePluginSet, firstPartyRuntimePlugins } from "./runtime";

const testPlugins = createRuntimePluginSet();

/** Make the first-party runtime halves active, minus `disabled` (and what needs them). Throws on a problem. */
export function applyTestPlugins(disabled: readonly string[] = []): void {
  throwOnPluginProblem(testPlugins.apply({ plugins: firstPartyRuntimePlugins(), disabled }));
}
