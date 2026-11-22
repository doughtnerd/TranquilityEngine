import { useEffect, useRef, useState } from "preact/hooks";
import { evalCurve, type Curve, type CurveInterp } from "../../engine/core/curve";
import { addKey, axisTicks, fitYRange, moveKey, pixelToX, pixelToY, removeKey, setKeyInterp, xToPixel, yToPixel } from "./curveEdit";
import "./curveEditor.css";

/**
 * The props contract (C5, ADR 0158 §7). The first five are the contract; the rest are what the particle inspector
 * needs (its curves are valid `Curve`s with x in 0..1: `xRange` [0, 1], `interpolation` false, `fitY` true).
 */
export interface CurveEditorProps {
  curve: Curve;
  onChange(curve: Curve): void;
  /** The x values the graph spans; keys can't leave it. Any finite range, say [0, 1] or [0, 30]. */
  xRange: [number, number];
  /** Bounds for key values. The graph shows exactly this range unless `fitY` is set. Use `-Infinity`/`Infinity` for no bound. */
  yRange: [number, number];
  /** Show the per-segment interpolation control (a key's `interp` shapes the segment to the next key). */
  interpolation: boolean;
  /** Names the widget for assistive tech and the field labels. */
  label: string;
  readOnly?: boolean;
  /** The graph's y range fits the keys (with padding, pinned by finite `yRange` ends) instead of showing `yRange` whole. Particles use this. */
  fitY?: boolean;
}

const W = 200;
const H = 80;
const PAD = 6;
const SAMPLES = 48;

const round = (n: number) => Math.round(n * 1000) / 1000;
const INTERP_LABELS: Record<CurveInterp, string> = { linear: "Linear", step: "Step", smooth: "Smooth", easeIn: "Ease in", easeOut: "Ease out" };
const finiteOr = (n: number | undefined, fallback: undefined) => (n !== undefined && Number.isFinite(n) ? n : fallback);

/** A number field that commits as it is typed whenever the text reads as a number, and shows the committed value on blur. */
function NumInput(props: { value: number; label: string; disabled?: boolean; onCommit: (v: number) => void }) {
  const shown = String(+props.value.toFixed(4));
  const [draft, setDraft] = useState(shown);
  const focused = useRef(false);
  useEffect(() => {
    if (!focused.current) setDraft(shown);
  }, [shown]);
  return (
    <input
      type="text"
      inputMode="decimal"
      class="num-input pe-num"
      aria-label={props.label}
      disabled={props.disabled}
      value={draft}
      onFocus={() => (focused.current = true)}
      onInput={(e) => {
        const text = (e.currentTarget as HTMLInputElement).value;
        setDraft(text);
        const n = text.trim() === "" ? NaN : Number(text);
        if (Number.isFinite(n) && n !== props.value) props.onCommit(n);
      }}
      onBlur={() => {
        focused.current = false;
        setDraft(shown);
      }}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setDraft(shown);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
    />
  );
}

/**
 * A curve as a small SVG graph (ADR 0057 for particles, ADR 0158 §7 for audio). Drag a key to move it, double-click
 * empty space to add one, double-click or right-click a key (or select it and press Delete) to remove it. With
 * `interpolation`, the selected key also picks the shape of the segment that follows it.
 */
export function CurveEditor(props: CurveEditorProps) {
  const { curve, onChange, label, readOnly, xRange, interpolation } = props;
  const [selected, setSelected] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  // The value range is held still while a key is dragged, so the graph doesn't rescale under the pointer.
  const frozen = useRef<[number, number] | null>(null);
  const drag = useRef<number | null>(null);
  const yMin = finiteOr(props.yRange[0], undefined);
  const yMax = finiteOr(props.yRange[1], undefined);
  const fixed = !props.fitY && yMin !== undefined && yMax !== undefined && yMax > yMin;
  const [lo, hi] = frozen.current ?? (fixed ? ([yMin, yMax] as [number, number]) : fitYRange(curve, yMin, yMax));
  const px = (t: number) => xToPixel(t, xRange, PAD, W - PAD);
  const py = (v: number) => yToPixel(v, [lo, hi], PAD, H - PAD);
  const sel = selected !== null && selected < curve.length ? selected : null;
  const clampY = (v: number) => Math.min(yMax ?? Infinity, Math.max(yMin ?? -Infinity, v));

  /** The curve coordinates of a pointer event. */
  const at = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = svg.current!.getBoundingClientRect();
    const x = pixelToX(((e.clientX - r.left) / r.width) * W, xRange, PAD, W - PAD);
    const y = clampY(pixelToY(((e.clientY - r.top) / r.height) * H, [lo, hi], PAD, H - PAD));
    return [round(x), round(y)];
  };
  const remove = (i: number) => {
    if (readOnly || curve.length <= 1) return;
    onChange(removeKey(curve, i));
    setSelected(null);
  };
  // The line is sampled so every shape draws as it evaluates; it is flat before the first key and after the last.
  const points = curve.length
    ? Array.from({ length: SAMPLES }, (_, i) => {
        const t = xRange[0] + ((xRange[1] - xRange[0]) * i) / (SAMPLES - 1);
        return `${px(t)},${py(evalCurve(curve, t))}`;
      }).join(" ")
    : "";
  const zero = lo < 0 && hi > 0 ? py(0) : null;

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
          const added = addKey(curve, t, v, xRange);
          onChange(added.keys);
          setSelected(added.index);
        }}
      >
        <rect class="curve-bg" x={0} y={0} width={W} height={H} />
        {axisTicks(xRange, 4).map((t) => (
          <line key={t} class="curve-grid" x1={px(t)} y1={PAD} x2={px(t)} y2={H - PAD} />
        ))}
        {zero !== null && <line class="curve-zero" x1={PAD} y1={zero} x2={W - PAD} y2={zero} />}
        <polyline class="curve-line" points={points} />
        {curve.map(([t, v], i) => (
          <circle
            key={i}
            class={`curve-key${i === sel ? " selected" : ""}`}
            data-key={i}
            cx={px(t)}
            cy={py(v)}
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
              onChange(moveKey(curve, i, nt, nv, xRange));
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
              <em>x</em>
              <NumInput value={curve[sel][0]} label={`${label} key time`} disabled={readOnly} onCommit={(t) => onChange(moveKey(curve, sel, t, curve[sel][1], xRange))} />
            </label>
            <label>
              <em>value</em>
              <NumInput value={curve[sel][1]} label={`${label} key value`} disabled={readOnly} onCommit={(v) => onChange(moveKey(curve, sel, curve[sel][0], clampY(v), xRange))} />
            </label>
            {interpolation && sel < curve.length - 1 && (
              <label>
                <em>shape</em>
                <select
                  class="curve-interp"
                  aria-label={`${label} key interpolation`}
                  disabled={readOnly}
                  value={curve[sel][2] ?? "linear"}
                  onChange={(e) => onChange(setKeyInterp(curve, sel, (e.currentTarget as HTMLSelectElement).value as CurveInterp))}
                >
                  {Object.entries(INTERP_LABELS).map(([k, text]) => (
                    <option key={k} value={k}>
                      {text}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <button type="button" class="pe-mini" aria-label={`${label} remove key`} disabled={readOnly || curve.length <= 1} onClick={() => remove(sel)}>
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

/** A read-only sparkline of a curve, for when it is collapsed. `yRange` ends that are finite pin the scale, as in `fitY`. */
export function CurvePreview(props: { curve: Curve; xRange: [number, number]; yRange?: [number, number] }) {
  const { curve, xRange } = props;
  const [lo, hi] = fitYRange(curve, finiteOr(props.yRange?.[0], undefined), finiteOr(props.yRange?.[1], undefined));
  const w = 60;
  const h = 18;
  const pts = Array.from({ length: 24 }, (_, i) => {
    const t = xRange[0] + ((xRange[1] - xRange[0]) * i) / 23;
    return `${((i * w) / 23).toFixed(1)},${(h - 2 - ((evalCurve(curve, t) - lo) / (hi - lo)) * (h - 4)).toFixed(1)}`;
  }).join(" ");
  return (
    <svg class="curve-preview" viewBox={`0 0 ${w} ${h}`} aria-hidden="true">
      <polyline points={pts} />
    </svg>
  );
}
