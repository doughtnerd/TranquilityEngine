// Ed6 (api-and-models §7, contract H6): the rules table of a music container: a from-by-to grid over the container's
// direct children plus `*`, every cell showing the rule that wins the pair (the same answer R1 gives at run time, read
// through `rulesModel.ts`), the chosen cell's rule highlighted in the rule list, and a "why" readout of tier and index.
// Ed7 adds beside it: the rule editor (`RuleEditor.tsx`), the lint rows and badges (`ruleLint.ts`) and "audition this
// transition" (`ruleAudition.ts`, through the editor's one audition, ADR 0268). The panel is a view over the container's
// music node handle (ADR 0313): edits go through it as one undo step each, and segment lengths come from its clip facts.
import { signal } from "@preact/signals";
import { useMemo, useState } from "preact/hooks";
import type { MusicContainerNode } from "../../../../engine/audio/musicFormat";
import { musicLeaves } from "../../../../engine/audio/musicTree";
import { buildRulesGrid, explainPair, ruleMatchesPair } from "./rulesModel";
import { openRules } from "./index";
import { MusicNodePanel } from "./MusicNodePanel";
import type { MusicNodeHandle } from "./musicNodeHandle";
import { RuleEditor } from "./RuleEditor";
import { addRule, duplicateRule, moveRule, removeRule } from "./ruleEdits";
import type { EditResult } from "../editResult";
import { issuesOfRule, lintTransitionRules, worstSeverity } from "./ruleLint";
import { planTransitionAudition, runTransitionAudition } from "./ruleAudition";
import { editorAudition } from "../audition/editorAudition";
import "./rulesTable.css";
import "./ruleEditor.css";

/** The pair chosen in the grid, per container (`event` + `nodeId`); a pair that no longer exists is ignored. */
const chosen = signal<{ readonly key: string; readonly from: string; readonly to: string } | null>(null);

/** The rule being edited, per container (`event#nodeId`). */
const editing = signal<{ readonly key: string; readonly index: number } | null>(null);

export function RulesTable() {
  const open = openRules.value;
  return (
    <MusicNodePanel
      open={open && { event: open.event, id: open.nodeId }}
      kind="container"
      idle="Rules: open a playlist or music switch from the Event editor to see its transition rules here."
      view={(handle, container) => <OpenRules handle={handle} container={container} />}
    />
  );
}

function OpenRules({ handle, container }: { handle: MusicNodeHandle<MusicContainerNode>; container: MusicContainerNode }) {
  const path = handle.path;
  const event = handle.asset;
  const grid = useMemo(() => buildRulesGrid(container), [container]);
  const [auditionText, setAuditionText] = useState<string | null>(null);

  const key = `${path}#${handle.id}`;
  const pick = chosen.value && chosen.value.key === key ? chosen.value : null;
  const ids = new Set(grid.rows.map((h) => h.id));
  const from = pick && ids.has(pick.from) ? pick.from : null;
  const to = pick && ids.has(pick.to) ? pick.to : null;
  const readout = from !== null && to !== null ? explainPair(container, from, to) : null;
  const winner = readout ? readout.rule : null;
  const winsCell = new Set(grid.cells.flat().map((c) => c.rule));
  const winsChild = new Set(grid.effective);

  const lengthOf = (id: string): number | undefined => {
    const clip = musicLeaves(container, { library: true }).find((s) => s.id === id)?.tracks[0]?.clip;
    return clip ? handle.seconds(clip) : undefined;
  };
  const issues = lintTransitionRules(container, { lengthOf });
  const sel = editing.value && editing.value.key === key && editing.value.index < container.transitions.length ? editing.value.index : null;
  const readOnly = handle.readOnly;
  /** Apply an edit of the container through its handle (ADR 0307, 0313): one undo step, or the refusal in the status bar. */
  const apply = (edit: EditResult<MusicContainerNode>, label: string): boolean => handle.apply(edit, label);
  const tool = (edit: EditResult<MusicContainerNode>, label: string, select?: number): void => {
    if (apply(edit, label) && select !== undefined) editing.value = select < 0 ? null : { key, index: select };
  };
  const plan = sel === null ? null : planTransitionAudition(path, event, container, sel, from !== null && to !== null ? { pair: { from, to } } : {});
  const audition = (bar: number | undefined): void => {
    if (sel === null) return;
    const p = planTransitionAudition(path, event, container, sel, { ...(from !== null && to !== null ? { pair: { from, to } } : {}), ...(bar !== undefined ? { bar } : {}) });
    if (!p.ok) return void setAuditionText(p.reason);
    setAuditionText(p.note);
    void runTransitionAudition(editorAudition, p);
  };

  return (
    <div class="rules-table" data-asset-document={path}>
      <h3>{container.id}: transitions</h3>
      <div class="rt-scroll">
        <table class="rt-grid" role="grid" aria-label="Transition rules, from by to">
          <thead>
            <tr>
              <th class="rt-corner" scope="col">from \ to</th>
              {grid.columns.map((c) => <th key={c.id} scope="col" class={c.isWildcard ? "rt-wild" : ""}>{c.label}</th>)}
            </tr>
          </thead>
          <tbody>
            {grid.rows.map((r, ri) => (
              <tr key={r.id}>
                <th scope="row" class={r.isWildcard ? "rt-wild" : ""}>{r.label}</th>
                {grid.cells[ri].map((cell) => {
                  const on = from === cell.from && to === cell.to;
                  const same = winner !== null && cell.rule === winner;
                  return (
                    <td
                      key={cell.to}
                      role="gridcell"
                      tabIndex={0}
                      aria-selected={on}
                      class={`rt-cell tier${cell.tier}${cell.isDefault ? " rt-default" : ""}${on ? " rt-on" : ""}${same ? " rt-same" : ""}`}
                      data-from={cell.from}
                      data-to={cell.to}
                      data-rule={cell.rule}
                      data-tier={cell.tier}
                      title={`${cell.from} to ${cell.to}: ${cell.isDefault ? "default rule" : `rule ${cell.rule} (${cell.ruleKey})`}, tier ${cell.tier}`}
                      onClick={() => (chosen.value = { key, from: cell.from, to: cell.to })}
                      onKeyDown={(e) => {
                        if (e.key === "Enter" || e.key === " ") { e.preventDefault(); chosen.value = { key, from: cell.from, to: cell.to }; }
                      }}
                    >
                      {cell.isDefault ? "default" : `#${cell.rule}`}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div class="rt-why" aria-live="polite">
        {readout ? (
          <>
            <div class="rt-why-head">{readout.from} to {readout.to}</div>
            <div>{readout.tierText}</div>
            <div>{readout.ruleText}</div>
            <div class="rt-muted">{readout.summary}</div>
            {readout.beatenRules.length > 0 && <div class="rt-muted">Also matches: {readout.beatenRules.map((i) => `#${i}`).join(", ")} (beaten)</div>}
          </>
        ) : (
          <div class="rt-muted">Choose a cell to see why its rule wins.</div>
        )}
      </div>

      <h3>Rules, in list order</h3>
      <div class="rt-toolbar">
        <button type="button" disabled={readOnly} onClick={() => tool(addRule(container, from !== null && to !== null ? { from, to } : {}), "Add transition rule", container.transitions.length)}>Add rule</button>
        <button type="button" disabled={readOnly || sel === null} onClick={() => sel !== null && tool(duplicateRule(container, sel), "Duplicate transition rule", sel + 1)}>Duplicate</button>
        <button type="button" disabled={readOnly || sel === null || sel === 0} onClick={() => sel !== null && tool(moveRule(container, sel, -1), "Move rule up", sel - 1)}>Up</button>
        <button type="button" disabled={readOnly || sel === null || sel === container.transitions.length - 1} onClick={() => sel !== null && tool(moveRule(container, sel, 1), "Move rule down", sel + 1)}>Down</button>
        <button type="button" disabled={readOnly || sel === null} onClick={() => sel !== null && tool(removeRule(container, sel), "Remove transition rule", -1)}>Remove</button>
      </div>
      {container.transitions.length === 0 ? (
        <p class="rt-muted">No rules: every change uses the default rule (bar exit, entry cue, 1 beat equal-power fades).</p>
      ) : (
        <ol class="rt-rules">
          {container.transitions.map((r, i) => {
            const mine = issuesOfRule(issues, i);
            const worst = worstSeverity(mine);
            const matches = from !== null && to !== null && ruleMatchesPair(r, from, to);
            return (
              <li
                key={i}
                data-rule={i}
                aria-current={sel === i}
                tabIndex={0}
                onClick={() => (editing.value = { key, index: i })}
                onKeyDown={(e) => { if (e.key === "Enter") editing.value = { key, index: i }; }}
                class={`${sel === i ? "rt-edit " : ""}${winner === i ? "rt-win" : ""}${matches && winner !== i ? " rt-beaten" : ""}${winsCell.has(i) ? "" : " rt-unused"}`}>
                <span class="rt-idx">#{i}</span> {r.from} to {r.to}
                <span class="rt-muted"> {typeof r.exit === "string" ? r.exit : `${r.exit.n} ${r.exit.every}s`}, {typeof r.enter === "string" ? r.enter : `cue:${r.enter.cue}`}{r.bridge ? `, bridge ${r.bridge.segment}` : ""}</span>
                {!winsChild.has(i) && <span class="rt-muted">{winsCell.has(i) ? " (wins no child pair; only * cells, so it applies to new children)" : " (wins no pair)"}</span>}
                {worst && <span class={`rt-badge ${worst}`} title={mine.map((x) => x.message).join("\n")}>{mine.length} {worst === "info" ? "note" : worst}{mine.length > 1 ? "s" : ""}</span>}
              </li>
            );
          })}
        </ol>
      )}
      {sel !== null && (
        <RuleEditor
          container={container}
          index={sel}
          issues={issuesOfRule(issues, sel)}
          readOnly={readOnly}
          apply={apply}
          onAudition={audition}
          auditionText={auditionText}
          auditionBlocked={plan && !plan.ok ? plan.reason : null}
        />
      )}
      {issues.some((x) => x.severity !== "info") && sel === null && (
        <>
          <h3>Lint</h3>
          <ul class="re-lint rule-editor" aria-label="Lint">
            {issues.filter((x) => x.severity !== "info").map((x, i) => <li key={i} class={x.severity} data-code={x.code}>Rule #{x.rule}: {x.message}</li>)}
          </ul>
        </>
      )}
    </div>
  );
}
