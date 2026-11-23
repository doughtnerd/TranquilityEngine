// The live parameter panel (ADR 0373 "the parameter panel is live and editable"; T52): each graph parameter with the
// value the running Animator holds, updated every frame, and an editor that sets it in the game (`Animator.set`). A
// refused edit (not a number, a fraction for an int) says why beside the field. Requests show their remaining lifetime.
import { useState } from "preact/hooks";
import { valueText, type LiveParameterRow } from "./liveParameterLogic";
import type { LiveRequest } from "./overlayLogic";

export interface LiveParametersProps {
  rows: readonly LiveParameterRow[];
  /** Sends an edit; returns why it was refused, or null. */
  onSet(name: string, input: string | boolean | readonly number[]): string | null;
  /** Requests the graph's conditions read, with their lifetimes (omitted: none shown). */
  requests?: readonly LiveRequest[];
  /** A recorded frame is shown: the values are that frame's and editing is off. */
  past?: boolean;
}

function Editor(props: { row: LiveParameterRow; disabled: boolean; set(input: string | boolean | readonly number[]): void }) {
  const { row } = props;
  const label = `${row.name} live value`;
  const [draft, setDraft] = useState<string | null>(null);
  if (row.type === "node" || row.value === null) return <span class="dbg-muted">set from code</span>;
  if (row.type === "bool") return <input type="checkbox" aria-label={label} checked={row.value === true} disabled={props.disabled} onChange={(e) => props.set((e.currentTarget as HTMLInputElement).checked)} />;
  if (row.type === "float" || row.type === "int") {
    const shown = draft ?? valueText(row.value);
    return (
      <input type="text" inputMode="decimal" class="dbg-number" aria-label={label} value={shown} disabled={props.disabled}
        onFocus={() => setDraft(valueText(row.value))} onInput={(e) => setDraft((e.currentTarget as HTMLInputElement).value)}
        onBlur={() => setDraft(null)}
        onKeyDown={(e) => {
          if (e.key === "Enter") props.set((e.currentTarget as HTMLInputElement).value);
          else if (e.key === "Escape") (e.currentTarget as HTMLInputElement).blur();
        }} />
    );
  }
  const v = row.value as readonly number[];
  return (
    <span class="dbg-vec">
      {v.map((c, k) => (
        <input key={k} type="number" step="any" class="dbg-number" aria-label={`${label} ${"xyzw"[k]}`} value={Number(c.toFixed(3))} disabled={props.disabled}
          onChange={(e) => { const n = (e.currentTarget as HTMLInputElement).valueAsNumber; props.set(v.map((x, j) => (j === k ? n : x))); }} />
      ))}
    </span>
  );
}

export function LiveParameters(props: LiveParametersProps) {
  const [refusals, setRefusals] = useState<ReadonlyMap<string, string>>(new Map());
  const set = (name: string, input: string | boolean | readonly number[]) => {
    const why = props.onSet(name, input);
    const next = new Map(refusals);
    if (why) next.set(name, why);
    else next.delete(name);
    setRefusals(next);
  };
  return (
    <section class="dbg-params" aria-label="Live parameters">
      <h4 class="dbg-head">Live parameters{props.past && <span class="dbg-muted"> · recorded frame</span>}</h4>
      {props.rows.length === 0 && <p class="dbg-muted">The graph has no parameters.</p>}
      <ul class="dbg-rows">
        {props.rows.map((row) => (
          <li key={row.name} class={`dbg-row${row.set ? " set" : ""}`}>
            <span class="dbg-name" title={row.computed ? "Computed by anim.compute each frame: an edit lasts one frame" : row.set ? "Set by code" : "The graph's default (not set yet)"}>{row.name}</span>
            <span class="dbg-type">{row.type}</span>
            <Editor row={row} disabled={props.past === true} set={(input) => set(row.name, input)} />
            {refusals.get(row.name) && <span class="dbg-refused" role="alert">{refusals.get(row.name)}</span>}
          </li>
        ))}
      </ul>
      {props.requests && props.requests.length > 0 && (
        <>
          <h4 class="dbg-head">Requests</h4>
          <ul class="dbg-rows" aria-label="Requests">
            {props.requests.map((r) => (
              <li key={r.name} class={`dbg-row${r.life > 0 ? " set" : ""}`} aria-label={`Request ${r.name}: ${r.life > 0 ? `${r.life.toFixed(2)} s left` : "not live"}`}>
                <span class="dbg-name">{r.name}</span>
                <span class="dbg-life"><span class="dbg-life-fill" style={{ width: `${Math.min(1, r.life) * 100}%` }} /></span>
                <span class="dbg-muted">{r.life > 0 ? `${r.life.toFixed(2)} s` : "not live"}</span>
              </li>
            ))}
          </ul>
        </>
      )}
    </section>
  );
}
