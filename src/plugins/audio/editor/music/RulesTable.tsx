// Ed6 (api-and-models §7, contract H6): the rules table of a music container: a from-by-to grid over the container's
// direct children plus `*`, every cell showing the rule that wins the pair (the same answer R1 gives at run time, read
// through `rulesModel.ts`), the chosen cell's rule highlighted in the rule list, and a "why" readout of tier and index.
// Read-only here; Ed7 adds the rule editor, lint and audition beside it.
import { signal } from "@preact/signals";
import { useMemo } from "preact/hooks";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import { isMusicContainer, type MusicContainerNode, type MusicNode } from "../../../../engine/audio/musicFormat";
import { buildRulesGrid, explainPair, ruleMatchesPair } from "./rulesModel";
import { openRules } from "./index";
import "./rulesTable.css";

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

  return (
    <div class="rules-table">
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
      {container.transitions.length === 0 ? (
        <p class="rt-muted">No rules: every change uses the default rule (bar exit, entry cue, 1 beat equal-power fades).</p>
      ) : (
        <ol class="rt-rules">
          {container.transitions.map((r, i) => {
            const matches = from !== null && to !== null && ruleMatchesPair(r, from, to);
            return (
              <li key={i} class={`${winner === i ? "rt-win" : ""}${matches && winner !== i ? " rt-beaten" : ""}${winsCell.has(i) ? "" : " rt-unused"}`}>
                <span class="rt-idx">#{i}</span> {r.from} to {r.to}
                <span class="rt-muted"> {typeof r.exit === "string" ? r.exit : `${r.exit.n} ${r.exit.every}s`}, {typeof r.enter === "string" ? r.enter : `cue:${r.enter.cue}`}{r.bridge ? `, bridge ${r.bridge.segment}` : ""}</span>
                {!winsChild.has(i) && <span class="rt-muted">{winsCell.has(i) ? " (wins no child pair; only * cells, so it applies to new children)" : " (wins no pair)"}</span>}
              </li>
            );
          })}
        </ol>
      )}
    </div>
  );
}
