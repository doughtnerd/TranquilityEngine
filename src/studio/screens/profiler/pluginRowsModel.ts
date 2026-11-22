// The Profiler's Plugins panel (ADR 0338 §9, §6): one row per registered plugin effect from the runtime's
// `Audio.debug().plugins`, live (not from a capture): its state, instructions per frame against its declared budget,
// memory and faults, as the effect cards show them (`effectChainModel.ts` `pluginHealthView`), sorted with the rows
// that need attention first. Pure.
import type { AudioPluginDebug } from "../../../plugins/audio/runtime/debugTypes";
import { pluginHealthView, type PluginHealthView } from "../../components/effectChainModel";

export interface PluginRow extends PluginHealthView {
  /** True when the row needs attention: off after faults, failed, faulted, or over its budget. */
  readonly attention: boolean;
}

/** What the panel says when there are no rows. */
export const NO_PLUGIN_ROWS = "No plugin effects are running. A project's plugins with an audio section load their effects here.";

/** The panel's rows from `rows` (`budgetOf` gives each type's declared budget per frame). */
export function pluginRows(rows: readonly AudioPluginDebug[], budgetOf?: (type: string) => number | null): PluginRow[] {
  return rows
    .map((r) => {
      const view = budgetOf ? pluginHealthView(r, budgetOf(r.type)) : pluginHealthView(r);
      const attention = r.state === "disabled" || r.state === "failed" || view.faults !== "no faults" || (view.load !== null && view.load > 1);
      return { ...view, attention };
    })
    .sort((a, b) => Number(b.attention) - Number(a.attention) || a.type.localeCompare(b.type));
}
