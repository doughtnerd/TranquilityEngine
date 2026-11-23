// The row editors of a clip's markers, events and curves (ADR 0373 "markers, events and curves on the source take"; T54):
// simple tables, one row per key, that hand the whole next list back to the card (`setMarkers`, `setEvents`, `setCurves` of
// `clipImportLogic.ts` validate it and may refuse it). Times are seconds into the clip.
import type { Curve } from "../../../../engine/core/curve";
import { MARKER_KINDS, type EventKey, type MarkerKey, type MarkerKind } from "../../../../engine/animation/tracks";
import { curveKey, newEvent, newMarker } from "./clipImportLogic";

const input = (e: Event) => e.currentTarget as HTMLInputElement;
const num = (e: Event, fallback: number): number => {
  const v = Number(input(e).value);
  return Number.isFinite(v) ? v : fallback;
};
const replaceAt = <T,>(list: readonly T[], i: number, next: T): T[] => list.map((x, k) => (k === i ? next : x));
const without = <T,>(list: readonly T[], i: number): T[] => list.filter((_, k) => k !== i);

/** An event's argument as the cell shows it: JSON for a list or object, else the text. */
const argsText = (args: unknown): string => (args === undefined ? "" : typeof args === "string" ? args : JSON.stringify(args));
/** The cell's text as an argument: JSON when it parses as an array or object, else the plain text, else none. */
function argsOf(text: string): unknown {
  const t = text.trim();
  if (t === "") return undefined;
  if (t.startsWith("[") || t.startsWith("{")) {
    try {
      return JSON.parse(t);
    } catch {
      // not JSON: kept as text
    }
  }
  return t;
}

interface RowsProps<T> {
  readonly rows: readonly T[];
  /** Where a new key goes by default: the playhead, seconds into the clip. */
  readonly at: number;
  readonly disabled: boolean;
  onChange(next: readonly T[]): void;
}

export function MarkerRows(props: RowsProps<MarkerKey>) {
  const { rows, disabled } = props;
  return (
    <div class="clip-rows" aria-label="Markers">
      {rows.length === 0 && <p class="skeleton-note">No markers. Sync markers line up clips in a blend; exit, hit and cue markers are read by the graph.</p>}
      {rows.map((m, i) => (
        <div class="clip-row" key={i}>
          <input type="number" step={0.01} min={0} aria-label={`Marker ${i + 1} time`} title="Seconds into the clip" disabled={disabled} value={m.time} onChange={(e) => props.onChange(replaceAt(rows, i, { ...m, time: num(e, m.time) }))} />
          <select aria-label={`Marker ${i + 1} kind`} disabled={disabled} value={m.kind} onChange={(e) => props.onChange(replaceAt(rows, i, { ...m, kind: (e.currentTarget as unknown as HTMLSelectElement).value as MarkerKind }))}>
            {MARKER_KINDS.map((k) => (
              <option key={k} value={k}>
                {k}
              </option>
            ))}
          </select>
          <input type="text" aria-label={`Marker ${i + 1} name`} placeholder="name" disabled={disabled} value={m.name ?? ""} onChange={(e) => props.onChange(replaceAt(rows, i, { time: m.time, kind: m.kind, ...(input(e).value ? { name: input(e).value } : {}) }))} />
          <button aria-label={`Remove marker ${i + 1}`} disabled={disabled} onClick={() => props.onChange(without(rows, i))}>
            ✕
          </button>
        </div>
      ))}
      <button disabled={disabled} onClick={() => props.onChange([...rows, newMarker(props.at)])}>
        Add Marker
      </button>
    </div>
  );
}

export function EventRows(props: RowsProps<EventKey>) {
  const { rows, disabled } = props;
  return (
    <div class="clip-rows" aria-label="Events">
      {rows.length === 0 && <p class="skeleton-note">No events. An event calls a method on the Animator's node when the clip passes its time.</p>}
      {rows.map((ev, i) => (
        <div class="clip-row" key={i}>
          <input type="number" step={0.01} min={0} aria-label={`Event ${i + 1} time`} title="Seconds into the clip" disabled={disabled} value={ev.time} onChange={(e) => props.onChange(replaceAt(rows, i, { ...ev, time: num(e, ev.time) }))} />
          <input type="text" aria-label={`Event ${i + 1} method`} placeholder="method" disabled={disabled} value={ev.method} onChange={(e) => props.onChange(replaceAt(rows, i, { ...ev, method: input(e).value }))} />
          <input
            type="text"
            aria-label={`Event ${i + 1} argument`}
            title="Text, or a JSON list or object"
            placeholder="argument"
            disabled={disabled}
            value={argsText(ev.args)}
            onChange={(e) => {
              const { args: _drop, ...rest } = ev;
              const args = argsOf(input(e).value);
              props.onChange(replaceAt(rows, i, args === undefined ? rest : { ...rest, args }));
            }}
          />
          <button aria-label={`Remove event ${i + 1}`} disabled={disabled} onClick={() => props.onChange(without(rows, i))}>
            ✕
          </button>
        </div>
      ))}
      <button disabled={disabled} onClick={() => props.onChange([...rows, newEvent(props.at, "OnEvent")])}>
        Add Event
      </button>
    </div>
  );
}

/** A named curve of a clip. */
export interface NamedCurve {
  readonly name: string;
  readonly curve: Curve;
}

export function CurveRows(props: RowsProps<NamedCurve>) {
  const { rows, disabled } = props;
  const names = rows.map((r) => r.name);
  const fresh = (() => {
    for (let n = 1; ; n++) if (!names.includes(`Curve ${n}`)) return `Curve ${n}`;
  })();
  return (
    <div class="clip-rows" aria-label="Curves">
      {rows.length === 0 && <p class="skeleton-note">No curves. A curve is a named value over the clip's time that the graph reads (a foot-IK weight).</p>}
      {rows.map((c, i) => (
        <div class="clip-curve" key={i}>
          <div class="clip-row">
            <input type="text" aria-label={`Curve ${i + 1} name`} disabled={disabled} value={c.name} onChange={(e) => props.onChange(replaceAt(rows, i, { ...c, name: input(e).value }))} />
            <button aria-label={`Remove curve ${c.name}`} disabled={disabled} onClick={() => props.onChange(without(rows, i))}>
              ✕
            </button>
          </div>
          {c.curve.map((k, n) => (
            <div class="clip-row" key={n}>
              <input type="number" step={0.01} min={0} aria-label={`${c.name} key ${n + 1} time`} title="Seconds into the clip" disabled={disabled} value={k[0]} onChange={(e) => props.onChange(replaceAt(rows, i, { ...c, curve: replaceAt(c.curve, n, curveKey(num(e, k[0]), k[1])) }))} />
              <input type="number" step={0.01} aria-label={`${c.name} key ${n + 1} value`} disabled={disabled} value={k[1]} onChange={(e) => props.onChange(replaceAt(rows, i, { ...c, curve: replaceAt(c.curve, n, curveKey(k[0], num(e, k[1]))) }))} />
              <button aria-label={`Remove key ${n + 1} of ${c.name}`} disabled={disabled} onClick={() => props.onChange(replaceAt(rows, i, { ...c, curve: without(c.curve, n) }))}>
                ✕
              </button>
            </div>
          ))}
          <button disabled={disabled} onClick={() => props.onChange(replaceAt(rows, i, { ...c, curve: [...c.curve, curveKey(props.at, c.curve.length ? c.curve[c.curve.length - 1][1] : 0)] }))}>
            Add Key to {c.name}
          </button>
        </div>
      ))}
      <button disabled={disabled} onClick={() => props.onChange([...rows, { name: fresh, curve: [curveKey(0, 0)] }])}>
        Add Curve
      </button>
    </div>
  );
}
