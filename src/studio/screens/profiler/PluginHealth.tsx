// The Profiler's Plugins panel (ADR 0352 §9): the running plugin effects' health, live from the runtime
// (`pluginRowsModel.ts`), each with Reset plugin when it faulted or is off after faults.
import type { AudioPluginDebug } from "../../../plugins/audio/runtime/debugTypes";
import { NO_PLUGIN_ROWS, pluginRows } from "./pluginRowsModel";

export interface PluginHealthProps {
  readonly rows: readonly AudioPluginDebug[];
  /** Each type's declared budget per frame (default: the catalogue's registered plugins). */
  readonly budgetOf?: (type: string) => number | null;
  onReset(type: string): void;
}

export function PluginHealth(props: PluginHealthProps) {
  const rows = pluginRows(props.rows, props.budgetOf);
  if (rows.length === 0) return <p class="pf-note">{NO_PLUGIN_ROWS}</p>;
  return (
    <div class="pf-scroll">
      <table class="pf-plugins" aria-label="Plugin effects">
        <thead>
          <tr>
            <th scope="col">Effect</th>
            <th scope="col">State</th>
            <th scope="col">Instructions / frame</th>
            <th scope="col">Memory</th>
            <th scope="col">Faults</th>
            <th scope="col" aria-label="Actions" />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.type} class={r.attention ? "attention" : undefined}>
              <th scope="row" title={`${r.type} (${r.plugin})`}>
                {r.type}
              </th>
              <td>{r.state}</td>
              <td class={r.load !== null && r.load > 1 ? "over" : undefined}>{r.budget !== null ? `${r.perFrame} / ${r.budget}` : r.perFrame}</td>
              <td>{r.memory}</td>
              <td>{r.faults}</td>
              <td>
                {r.resettable && (
                  <button type="button" class="pf-plugin-reset" aria-label={`Reset plugin ${r.type}`} onClick={() => props.onReset(r.type)}>
                    Reset plugin
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
