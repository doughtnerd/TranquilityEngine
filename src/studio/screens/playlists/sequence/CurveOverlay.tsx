// One automation curve drawn over a clip or in a track's lane (proto §4: "one curve overlay"): the line sampled
// through the engine's evaluator (so shapes and Bézier keys draw as they play), and its keys as handles that can be
// pressed (select, drag), double-clicked (delete) and right-clicked (the shape menu). Positions come from the owner:
// `toX` maps the curve's x (clip time or sequence time) to pixels in the box.
import { evalCurve, type Curve } from "../../../../engine/core/curve";
import type { TargetSpec } from "./automationEdits";

export interface CurveOverlayProps {
  readonly curve: Curve;
  readonly spec: Pick<TargetSpec, "min" | "max" | "scale" | "bool">;
  readonly width: number;
  readonly height: number;
  /** Curve x → px in the box. */
  toX(x: number): number;
  /** Px in the box → curve x. */
  fromX(px: number): number;
  readonly selected?: readonly number[];
  readonly muted?: boolean;
  readonly interactive?: boolean;
  readonly label?: string;
  /**
   * Px at each end of the box that belong to the owner's edge handles (a clip's trim and length edges): keys there
   * are drawn but leave the press to the edge, so a point at the clip's end never blocks setting its length.
   */
  readonly edgeGuard?: number;
  onPointPress?(index: number, e: PointerEvent): void;
  onPointDoubleClick?(index: number, e: MouseEvent): void;
  onPointMenu?(index: number, e: MouseEvent): void;
}

/** A value → y in a box `height` tall (log for frequencies, top is max). */
function valueToY(v: number, spec: CurveOverlayProps["spec"], height: number): number {
  const pad = 4;
  const h = Math.max(1, height - pad * 2);
  let f: number;
  if (spec.scale === "log" && spec.min > 0) f = (Math.log(Math.max(spec.min, v)) - Math.log(spec.min)) / (Math.log(spec.max) - Math.log(spec.min));
  else f = (v - spec.min) / (spec.max - spec.min || 1);
  return pad + (1 - Math.max(0, Math.min(1, f))) * h;
}

/** A y in the box → value (the inverse of `valueToY`). */
export function yToValue(y: number, spec: CurveOverlayProps["spec"], height: number): number {
  const pad = 4;
  const f = 1 - (y - pad) / Math.max(1, height - pad * 2);
  const c = Math.max(0, Math.min(1, f));
  if (spec.scale === "log" && spec.min > 0) return Math.exp(Math.log(spec.min) + c * (Math.log(spec.max) - Math.log(spec.min)));
  return spec.min + c * (spec.max - spec.min);
}

export function CurveOverlay(props: CurveOverlayProps) {
  const { curve, spec, width, height } = props;
  if (!curve.length || width <= 0) return null;
  const pts: string[] = [];
  for (let px = 0; px <= width; px += 3) pts.push(`${px.toFixed(1)},${valueToY(evalCurve(curve, props.fromX(px)), spec, height).toFixed(1)}`);
  const sel = new Set(props.selected ?? []);
  const guard = props.edgeGuard ?? 0;
  const atEdge = (x: number) => guard > 0 && (x < guard || x > width - guard);
  return (
    <svg class={`sq-curve${props.muted ? " muted" : ""}`} width={width} height={height} aria-label={props.label} role="img">
      <polyline points={pts.join(" ")} />
      {props.interactive &&
        curve.map((k, i) => (
          <circle
            key={i}
            class={`sq-key${sel.has(i) ? " selected" : ""}${atEdge(props.toX(k[0])) ? " at-edge" : ""}`}
            cx={props.toX(k[0])}
            cy={valueToY(k[1], spec, height)}
            r={4}
            onPointerDown={(e) => {
              e.stopPropagation();
              props.onPointPress?.(i, e);
            }}
            onDblClick={(e) => {
              e.stopPropagation();
              props.onPointDoubleClick?.(i, e);
            }}
            onContextMenu={(e) => {
              e.preventDefault();
              e.stopPropagation();
              props.onPointMenu?.(i, e);
            }}
          >
            <title>{`${k[0].toFixed(3)} s · ${k[1].toFixed(2)}`}</title>
          </circle>
        ))}
    </svg>
  );
}
