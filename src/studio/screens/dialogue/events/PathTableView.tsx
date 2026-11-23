// The Events tab's path table (ADR 0355 §7): one column per argument (its name and its labels or linked global; move
// left and right reorders every path), a Lines column of weighted chips (each showing recorded or missing in the
// preview language), probability and, in weighted mode, weight. Each cell is a label menu with `*`. "Group by argument"
// shows the same table as a collapsible tree. Lints sit inline. An argument change (labels, remove, unlink, add, link)
// shows the paths it affects before it is applied. Rows take the test bench's highlight. A view over props.
import { useState } from "preact/hooks";
import { Chip } from "../../../../editor/ui/Chip";
import { SegmentedControl } from "../../../../editor/ui/SegmentedControl";
import { argumentName, WILDCARD, type DialogueEvent, type DialogueLine } from "../../../../engine/audio/dialogue/types";
import type { EditResult } from "../../../../editor/sdk/editResult";
import { codesOf } from "../languagesModel";
import { InlineText } from "../LinesView";
import { labelsChange, labelsOf, pathTree, type ArgumentChange, type ArgumentImpact, type EventContext, type PathLint, type PathNode } from "./eventsModel";
import type { BenchRow } from "./testBench";

export interface PathTableViewProps {
  readonly event: DialogueEvent;
  readonly ctx: EventContext;
  /** Global labelled parameters an argument can link to. */
  readonly parameters: readonly string[];
  readonly lints: readonly PathLint[];
  /** The test bench's rows, to highlight (null: no highlight). */
  readonly bench: readonly BenchRow[] | null;
  /** Line keys offered for chips, and whether each is recorded in the preview language. */
  readonly lineKeys: readonly string[];
  recorded(key: string): boolean;
  readonly preview: string;
  readonly readOnly?: boolean;
  /** What an argument change would do (for the preview before applying). */
  impactOf(change: ArgumentChange): EditResult<{ impact: ArgumentImpact }>;
  onArgument(change: ArgumentChange, label: string): void;
  onEntry(index: number, arg: number, value: string): void;
  onLines(index: number, lines: DialogueLine[]): void;
  onNumbers(index: number, patch: { probability?: number; weight?: number }): void;
  onAddPath(): void;
  onRemovePath(index: number): void;
}

const ROLE_TEXT: Record<BenchRow["role"], string> = { picked: "picked", silence: "silence", passed: "passed over", fallback: "fallback", unmatched: "" };

function Lines(props: { lines: readonly DialogueLine[]; keys: readonly string[]; recorded(key: string): boolean; preview: string; disabled?: boolean; index: number; onLines(lines: DialogueLine[]): void }) {
  const [adding, setAdding] = useState("");
  const listId = `dl-line-keys-${props.index}`;
  return (
    <div class="dl-chips">
      {props.lines.length === 0 && <span class="dl-muted" title="An explicit silence: nothing is said">silence</span>}
      {props.lines.map((l, i) => (
        <Chip key={l.key} tone={props.recorded(l.key) ? "neutral" : "warning"} title={`${l.key}: ${props.recorded(l.key) ? "recorded" : "missing"} in ${props.preview}`} removeLabel={`Remove ${l.key}`}
          onRemove={props.disabled ? undefined : () => props.onLines(props.lines.filter((_, j) => j !== i))}>
          {l.key}
          <input type="number" class="dl-chip-weight" aria-label={`Weight of ${l.key}`} min={0} max={100} step={1} value={l.weight} disabled={props.disabled}
            onChange={(e) => props.onLines(props.lines.map((x, j) => (j === i ? { ...x, weight: Number((e.currentTarget as HTMLInputElement).value) } : x)))} />
        </Chip>
      ))}
      {!props.disabled && (
        <>
          <input type="text" aria-label={`Add a line to path ${props.index + 1}`} placeholder="+ line" list={listId} value={adding} style={{ width: "90px" }}
            onInput={(e) => setAdding((e.currentTarget as HTMLInputElement).value)}
            onKeyDown={(e) => {
              if (e.key !== "Enter" || adding.trim() === "") return;
              props.onLines([...props.lines, { key: adding.trim(), weight: 1 }]);
              setAdding("");
            }} />
          <datalist id={listId}>{props.keys.map((k) => <option key={k} value={k} />)}</datalist>
        </>
      )}
    </div>
  );
}

function ArgumentHead(props: { event: DialogueEvent; ctx: EventContext; arg: number; disabled?: boolean; onChange(change: ArgumentChange): void }) {
  const a = props.event.arguments[props.arg];
  const labels = labelsOf(a, props.ctx);
  const n = props.event.arguments.length;
  return (
    <th scope="col">
      <div><b>{argumentName(a)}</b> {a.kind === "parameter" && <Chip tone="accent" title="A global labelled parameter (audio.json)">global</Chip>}</div>
      <div class="dl-muted" title={labels.join(", ")}>{labels.join(" · ") || "no labels"}</div>
      {!props.disabled && (
        <div class="dl-row">
          <button class="smp-link" aria-label={`Move ${argumentName(a)} left`} disabled={props.arg === 0} onClick={() => props.onChange({ kind: "move", arg: props.arg, to: props.arg - 1 })}>‹</button>
          <button class="smp-link" aria-label={`Move ${argumentName(a)} right`} disabled={props.arg === n - 1} onClick={() => props.onChange({ kind: "move", arg: props.arg, to: props.arg + 1 })}>›</button>
          {a.kind === "local" ? (
            <InlineText value={a.labels.join(", ")} label={`Labels of ${a.name}`} class="dl-labels" disabled={props.disabled} onCommit={(text) => props.onChange(labelsChange(props.arg, text))} />
          ) : (
            <button class="smp-link" onClick={() => props.onChange({ kind: "unlink", arg: props.arg })}>Unlink</button>
          )}
          <button class="smp-link" aria-label={`Remove argument ${argumentName(a)}`} onClick={() => props.onChange({ kind: "remove", arg: props.arg })}>×</button>
        </div>
      )}
    </th>
  );
}

function TreeNode(props: { node: PathNode; event: DialogueEvent; bench: readonly BenchRow[] | null }) {
  const n = props.node;
  const roles = n.paths.map((i) => props.bench?.[i]?.role).filter(Boolean);
  return (
    <li>
      <details open>
        <summary>
          <b>{n.label}</b> <span class="dl-muted">{argumentName(props.event.arguments[n.depth])}</span>
          {roles.includes("picked") && <Chip tone="accent">picked</Chip>}
        </summary>
        {n.children.length > 0 ? (
          <ul class="dl-tree">{n.children.map((c) => <TreeNode key={c.label} node={c} event={props.event} bench={props.bench} />)}</ul>
        ) : (
          <ul class="dl-tree">
            {n.paths.map((i) => {
              const p = props.event.paths[i];
              return <li key={i}>{p.lines.length === 0 ? <i>silence</i> : p.lines.map((l) => `${l.key}${l.weight !== 1 ? ` ×${l.weight}` : ""}`).join(", ")}{p.probability < 1 ? ` · ${Math.round(p.probability * 100)}%` : ""}</li>;
            })}
          </ul>
        )}
      </details>
    </li>
  );
}

export function PathTableView(props: PathTableViewProps) {
  const e = props.event;
  const [view, setView] = useState<"table" | "tree">("table");
  const [pending, setPending] = useState<{ change: ArgumentChange; label: string } | null>(null);
  const [newArg, setNewArg] = useState("");
  const ro = props.readOnly;
  const ask = (change: ArgumentChange) => {
    const label = change.kind === "move" ? "Reorder arguments" : change.kind === "remove" ? "Remove argument" : change.kind === "labels" ? "Edit labels" : change.kind === "unlink" ? "Unlink argument" : change.kind === "link" ? "Link global parameter" : change.kind === "add" ? "Add argument" : "Argument default";
    // Moves and additions touch every path the same way: applied at once. The rest show their impact first.
    if (change.kind === "move" || change.kind === "add" || change.kind === "link") return props.onArgument(change, label);
    setPending({ change, label });
  };
  const impact = pending ? props.impactOf(pending.change) : null;
  const lintsOf = (i: number) => props.lints.filter((l) => l.index === i);
  return (
    <div class="dl-paths-wrap">
      <div class="dl-toolbar">
        <SegmentedControl size="small" label="Path view" value={view} options={[{ value: "table", label: "Table" }, { value: "tree", label: "Group by argument" }]} onChange={setView} />
        <button disabled={ro || e.arguments.length === 0} onClick={props.onAddPath}>Add path</button>
        {!ro && (
          <>
            <input type="text" aria-label="New argument" placeholder="name: A, B" value={newArg} style={{ width: "140px" }} onInput={(ev) => setNewArg((ev.currentTarget as HTMLInputElement).value)} />
            <button disabled={!newArg.includes(":")} onClick={() => { const [name, rest] = newArg.split(":"); ask({ kind: "add", name, labels: codesOf(rest ?? "") }); setNewArg(""); }}>Add argument</button>
            {props.parameters.length > 0 && (
              <select aria-label="Link a global parameter" value="" onChange={(ev) => { const v = (ev.currentTarget as HTMLSelectElement).value; if (v) ask({ kind: "link", parameter: v }); }}>
                <option value="">Link global…</option>
                {props.parameters.map((p) => <option key={p} value={p}>{p}</option>)}
              </select>
            )}
          </>
        )}
      </div>
      {props.lints.filter((l) => l.index < 0).map((l) => <p key={l.message} class="dl-lint">{l.message}</p>)}
      {pending && impact && (
        <section class="dl-impact" aria-label="Argument change">
          <b>{pending.label}</b>
          {"refused" in impact ? <p class="dl-warn">{impact.refused}</p> : impact.next.impact.removed.length + impact.next.impact.rewritten.length === 0 ? <p class="dl-note">No path changes.</p> : (
            <ul class="dl-list" aria-label="Affected paths">
              {impact.next.impact.removed.map((r) => <li key={`r${r.index}`}>Path {r.index + 1} ({e.paths[r.index].path.join(" · ")}) is removed: {r.why}</li>)}
              {impact.next.impact.rewritten.map((r) => <li key={`w${r.index}`}>Path {r.index + 1} becomes {r.to.join(" · ")}</li>)}
            </ul>
          )}
          <div class="dl-row">
            <button class="primary" disabled={"refused" in impact} onClick={() => { props.onArgument(pending.change, pending.label); setPending(null); }}>Apply</button>
            <button onClick={() => setPending(null)}>Cancel</button>
          </div>
        </section>
      )}
      {view === "tree" ? (
        <ul class="dl-tree" aria-label="Paths by argument" style={{ paddingLeft: 0 }}>
          {pathTree(e, props.ctx).map((n) => <TreeNode key={n.label} node={n} event={e} bench={props.bench} />)}
        </ul>
      ) : (
        <table class="dl-table dl-paths" aria-label="Paths">
          <thead>
            <tr>
              <th scope="col">#</th>
              {e.arguments.map((_, i) => <ArgumentHead key={i} event={e} ctx={props.ctx} arg={i} disabled={ro} onChange={ask} />)}
              <th scope="col">Lines</th>
              <th scope="col">Probability</th>
              {e.mode === "weighted" && <th scope="col">Weight</th>}
              <th scope="col" />
            </tr>
          </thead>
          <tbody>
            {e.paths.length === 0 && <tr><td colSpan={4 + e.arguments.length} class="dl-muted">{e.arguments.length === 0 ? "Add an argument, then paths." : "No paths: the event says nothing."}</td></tr>}
            {e.paths.map((p, i) => {
              const b = props.bench?.[i] ?? null;
              return (
                <tr key={i} class={b?.role} aria-label={`Path ${i + 1}: ${p.path.join(" · ")}${b && b.role !== "unmatched" ? ` (${ROLE_TEXT[b.role]})` : ""}`}>
                  <td title={b?.reason}>{i + 1}{b?.rank ? <span class="dl-from">#{b.rank}</span> : null}</td>
                  {p.path.map((v, a) => (
                    <td key={a}>
                      <select aria-label={`Path ${i + 1} ${argumentName(e.arguments[a])}`} value={v} disabled={ro} onChange={(ev) => props.onEntry(i, a, (ev.currentTarget as HTMLSelectElement).value)}>
                        <option value={WILDCARD}>*</option>
                        {labelsOf(e.arguments[a], props.ctx).map((l) => <option key={l} value={l}>{l}</option>)}
                        {v !== WILDCARD && !labelsOf(e.arguments[a], props.ctx).includes(v) && <option value={v}>{v} (unknown)</option>}
                      </select>
                    </td>
                  ))}
                  <td>
                    <Lines lines={p.lines} keys={props.lineKeys} recorded={props.recorded} preview={props.preview} disabled={ro} index={i} onLines={(lines) => props.onLines(i, lines)} />
                    {lintsOf(i).map((l) => <div key={l.message} class="dl-lint">{l.message}</div>)}
                    {b && b.reason && b.role !== "picked" && <div class="dl-muted">{b.reason}</div>}
                  </td>
                  <td><input type="number" aria-label={`Probability of path ${i + 1}`} min={0} max={100} step={5} style={{ width: "56px" }} value={Math.round(p.probability * 100)} disabled={ro} onChange={(ev) => props.onNumbers(i, { probability: Number((ev.currentTarget as HTMLInputElement).value) / 100 })} />%</td>
                  {e.mode === "weighted" && <td><input type="number" aria-label={`Weight of path ${i + 1}`} min={0} max={100} step={1} style={{ width: "48px" }} value={p.weight} disabled={ro} onChange={(ev) => props.onNumbers(i, { weight: Number((ev.currentTarget as HTMLInputElement).value) })} /></td>}
                  <td><button class="smp-link" aria-label={`Remove path ${i + 1}`} disabled={ro} onClick={() => props.onRemovePath(i)}>×</button></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
    </div>
  );
}
