// Registration seam: profiler (T34). Registers the Animation table's counters (instances evaluated, skipped by LOD, time per stage).
// `activate()` (`../../index.ts`) calls it once per activation; empty until T34.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";

/** @internal */
export function registerProfiler(_context: RuntimePluginContext, _on: AnimationIntegrations): void {}
