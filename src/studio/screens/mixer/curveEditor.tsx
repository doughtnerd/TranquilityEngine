// The Mixer's one door to the curve editor (ADR 0332 "one curve editor"; the prototype's CurveDialog): automation of a
// bus's level, a send or any effect parameter opens here, through `openCurveEditor(request)`. The shared curve editor
// is being built by another task; until it merges this is a minimal stand-in that edits the same request: one lane per
// automatable property, its game parameter, its keys as (parameter value, value) pairs, and Bypass. When the shared
// editor lands, only this file changes: map the request onto it and keep `onApply`'s contract.
import { signal } from "@preact/signals";
import { useEffect, useRef, useState } from "preact/hooks";
import { isLabelled, parameterRange, type ParameterDef } from "../../../engine/audio/eventFormat";
import type { Curve, CurveKey } from "../../../engine/core/curve";

/** One automatable property in a request. */
export interface CurveLane {
  /** The automation target (`volume`, `send:Reverb`, `fx:fx1:cutoff`). */
  readonly target: string;
  readonly label: string;
  /** Its value range and unit ("dB", "Hz"); log for frequencies. */
  readonly min: number;
  readonly max: number;
  readonly unit: string;
  readonly scale?: "linear" | "log";
  /** Its value without automation (where a new curve starts flat). */
  readonly plain: number;
  /** The lane as it is (null: not automated yet). */
  readonly current: { readonly parameter: string; readonly curve: Curve; readonly bypass: boolean } | null;
}

export interface CurveEditorRequest {
  /** "Automate Music" */
  readonly title: string;
  readonly lanes: readonly CurveLane[];
  readonly parameters: readonly ParameterDef[];
  /**
   * Apply: each lane's result (null removes the lane). A lane left without keys keeps what it had; a flat curve that
   * isn't bypassed is removed by the caller's edit (a flat curve is just the plain value).
   */
  onApply(lanes: readonly { readonly target: string; readonly lane: { parameter: string; curve: Curve; bypass: boolean } | null }[]): void;
}

const open = signal<CurveEditorRequest | null>(null);

/** Open the curve editor on `request` (one at a time; a second replaces the first). */
export function openCurveEditor(request: CurveEditorRequest): void {
  open.value = request;
}

interface DraftLane {
  target: string;
  parameter: string;
  keys: [number, number][];
  bypass: boolean;
  remove: boolean;
}

const draftOf = (lane: CurveLane, params: readonly ParameterDef[]): DraftLane => {
  const parameter = lane.current?.parameter ?? params[0]?.name ?? "";
  const def = params.find((p) => p.name === parameter);
  const [lo, hi] = def ? parameterRange(def) : [0, 1];
  return {
    target: lane.target,
    parameter,
    keys: lane.current ? lane.current.curve.map((k) => [k[0], k[1]] as [number, number]) : [[lo, lane.plain], [hi, lane.plain]],
    bypass: lane.current?.bypass ?? false,
    remove: false,
  };
};

/** The stand-in dialog; mounted once by the Mixer screen. */
export function CurveEditorHost() {
  const request = open.value;
  if (!request) return null;
  return <CurveEditorDialog request={request} onClose={() => (open.value = null)} />;
}

export function CurveEditorDialog(props: { request: CurveEditorRequest; onClose(): void }) {
  const { request, onClose } = props;
  const [lanes, setLanes] = useState<DraftLane[]>(() => request.lanes.map((l) => draftOf(l, request.parameters)));
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => ref.current?.querySelector<HTMLElement>("select, input, button")?.focus(), []);
  const set = (i: number, patch: Partial<DraftLane>) => setLanes(lanes.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const apply = () => {
    request.onApply(lanes.map((l, i) => {
      const was = request.lanes[i]!.current;
      if (l.remove) return { target: l.target, lane: null };
      if (l.keys.length === 0) return { target: l.target, lane: was ? { parameter: was.parameter, curve: was.curve, bypass: was.bypass } : null };
      const curve: CurveKey[] = [...l.keys].sort((a, b) => a[0] - b[0]).map(([x, y]) => [x, y]);
      return { target: l.target, lane: { parameter: l.parameter, curve, bypass: l.bypass } };
    }));
    onClose();
  };
  return (
    <div class="mx-modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div ref={ref} class="mx-modal mx-curves" role="dialog" aria-modal="true" aria-label={request.title} onKeyDown={(e) => { if (e.key === "Escape") { e.stopPropagation(); onClose(); } }}>
        <h2 class="mx-modal-title">{request.title}</h2>
        <p class="mx-note">Keys map a game parameter's value to the property's value; between keys the value follows a straight line. (The full curve editor replaces this window.)</p>
        {lanes.map((l, i) => {
          const spec = request.lanes[i]!;
          const def = request.parameters.find((p) => p.name === l.parameter);
          return (
            <fieldset key={l.target} class="mx-curve-lane" disabled={l.remove}>
              <legend>{spec.label} <span class="mx-faint">({spec.unit || "value"} {spec.min}..{spec.max})</span></legend>
              <label class="mx-field">
                <span>Driven by</span>
                <select value={l.parameter} onChange={(e) => set(i, { parameter: (e.target as HTMLSelectElement).value })} aria-label={`${spec.label}: game parameter`}>
                  {request.parameters.map((p) => <option key={p.name} value={p.name}>{p.name}{isLabelled(p) ? " (labels)" : ""}</option>)}
                </select>
              </label>
              <table class="mx-keys">
                <thead><tr><th>{def ? l.parameter : "Parameter"}</th><th>{spec.label}</th><th /></tr></thead>
                <tbody>
                  {l.keys.map(([x, y], k) => (
                    <tr key={k}>
                      <td><input type="number" value={x} aria-label={`Key ${k + 1} parameter value`} onChange={(e) => set(i, { keys: l.keys.map((kk, j) => (j === k ? [Number((e.target as HTMLInputElement).value), kk[1]] : kk)) })} /></td>
                      <td><input type="number" value={y} min={spec.min} max={spec.max} aria-label={`Key ${k + 1} value`} onChange={(e) => set(i, { keys: l.keys.map((kk, j) => (j === k ? [kk[0], Math.min(spec.max, Math.max(spec.min, Number((e.target as HTMLInputElement).value)))] : kk)) })} /></td>
                      <td><button class="kit-icon-button" aria-label={`Remove key ${k + 1}`} onClick={() => set(i, { keys: l.keys.filter((_, j) => j !== k) })}>×</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <div class="mx-row-tools">
                <button onClick={() => set(i, { keys: [...l.keys, [l.keys.at(-1)?.[0] ?? 0, l.keys.at(-1)?.[1] ?? spec.plain]] })}>+ Key</button>
                <label><input type="checkbox" checked={l.bypass} onChange={(e) => set(i, { bypass: (e.target as HTMLInputElement).checked })} /> Bypass</label>
                {spec.current && <button class="danger" onClick={() => set(i, { remove: true })}>Remove automation</button>}
              </div>
            </fieldset>
          );
        })}
        <div class="mx-modal-buttons">
          <button onClick={onClose}>Cancel</button>
          <button class="primary" onClick={apply}>Apply</button>
        </div>
      </div>
    </div>
  );
}
