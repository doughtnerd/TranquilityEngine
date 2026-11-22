// A value lane (ADR 0335 `ValueLane`): a value over time as a line (a game parameter in a take; voices, CPU, a bus's
// gain or loudness in a capture), with a header naming it and its value at the cursor, and an optional dashed
// reference line (a voice limit, a loudness target). The lane takes a time → x function, so it lines up with the ruler
// above it. The colour is one of the series tokens (`--series-1..8`).
import { lanePolyline, formatValue, valueAt, valueRange, valueToY, type Interp, type ValuePoint } from "./valueLaneModel";
import type { TimeToX } from "./timeAxis";
import "./audioParts.css";

export interface ValueLaneProps {
  readonly points: readonly ValuePoint[];
  readonly toX: TimeToX;
  readonly width: number;
  /** The plot's height, px (default 40). */
  readonly height?: number;
  /** The lane's name ("Speed"). */
  readonly label: string;
  readonly unit?: string;
  readonly decimals?: number;
  readonly interp?: Interp;
  /** A fixed vertical range; default the points' (and reference line's) extent. */
  readonly range?: readonly [number, number];
  /** A dashed line at a value ("voice limit 32"). */
  readonly reference?: { readonly value: number; readonly label: string } | null;
  /** The time whose value the header shows (the playhead), seconds. */
  readonly cursor?: number | null;
  /** Which `--series-N` colour (default 1). */
  readonly series?: 1 | 2 | 3 | 4 | 5 | 6 | 7 | 8;
}

export function ValueLane(props: ValueLaneProps) {
  const height = props.height ?? 40;
  const interp = props.interp ?? "linear";
  const range = valueRange(props.points, props.range, props.reference?.value);
  const now = props.cursor != null ? valueAt(props.points, props.cursor, interp) : null;
  const header = formatValue(now, props.unit, props.decimals ?? 2);
  const refY = props.reference ? valueToY(props.reference.value, range, height) : null;
  return (
    <div class={`studio-valuelane studio-series-${props.series ?? 1}`} role="group" aria-label={`${props.label}${props.cursor != null ? `: ${header}` : ""}`}>
      <div class="studio-valuelane-head">
        <span class="studio-valuelane-name">{props.label}</span>
        {props.cursor != null && <span class="studio-valuelane-value">{header}</span>}
      </div>
      <svg class="studio-valuelane-plot" width={props.width} height={height} viewBox={`0 0 ${props.width} ${height}`} aria-hidden="true">
        {refY !== null && (
          <>
            <line class="studio-valuelane-ref" x1={0} x2={props.width} y1={refY} y2={refY} />
            <text class="studio-valuelane-reflabel" x={props.width - 4} y={Math.max(9, refY - 3)} text-anchor="end">
              {props.reference!.label}
            </text>
          </>
        )}
        <polyline class="studio-valuelane-line" points={lanePolyline(props.points, props.toX, range, props.width, height, interp)} />
        {props.cursor != null && now !== null && <circle class="studio-valuelane-dot" cx={props.toX(props.cursor)} cy={valueToY(now, range, height)} r={2.5} />}
      </svg>
    </div>
  );
}
