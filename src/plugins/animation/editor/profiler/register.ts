// Editor registration seam: profiler (T34). Registers the Animation table of the Play Stats panel through the editor
// SDK's table point (`registerPlayStatsTable`). The editor half's `activate()` (`../index.ts`) calls it once per activation.
import type { EditorPluginContext, PlayStatsRow } from "../../../../editor/sdk";
import type { World } from "../../../../engine/core/World";
import { animationCoreOf } from "../../runtime/core/service";
import type { AnimationEditorIntegrations } from "../registration";
import { animationRows } from "./profilerLogic";

/** Each World's last rows, shown while it has no frame (paused) instead of the table flickering away. */
const lastRows = new WeakMap<World, readonly PlayStatsRow[]>();

/** The rows for `world`: the averages since the last read, the last rows when none ran, null without animation. */
function rowsFor(world: World): readonly PlayStatsRow[] | null {
  const ns = animationCoreOf(world);
  if (!ns) return null;
  const stats = ns.meter.take();
  if (!stats) return lastRows.get(world) ?? null;
  const rows = animationRows(stats, ns.core.stats());
  lastRows.set(world, rows);
  return rows;
}

/** @internal */
export function registerProfiler(context: EditorPluginContext, _on: AnimationEditorIntegrations): void {
  context.registerPlayStatsTable({ id: "myco.animation.profiler", title: "Animation", rows: rowsFor });
}
