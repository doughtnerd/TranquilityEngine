// The game parameters panel (ADR 0349 `ParameterPanel`): test values for the game parameters a screen listens to, a
// slider row for a numeric parameter and a select for a labelled one, each with a reset to its default. Test values are
// the Studio's (the owner keeps them, by name; a label as its index) and never saved into the project. With
// `onNewParameter`, "+ New parameter…" sits under the rows (and with the empty line), so a project with none isn't a dead
// end (UI pass J4.1).
import type { ParameterDef } from "../../engine/audio/parameters";
import type { ValueReport } from "../../editor/ui/valueControls";
import { parameterRows } from "./parameterPanelModel";
import { Icon } from "./Icon";
import { ParameterRow } from "./ParameterRow";
import "./audioParts.css";
import "./newParameterDialog.css";
import { EmptyState } from "../../editor/ui/EmptyState";

export interface ParameterPanelProps {
  readonly parameters: readonly ParameterDef[];
  /** Test values by name (a label's index for labelled parameters). */
  readonly values: Readonly<Record<string, number>>;
  /** A unit per parameter name ("km/h"). */
  readonly units?: Readonly<Record<string, string>>;
  /** Shown with no parameters. */
  readonly empty?: string;
  /** A test value changed (`null`: back to the default). */
  onValue(name: string, value: number | null, drag: boolean): void;
  /** Offer "+ New parameter…" (the owner opens the New parameter dialog). */
  onNewParameter?(): void;
}

function NewParameterButton(props: { onClick(): void }) {
  return (
    <button type="button" class="studio-params-new" onClick={props.onClick}>
      <Icon name="plus" size={14} /> New parameter…
    </button>
  );
}

export function ParameterPanel(props: ParameterPanelProps) {
  const rows = parameterRows(props.parameters, props.values, props.units);
  const add = props.onNewParameter;
  if (rows.length === 0) {
    return <EmptyState compact title={props.empty ?? "No game parameters yet."}>{add && <NewParameterButton onClick={add} />}</EmptyState>;
  }
  return (
    <div class="studio-params" role="group" aria-label="Game parameters (test values)">
      {rows.map((row) => {
        const reset = (
          <button type="button" class="studio-icon-button" aria-label={`Reset ${row.name}`} title={`Reset ${row.name} to its default`} disabled={row.isDefault} onClick={() => props.onValue(row.name, null, false)}>
            <Icon name="undo" size={14} />
          </button>
        );
        if (row.kind === "labels") {
          return (
            <div key={row.name} class="studio-params-row">
              <label class="studio-param">
                <span>{row.name}</span>
                <select value={String(row.value)} onChange={(e) => props.onValue(row.name, Number((e.currentTarget as HTMLSelectElement).value), false)}>
                  {row.labels.map((l, i) => (
                    <option key={l} value={String(i)}>
                      {l}
                    </option>
                  ))}
                </select>
              </label>
              {reset}
            </div>
          );
        }
        const report: ValueReport<number> = (v, drag) => props.onValue(row.name, v, drag);
        return (
          <div key={row.name} class="studio-params-row">
            <ParameterRow spec={row.spec} value={row.value} onValue={report} />
            {reset}
          </div>
        );
      })}
      {add && <NewParameterButton onClick={add} />}
    </div>
  );
}
