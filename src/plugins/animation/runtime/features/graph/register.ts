// Registration seam: graph (T32). Graph-asset Animators get their instances from the graph runtime (`./runtime.ts`)
// through `../instances.ts`'s `graphInstanceHooks`; the blackboard, computed parameters and `animatorParams` run in the
// gather and apply sub-steps (`stages/gather/graph.ts`, `stages/apply/graph.ts`). `activate()` (`../../index.ts`) calls
// it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { clipUsers, graphInstanceHooks } from "../instances";
import { createGraphInstance, graphClipsInUse, graphInstanceUnbound } from "./runtime";

/** @internal */
export function registerGraph(_context: RuntimePluginContext, _on: AnimationIntegrations): void {
  graphInstanceHooks.create = createGraphInstance;
  clipUsers.add(graphClipsInUse);
  graphInstanceHooks.unbound = graphInstanceUnbound;
}
