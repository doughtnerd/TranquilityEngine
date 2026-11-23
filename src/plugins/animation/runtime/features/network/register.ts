// Registration seam: network (T33). Connects the network feature to the graph runtime (slot plays stamped with their
// tick, stops and links reported: `state.ts`) and to root motion (ghosts' core root deltas left to replication and
// `animation.PredictedRootMotion`: `ghosts.ts`). Replication itself needs no registration: the Animator's replicated
// fields replicate with any `net.Replicated` node, and `animation.PredictedRootMotion` is registered by `activate()`
// when `on.physics`. `activate()` (`../../index.ts`) calls it once per activation.
import type { RuntimePluginContext } from "../../../../runtimeContext";
import type { AnimationIntegrations } from "../../registration";
import { slotNetHooks } from "../graph/runtime";
import { rootMotionHooks } from "../playback/rootMotion";
import { rootMotionSuppressed } from "./ghosts";
import { admitSlotPlay, linkChosen, slotPlayQueued, slotPlayStarted, slotStopped } from "./state";

/** @internal */
export function registerNetwork(_context: RuntimePluginContext, _on: AnimationIntegrations): void {
  slotNetHooks.admit = admitSlotPlay;
  slotNetHooks.queued = slotPlayQueued;
  slotNetHooks.started = slotPlayStarted;
  slotNetHooks.stopped = slotStopped;
  slotNetHooks.linked = linkChosen;
  rootMotionHooks.suppressed = rootMotionSuppressed;
}
