// Tests' editor halves (ADR 0144): a test file makes the editor halves it needs active through its own
// plugin set, driving the editor activator, and they go again afterwards. Test code only (it registers
// Vitest hooks); editor code, so only editor tests import it.
import { afterAll, afterEach, beforeAll, beforeEach } from "vitest";
import type { EditorPlugin } from "../editor/sdk/plugins";
import { editorActivator } from "./editorActivator";
import { createPluginSet, throwOnPluginProblem } from "./pluginSet";

export interface TestEditorPlugins {
  /** Make the halves active (done by the hooks; again after `off()`). */
  on(): void;
  /** Deactivate them now, as disabling them would (a test of what deactivating removes). */
  off(): void;
}

/**
 * Activate `plugins`' editor halves before the file's tests (`"all"`, the default) or before each test
 * (`"each"`), and deactivate them after.
 */
export function useEditorPlugins(plugins: readonly EditorPlugin[], scope: "all" | "each" = "all"): TestEditorPlugins {
  const set = createPluginSet<never, EditorPlugin>({ editor: editorActivator });
  const entries = plugins.map((p) => ({ manifest: p.manifest, editor: p }));
  const on = () => throwOnPluginProblem(set.apply({ plugins: entries, host: { editor: true } }));
  const off = () => throwOnPluginProblem(set.apply({ plugins: [], host: { editor: true } }));
  if (scope === "all") (beforeAll(on), afterAll(off));
  else (beforeEach(on), afterEach(off));
  return { on, off };
}
