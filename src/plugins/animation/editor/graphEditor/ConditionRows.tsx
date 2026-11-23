// The condition rows editor (ADR 0373 "a condition editor: rows of parameter, operator and value, joined by all or any"):
// a join select and one row per comparison — what it compares (a parameter, a state operand, a curve or a request), the
// operators its type takes and a typed value. Used by the transition list and the chooser table. Each edit is
// `conditionLogic.ts`'s refused-or-next result, handed to `apply` (one undo step, or the refusal reported).
import type { AnimGraph, CmpOp, Condition } from "../../../../engine/animation/animGraph";
import { mapEdit, type EditResult } from "../../../../editor/sdk";
import {
  addRow, booleanValue, conditionRows, conditionText, isGroup, operatorsFor, removeRow, requestLive, rowSubject, rowsCondition, setJoin, setRequestLive, setRowOp, setRowSubject, setRowValue, subjectChoices,
  type ConditionJoin, type ConditionRows as Rows, type RowSubject,
} from "./conditionLogic";

export interface ConditionRowsProps {
  graph: AnimGraph;
  condition: Condition | null;
  /** Apply the condition's next value (null: always), with its undo label. */
  apply(result: EditResult<Condition | null>, label: string): void;
  /** What the rows are for, in labels ("Idle → Move"). */
  label: string;
  readOnly?: boolean;
  /** Shown when there are no rows ("Always" for a transition). */
  empty?: string;
}

const subjectValue = (s: RowSubject) => (s.kind === "param" ? `param:${s.name}` : s.kind === "operand" ? `operand:${s.operand}` : s.kind);

export function ConditionRows(props: ConditionRowsProps) {
  const { graph, label, readOnly = false } = props;
  const rows = conditionRows(props.condition);
  const choices = subjectChoices(graph);
  const apply = (r: EditResult<Rows>, what: string) => props.apply(mapEdit(r, rowsCondition), `${what} (${label})`);
  const pickSubject = (i: number, value: string, current: RowSubject) => {
    const choice = choices.find((c) => c.value === value);
    const subject: RowSubject = choice ? choice.subject : value === "curve" ? { kind: "curve", name: current.kind === "curve" ? current.name : "curve" } : { kind: "request", name: current.kind === "request" ? current.name : "Request" };
    apply(setRowSubject(graph, rows, i, subject), "Change condition");
  };
  return (
    <div class="ag-conditions" role="group" aria-label={`Conditions of ${label}`}>
      <div class="ag-conditions-head">
        <span>When</span>
        <select aria-label={`Join of ${label}`} value={rows.join} disabled={readOnly || rows.rows.length < 2} onChange={(e) => apply(setJoin(rows, (e.currentTarget as HTMLSelectElement).value as ConditionJoin), "Change condition join")}>
          <option value="all">all of these hold</option>
          <option value="any">any of these holds</option>
        </select>
      </div>
      {rows.rows.length === 0 && <p class="ag-muted">{props.empty ?? "Always"}</p>}
      {rows.rows.map((row, i) => {
        if (isGroup(row)) {
          return (
            <div class="ag-condition-row ag-condition-group" key={i}>
              <span title="A nested group, as the file wrote it">({conditionText(row)})</span>
              <button class="icon" aria-label={`Remove condition ${i + 1} of ${label}`} disabled={readOnly} onClick={() => apply(removeRow(rows, i), "Remove condition")}>×</button>
            </div>
          );
        }
        const subject = rowSubject(row)!;
        const ops = operatorsFor(graph, subject);
        const boolean = booleanValue(graph, subject);
        const r = row as { op: CmpOp; value: number | boolean };
        const n = i + 1;
        return (
          <div class="ag-condition-row" key={i} data-row={i}>
            <select aria-label={`Condition ${n} subject of ${label}`} value={subjectValue(subject)} disabled={readOnly} onChange={(e) => pickSubject(i, (e.currentTarget as HTMLSelectElement).value, subject)}>
              {subject.kind === "param" && !choices.some((c) => c.value === subjectValue(subject)) && <option value={subjectValue(subject)}>{subject.name} (missing)</option>}
              {choices.map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
              <option value="curve">Curve…</option>
              <option value="request">Request…</option>
            </select>
            {(subject.kind === "curve" || subject.kind === "request") && (
              <input
                type="text"
                class="ag-condition-name"
                aria-label={`Condition ${n} ${subject.kind} name of ${label}`}
                value={subject.name}
                disabled={readOnly}
                onChange={(e) => apply(setRowSubject(graph, rows, i, { kind: subject.kind, name: (e.currentTarget as HTMLInputElement).value }), "Change condition")}
              />
            )}
            {subject.kind !== "request" && (
              <select aria-label={`Condition ${n} operator of ${label}`} value={r.op} disabled={readOnly} onChange={(e) => apply(setRowOp(graph, rows, i, (e.currentTarget as HTMLSelectElement).value as CmpOp), "Change condition operator")}>
                {ops.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            )}
            {boolean ? (
              <select
                aria-label={`Condition ${n} value of ${label}`}
                value={subject.kind === "request" ? String(requestLive(row)) : String(r.value)}
                disabled={readOnly}
                onChange={(e) => {
                  const v = (e.currentTarget as HTMLSelectElement).value === "true";
                  if (subject.kind === "request") apply(setRequestLive(rows, i, v), "Change condition value");
                  else apply(setRowValue(graph, rows, i, v), "Change condition value");
                }}
              >
                <option value="true">{subject.kind === "request" ? "is live" : "true"}</option>
                <option value="false">{subject.kind === "request" ? "isn't live" : "false"}</option>
              </select>
            ) : (
              <input
                type="number"
                step="any"
                class="ag-condition-value"
                aria-label={`Condition ${n} value of ${label}`}
                value={r.value as number}
                disabled={readOnly}
                onChange={(e) => {
                  const v = (e.currentTarget as HTMLInputElement).valueAsNumber;
                  if (Number.isFinite(v)) apply(setRowValue(graph, rows, i, v), "Change condition value");
                }}
              />
            )}
            <button class="icon" aria-label={`Remove condition ${n} of ${label}`} disabled={readOnly} onClick={() => apply(removeRow(rows, i), "Remove condition")}>×</button>
          </div>
        );
      })}
      <button class="ag-add" disabled={readOnly} onClick={() => apply(addRow(graph, rows), "Add condition")}>+ Condition</button>
    </div>
  );
}
