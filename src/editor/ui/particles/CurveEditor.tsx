import { useRef, useState } from "preact/hooks";
import { evalCurve, type CurveKey } from "../../../engine/scene/particles";
import { addKey, curveRange, moveKey, removeKey } from "../../particles/curveEdit";
import { NumField } from "./valueInputs";
import "./particles.css";

const W = 200;
const H = 80;
const PAD = 6;

const round = (n: number) => Math.round(n * 1000) / 1000;

/**
 * A particle curve (ADR 0057) as a small SVG graph: linear between keys, the way `evalCurve` reads
 * it. Drag a key to move it, double-click empty space to add one, double-click or right-click a key
 * (or select it and press Delete) to remove it. `min`/`max` fix the value range; without them it
 * fits the keys.
 */
export function CurveEditor(props: { keys: CurveKey[]; onChange: (keys: CurveKey[]) => void; label: string; min?: number; max?: number; readOnly?: boolean }) {
  const { keys, onChange, label, readOnly } = props;
  const [selected, setSelected] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  // The value range is held still while a key is dragged, so the graph doesn't rescale under the pointer.
  const frozen = useRef<[number, number] | null>(null);
  const drag = useRef<number | null>(null);
  const [lo, hi] = frozen.current ?? curveRange(keys, props.min, props.max);
  const x = (t: number) => PAD + t * (W - 2 * PAD);
  const y = (v: number) => H - PAD - ((v - lo) / (hi - lo)) * (H - 2 * PAD);
  const sel = selected !== null && selected < keys.length ? selected : null;

  /** The curve coordinates of a pointer event. */
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W;
    const py = ((e.clientY - r.top) / r.height) * H;
    const t = Math.min(1, Math.max(0, (px - PAD) / (W - 2 * PAD)));
    let v = lo + ((H - PAD - py) / (H - 2 * PAD)) * (hi - lo);
    if (props.min !== undefined) v = Math.max(props.min, v);
    if (props.max !== undefined) v = Math.min(props.max, v);
    return [round(t), round(v)];
  };
  const remove = (i: number) => {
    if (readOnly || keys.length <= 1) return;
    onChange(removeKey(keys, i));
    setSelected(null);
  };
  const points = keys.length ? [[0, keys[0][1]] as CurveKey, ...keys, [1, keys[keys.length - 1][1]] as CurveKey].map(([t, v]) => `${x(t)},${y(v)}`).join(" ") : "";
  const zero = lo < 0 && hi > 0 ? y(0) : null;

  return (
    <div class="curve-editor" aria-label={label}>
      <svg
        ref={svg}
        class="curve-svg"
        viewBox={`0 0 ${W} ${H}`}
        role="group"
        aria-label={`${label} curve`}
        tabIndex={0}
        onKeyDown={(e) => {
          if ((e.key === "Delete" || e.key === "Backspace") && sel !== null) {
            e.preventDefault();
            remove(sel);
          }
        }}
        onDblClick={(e) => {
          if (readOnly) return;
          const [t, v] = at(e);
          const added = addKey(keys, t, v);
          onChange(added.keys);
          setSelected(added.index);
        }}
      >
        <rect class="curve-bg" x={0} y={0} width={W} height={H} />
        {[0.25, 0.5, 0.75].map((t) => (
          <line key={t} class="curve-grid" x1={x(t)} y1={PAD} x2={x(t)} y2={H - PAD} />
        ))}
        {zero !== null && <line class="curve-zero" x1={PAD} y1={zero} x2={W - PAD} y2={zero} />}
        <polyline class="curve-line" points={points} />
        {keys.map(([t, v], i) => (
          <circle
            key={i}
            class={`curve-key${i === sel ? " selected" : ""}`}
            data-key={i}
            cx={x(t)}
            cy={y(v)}
            r={4}
            onPointerDown={(e) => {
              e.stopPropagation();
              setSelected(i);
              svg.current?.focus();
              if (readOnly) return;
              (e.currentTarget as SVGCircleElement).setPointerCapture(e.pointerId);
              drag.current = i;
              frozen.current = [lo, hi];
            }}
            onPointerMove={(e) => {
              if (drag.current !== i) return;
              const [nt, nv] = at(e);
              onChange(moveKey(keys, i, nt, nv));
            }}
            onPointerUp={() => {
              drag.current = null;
              frozen.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
              frozen.current = null;
            }}
            onDblClick={(e) => {
              e.stopPropagation();
              remove(i);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              remove(i);
            }}
          />
        ))}
        <text class="curve-label" x={PAD + 2} y={PAD + 6}>
          {round(hi)}
        </text>
        <text class="curve-label" x={PAD + 2} y={H - PAD - 2}>
          {round(lo)}
        </text>
      </svg>
      <div class="curve-readout">
        {sel !== null ? (
          <>
            <label>
              <em>t</em>
              <NumField value={keys[sel][0]} label={`${label} key time`} disabled={readOnly} onCommit={(t) => onChange(moveKey(keys, sel, t, keys[sel][1]))} />
            </label>
            <label>
              <em>value</em>
              <NumField
                value={keys[sel][1]}
                label={`${label} key value`}
                disabled={readOnly}
                onCommit={(v) => onChange(moveKey(keys, sel, keys[sel][0], Math.min(props.max ?? Infinity, Math.max(props.min ?? -Infinity, v))))}
              />
            </label>
            <button type="button" class="pe-mini" aria-label={`${label} remove key`} disabled={readOnly || keys.length <= 1} onClick={() => remove(sel)}>
              Remove
            </button>
          </>
        ) : (
          <span class="curve-hint">Double-click to add a key</span>
        )}
      </div>
    </div>
  );
}

/** A read-only sparkline of a curve, for when it is collapsed. */
export function CurvePreview(props: { keys: CurveKey[]; min?: number; max?: number }) {
  const { keys } = props;
  const [lo, hi] = curveRange(keys, props.min, props.max);
  const w = 60;
  const h = 18;
  const pts = Array.from({ length: 24 }, (_, i) => {
    const t = i / 23;
    return `${(t * w).toFixed(1)},${(h - 2 - ((evalCurve(keys, t) - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`;
  }).join(" ");
  return (
    <svg class="curve-preview" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} />
    </svg>
  );
}
