// Ed6 (api-and-models §7, contract H6): the rules table of a music container: a from-by-to grid over the container's
// direct children plus `*`, every cell showing the rule that wins the pair (the same answer R1 gives at run time, read
// through `rulesModel.ts`), the chosen cell's rule highlighted in the rule list, and a "why" readout of tier and index.
// Ed7 adds beside it: the rule editor (`RuleEditor.tsx`), the lint rows and badges (`ruleLint.ts`) and "audition this
// transition" (`ruleAudition.ts`, through Ed5's shared transport).
import { signal } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import { isMusicContainer, type MusicContainerNode, type MusicNode } from "../../../../engine/audio/musicFormat";
import { buildRulesGrid, explainPair, replaceContainer, ruleMatchesPair } from "./rulesModel";
import { openRules } from "./index";
import { peaksFor } from "./peaksHost";
import { addRule, duplicateRule, moveRule, removeRule, RuleEditor, type RuleEdit } from "./RuleEditor";
import { issuesOfRule, leafSegments, lintTransitionRules, worstSeverity } from "./ruleLint";
import { planTransitionAudition, runTransitionAudition } from "./ruleAudition";
import { musicTransport } from "./transportHost";
import "./rulesTable.css";
import "./ruleEditor.css";

/** The pair chosen in the grid, per container (`event` + `nodeId`); a pair that no longer exists is ignored. */
const chosen = signal<{ readonly key: string; readonly from: string; readonly to: string } | null>(null);

/** The music container `id` anywhere under `root`, or null. */
function findContainer(root: MusicNode | undefined, id: string): MusicContainerNode | null {
  if (!root || !isMusicContainer(root)) return null;
  if (root.id === id) return root;
  for (const child of root.children) {
    const hit = findContainer(child, id);
    if (hit) return hit;
  }
  return null;
}

/** The rule being edited, per container (`event#nodeId`). */
const editing = signal<{ readonly key: string; readonly index: number } | null>(null);

export function RulesTable() {
  const open = openRules.value;
  const project = editor.project.current;
  editor.project.version;
  if (!project || !open) return <p class="empty">Rules: open a playlist or music switch from the Event editor to see its transition rules here.</p>;
  if (!project.files.includes(open.event)) return <p class="empty">{open.event} isn't in the project any more.</p>;
  return <OpenRules key={`${open.event}#${open.nodeId}`} path={open.event} nodeId={open.nodeId} />;
}

function OpenRules(props: { path: string; nodeId: string }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<AudioEventAsset>(project, props.path, "audioEvent");
  const event = doc.value.value;
  const container = useMemo(() => findContainer(event.musicRoot, props.nodeId), [event.musicRoot, props.nodeId]);
  const grid = useMemo(() => (container ? buildRulesGrid(container) : null), [container]);
  const peaks = peaksFor(project);
  const [version, setVersion] = useState(0);
  const [auditionText, setAuditionText] = useState<string | null>(null);
  const clips = useMemo(() => (container ? [...container.children, ...container.library].flatMap(leafSegments).map((s) => s.tracks[0]?.clip ?? "").filter((c) => c !== "") : []), [container]);
  useEffect(() => {
    let live = true;
    for (const c of clips) if (!peaks.peek(c)) peaks.get(c).then(() => live && setVersion((v) => v + 1), () => {});
    return () => void (live = false);
  }, [clips.join("\n")]);
  // The panel keeps the shared transport ticking while an audition it started plays (the seek retry, the queued parameter).
  useEffect(() => {
    const t = setInterval(() => musicTransport.tick(), 50);
    return () => clearInterval(t);
  }, []);
  if (!container || !grid) return <p class="empty">{props.path} has no playlist or music switch “{props.nodeId}”.</p>;

  const key = `${props.path}#${props.nodeId}`;
  const pick = chosen.value && chosen.value.key === key ? chosen.value : null;
  const ids = new Set(grid.rows.map((h) => h.id));
  const from = pick && ids.has(pick.from) ? pick.from : null;
  const to = pick && ids.has(pick.to) ? pick.to : null;
  const readout = from !== null && to !== null ? explainPair(container, from, to) : null;
  const winner = readout ? readout.rule : null;
  const winsCell = new Set(grid.cells.flat().map((c) => c.rule));
  const winsChild = new Set(grid.effective);

  void version;
  const lengthOf = (id: string): number | undefined => {
    const seg = [...container.children, ...container.library].flatMap(leafSegments).find((s) => s.id === id);
    const clip = seg?.tracks[0]?.clip;
    const m = clip ? peaks.peek(clip) : undefined;
    return m && m.rate > 0 ? m.frames / m.rate : undefined;
  };
  const issues = lintTransitionRules(container, { lengthOf });
  const sel = editing.value && editing.value.key === key && editing.value.index < container.transitions.length ? editing.value.index : null;
  const readOnly = doc.readOnly;
  const apply = (edit: RuleEdit, label: string): boolean => {
    if ("error" in edit) return false;
    if (event.musicRoot) doc.edit({ ...event, musicRoot: replaceContainer(event.musicRoot, container.id, edit.container) }, { label });
    return true;
  };
  const tool = (edit: RuleEdit, label: string, select?: number): void => {
    if (apply(edit, label) && select !== undefined) editing.value = select < 0 ? null : { key, index: select };
  };
  const plan = sel === null ? null : planTransitionAudition(props.path, event, container, sel, from !== null && to !== null ? { pair: { from, to } } : {});
  const audition = (bar: number | undefined): void => {
    if (sel === null) return;
    const p = planTransitionAudition(props.path, event, container, sel, { ...(from !== null && to !== null ? { pair: { from, to } } : {}), ...(bar !== undefined ? { bar } : {}) });
    if (!p.ok) return void setAuditionText(p.reason);
    setAuditionText(p.note);
    void runTransitionAudition(musicTransport, p);
  };

  return (
    <div class="rules-table" data-asset-document={props.path}>
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
