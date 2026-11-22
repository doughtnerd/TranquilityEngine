// The curve editor's plot (ADR 0332): the active lane's curve over its input, the other visible lanes on the same input
// behind it, backdrops (waveform, histogram, listener density), markers (playhead, game now, Min/Max, listener), keys
// with the tangent toolbar, Bézier handles and the Min/Max handles. Every rule is `curveEditorModel.ts`'s; this draws
// and turns pointer positions into axis x and normalised y.
import { useRef, useState } from "preact/hooks";
import type { Curve } from "../../../engine/core/curve";
import {
  addKey,
  deleteKey,
  dragHandle,
  evalLane,
  formatValue,
  formatX,
  handlePoints,
  KEY_SHAPES,
  laneColor,
  laneOf,
  moveKey,
  samplePath,
  setKeyFree,
  setKeyShape,
  shapeOf,
  shapeRefusal,
  stretchDistance,
  toNorm,
  withLane,
  xTicks,
  yLabels,
  SHAPE_LABELS,
  type CurveDraft,
  type CurveEditorSpec,
  type CurveEdit,
  type KeyShape,
  type LaneContext,
} from "./curveEditorModel";
import { curveKeyHandles } from "../../../engine/core/curve";

/** How the plot changes the dialog's draft. */
export interface DraftEditor {
  /** The draft as it is now (mid-drag included). */
  live(): CurveDraft;
  /** Show a draft without making it an edit (a drag in progress). */
  preview(next: CurveDraft): void;
  /** Make `next` (or the previewed draft) one undo step. */
  commit(label: string, next?: CurveDraft): void;
  /** Drop a preview. */
  cancel(): void;
  /** An edit was refused: say why. */
  refused(label: string, reason: string): void;
}

/** The waveform backdrop: amplitude 0..1 at `t`, or `[before, after]` the lanes' values (by lane id) shape it. */
export type WaveformFn = (t: number, values: Readonly<Record<string, number>>) => number | readonly [number, number];

export interface CurvePlotProps {
  readonly spec: CurveEditorSpec;
  readonly draft: CurveDraft;
  readonly ctx: LaneContext;
  readonly activeIndex: number;
  readonly hidden: ReadonlySet<string>;
  readonly range: readonly [number, number];
  readonly selected: number | null;
  /** The selection came from the dope sheet: no tangent toolbar on the plot. */
  readonly selectedFromDope: boolean;
  readonly playhead: number;
  readonly waveform?: WaveformFn;
  readonly histogram?: readonly number[];
  readonly listenerDensity?: (d: number) => number;
  readonly band?: readonly [number, number];
  readonly editor: DraftEditor;
  onSelect(index: number | null): void;
}

const W = 1000;
const H = 300;
const f1 = (v: number) => v.toFixed(1);
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** Toolbar icons for the shapes (24 × 24). */
export const SHAPE_ICONS: Readonly<Record<KeyShape, string>> = {
  linear: "M4 19L20 5",
  smooth: "M4 19C12 19 12 5 20 5",
  easeIn: "M4 19C14 19 18 12 20 5",
  easeOut: "M4 19C6 12 10 5 20 5",
  step: "M4 19H12V5H20",
  bezier: "M4 19C6 8 18 16 20 5M2 12l5-7M17 17l5-7",
};
export const FREE_ICON = "M5 19l6-6M13 11l6-6M4 14l5 5M15 5l5 5";
export const DELETE_ICON = "M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6";

export function Icon(props: { d: string; size?: number }) {
  const s = props.size ?? 14;
  return (
    <svg width={s} height={s} viewBox="0 0 24 24" aria-hidden="true" class="ce-icon">
      <path d={props.d} />
    </svg>
  );
}

export function CurvePlot(props: CurvePlotProps) {
  const { spec, draft, ctx, range, editor, selected } = props;
  const { lane, axis } = ctx;
  const state = laneOf(spec, draft, lane.id)!.state;
  const curve = state.curve;
  const area = useRef<HTMLDivElement>(null);
  const [hover, setHover] = useState<number | null>(null);
  const [vx0, vx1] = range;
  const vs = vx1 - vx0 || 1;
  const sx = (x: number) => ((x - vx0) / vs) * W;
  const sy = (yn: number) => (1 - yn) * H;
  const pc = (x: number) => `${(((x - vx0) / vs) * 100).toFixed(3)}%`;
  const pcy = (yn: number) => `${((1 - yn) * 100).toFixed(3)}%`;
  /** A pointer event as axis x and normalised y. */
  const toDomain = (e: { clientX: number; clientY: number }): [number, number] => {
    const r = area.current!.getBoundingClientRect();
    return [vx0 + ((e.clientX - r.left) / (r.width || 1)) * vs, 1 - (e.clientY - r.top) / (r.height || 1)];
  };
  const laneCurve = (d: CurveDraft) => laneOf(spec, d, lane.id)!.state.curve;
  const setCurve = (d: CurveDraft, c: Curve) => withLane(d, lane.id, { curve: c });
  const apply = (label: string, r: CurveEdit<Curve>) => ("refused" in r ? editor.refused(label, r.refused) : editor.commit(label, setCurve(editor.live(), r.next)));

  const path = (c: Curve, l = lane): string => {
    const pts = samplePath(l, c, range, 240);
    if (!pts.length) return "";
    return `M${f1(sx(vx0 - vs))} ${f1(sy(pts[0][1]))} ` + pts.map((p) => `L${f1(sx(p[0]))} ${f1(sy(p[1]))}`).join(" ") + ` L${f1(sx(vx1 + vs))} ${f1(sy(pts[pts.length - 1][1]))}`;
  };

  // Backdrops.
  let waveBefore = "";
  let waveAfter = "";
  if (axis.kind === "time" && props.waveform) {
    const n = 220;
    const top: string[] = [], bot: string[] = [], topA: string[] = [], botA: string[] = [];
    let pair = false;
    for (let i = 0; i <= n; i++) {
      const t = vx0 + (vs * i) / n;
      const values: Record<string, number> = {};
      spec.lanes.forEach((l) => {
        const s = draft.lanes.find((q) => q.id === l.id)!;
        values[l.id] = s.bypass || s.input !== axis.id ? l.base : evalLane(l, s.curve, t);
      });
      let amp: number | readonly [number, number] = 0;
      try {
        amp = t < 0 || t > axis.max + 1e-6 ? 0 : props.waveform(t, values);
      } catch {
        amp = 0;
      }
      if (typeof amp !== "number") pair = true;
      const [b, a] = typeof amp === "number" ? [amp, amp] : amp;
      const X = f1((i / n) * W);
      const hb = clamp(b || 0, 0, 1.2) * 120;
      const ha = clamp(a || 0, 0, 1.2) * 120;
      top.push(`${X} ${f1(150 - hb)}`);
      bot.unshift(`${X} ${f1(150 + hb)}`);
      topA.push(`${X} ${f1(150 - ha)}`);
      botA.unshift(`${X} ${f1(150 + ha)}`);
    }
    waveBefore = `M${top.join(" L")} L${bot.join(" L")} Z`;
    if (pair) waveAfter = `M${topA.join(" L")} L${botA.join(" L")} Z`;
  }
  const bars: { x: number; w: number; h: number }[] = [];
  if (axis.kind === "parameter" && props.histogram?.length) {
    const hist = props.histogram;
    const peak = Math.max(...hist, 1e-9);
    const bw = (axis.max - axis.min) / hist.length;
    hist.forEach((v, i) => {
      const a = axis.min + i * bw;
      bars.push({ x: sx(a) + 1.5, w: Math.max(0, sx(a + bw) - sx(a) - 3), h: (Math.max(0, v) / peak) * 250 });
    });
  }
  let density = "";
  if (axis.kind === "distance" && props.listenerDensity) {
    const pts = [`${f1(sx(axis.min))} ${H}`];
    for (let i = 0; i <= 120; i++) {
      const d = axis.min + ((axis.max - axis.min) * i) / 120;
      pts.push(`${f1(sx(d))} ${f1(H - clamp(props.listenerDensity(d), 0, 1) * 160)}`);
    }
    pts.push(`${f1(sx(axis.max))} ${H}`);
    density = `M${pts.join(" L")} Z`;
  }

  // Markers.
  const shades: { x: number; w: number; cls: string }[] = [];
  const marks: { x: number; cls: string }[] = [];
  const labels: { x: number; text: string; cls: string }[] = [];
  if (axis.kind === "time" && props.playhead >= vx0 && props.playhead <= vx1) marks.push({ x: props.playhead, cls: "ce-mark-playhead" });
  if (axis.kind === "parameter") {
    if (props.band) {
      shades.push({ x: sx(props.band[0]), w: sx(props.band[1]) - sx(props.band[0]), cls: "ce-shade-band" });
      marks.push({ x: props.band[0], cls: "ce-mark-band" }, { x: props.band[1], cls: "ce-mark-band" });
    }
    if (axis.now !== undefined) {
      marks.push({ x: axis.now, cls: "ce-mark-now" });
      labels.push({ x: axis.now, text: `Game now ${formatX(axis, axis.now)}`, cls: "ce-label-now" });
    }
  }
  if (axis.kind === "distance") {
    shades.push({ x: 0, w: sx(draft.minDistance), cls: "ce-shade-inside" }, { x: sx(draft.maxDistance), w: W - sx(draft.maxDistance), cls: "ce-shade-beyond" });
    marks.push({ x: draft.minDistance, cls: "ce-mark-minmax" }, { x: draft.maxDistance, cls: "ce-mark-minmax" });
    if (axis.now !== undefined) {
      marks.push({ x: axis.now, cls: "ce-mark-listener" });
      labels.push({ x: axis.now, text: `Listener now ${formatX(axis, axis.now)}`, cls: "ce-label-now" });
    }
  }

  const others = spec.lanes
    .map((l, i) => ({ l, i, s: draft.lanes.find((q) => q.id === l.id)! }))
    .filter(({ l, s }) => l.id !== lane.id && !props.hidden.has(l.id) && s.input === state.input);
  const activeHidden = props.hidden.has(lane.id);
  const color = laneColor(lane, props.activeIndex);
  const [yTop, yMid, yBottom] = yLabels(lane);
  const ticks = xTicks(axis, range);

  // Dragging a key, a handle or Min/Max: previews from the live draft, one edit on release.
  const drag = useRef<{ kind: "key" | "in" | "out" | "min" | "max"; index: number; start: CurveDraft; moved: boolean } | null>(null);
  const begin = (e: PointerEvent, kind: "key" | "in" | "out" | "min" | "max", index: number) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    e.preventDefault();
    (e.currentTarget as Element).setPointerCapture(e.pointerId);
    drag.current = { kind, index, start: editor.live(), moved: false };
    if (kind === "key") props.onSelect(index);
  };
  const move = (e: PointerEvent) => {
    const d = drag.current;
    if (!d) return;
    const [x, yn] = toDomain(e);
    d.moved = true;
    const base = editor.live();
    const c = laneCurve(base);
    if (d.kind === "key") editor.preview(setCurve(base, moveKey(ctx, c, d.index, x, yn, { snap: !e.altKey })));
    else if (d.kind === "in" || d.kind === "out") editor.preview(setCurve(base, dragHandle(ctx, c, d.index, d.kind, x, yn)));
    else editor.preview(stretchDistance(spec, d.start, d.kind === "min" ? x : d.start.minDistance, d.kind === "max" ? x : d.start.maxDistance));
  };
  const end = () => {
    const d = drag.current;
    drag.current = null;
    if (!d?.moved) return;
    editor.commit(d.kind === "key" ? "Move key" : d.kind === "min" ? "Move Min" : d.kind === "max" ? "Move Max" : "Move handle");
  };

  const sel = selected !== null && selected < curve.length ? selected : null;
  const handles = sel !== null && !activeHidden ? handlePoints(lane, curve, sel) : null;
  const toolbarFor = sel !== null && !props.selectedFromDope ? sel : hover;

  return (
    <div class="ce-plot">
      <div class="ce-ylabels" aria-hidden="true">
        <span style={{ top: "0%" }}>{yTop}</span>
        {yMid && <span style={{ top: "50%", transform: "translateY(-50%)" }}>{yMid}</span>}
        <span style={{ top: "100%", transform: "translateY(-100%)" }}>{yBottom}</span>
      </div>
      <div
        class="ce-plot-box"
        title="Double-click to add a key · drag keys (Alt: no snapping) · hover a key for its shape"
        onPointerDown={(e) => {
          if (e.target === e.currentTarget || (e.target as Element).classList?.contains("ce-plot-area")) props.onSelect(null);
        }}
        onDblClick={(e) => {
          const t = e.target as Element;
          if (t !== e.currentTarget && !t.classList?.contains("ce-plot-area")) return;
          const [x, yn] = toDomain(e);
          const r = addKey(ctx, curve, x, yn, { snap: !e.altKey });
          if ("refused" in r) return; // within half a step of a key: ignored
          editor.commit("Add key", setCurve(editor.live(), r.next.curve));
          props.onSelect(r.next.index);
        }}
      >
        <svg class="ce-plot-svg" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" aria-hidden="true">
          {shades.map((s, i) => (
            <rect key={`s${i}`} class={s.cls} x={s.x} y={0} width={Math.max(0, s.w)} height={H} />
          ))}
          {[75, 150, 225].map((y) => (
            <line key={`h${y}`} class="ce-grid" x1={0} y1={y} x2={W} y2={y} vector-effect="non-scaling-stroke" />
          ))}
          {ticks.map((t, i) => (
            <line key={`v${i}`} class="ce-grid" x1={sx(t)} y1={0} x2={sx(t)} y2={H} vector-effect="non-scaling-stroke" />
          ))}
          {bars.map((b, i) => (
            <rect key={`b${i}`} class="ce-hbar" x={b.x} y={H - b.h} width={b.w} height={b.h} />
          ))}
          {waveBefore && <path class="ce-wave-before" d={waveBefore} />}
          {waveAfter && <path class="ce-wave-after" d={waveAfter} />}
          {density && <path class="ce-density" d={density} vector-effect="non-scaling-stroke" />}
          {others.map(({ l, i, s }) => (
            <path key={l.id} class={`ce-other${s.bypass ? " bypassed" : ""}`} d={path(s.curve, l)} style={{ stroke: laneColor(l, i) }} vector-effect="non-scaling-stroke" />
          ))}
          {marks.map((m, i) => (
            <line key={`m${i}`} class={m.cls} x1={sx(m.x)} y1={0} x2={sx(m.x)} y2={H} vector-effect="non-scaling-stroke" />
          ))}
          <path class={`ce-active${state.bypass ? " bypassed" : ""}${activeHidden ? " hidden" : ""}`} d={path(curve)} style={state.bypass ? undefined : { stroke: color }} vector-effect="non-scaling-stroke" />
          {handles &&
            (["in", "out"] as const).map((w) => {
              const p = handles[w];
              const k = curve[sel!];
              return p ? <line key={w} class="ce-handle-line" x1={sx(k[0])} y1={sy(toNorm(lane, k[1]))} x2={sx(p[0])} y2={sy(p[1])} vector-effect="non-scaling-stroke" /> : null;
            })}
        </svg>
        <div class="ce-plot-area" ref={area}>
          {labels.map((l, i) => {
            const fx = (l.x - vx0) / vs;
            return (
              <span key={`l${i}`} class={`ce-mark-label ${l.cls}`} style={{ left: pc(l.x), transform: `translateX(${fx < 0.08 ? "2px" : fx > 0.92 ? "calc(-100% - 2px)" : "-50%"})` }}>
                {l.text}
              </span>
            );
          })}
          {axis.kind === "distance" &&
            (["min", "max"] as const).map((w) => {
              const v = w === "min" ? draft.minDistance : draft.maxDistance;
              return (
                <button
                  key={w}
                  type="button"
                  class="ce-minmax"
                  style={{ left: pc(v) }}
                  title={`Drag to change ${w === "min" ? "Min" : "Max"} distance; every curve stretches with it`}
                  aria-label={`${w === "min" ? "Min" : "Max"} distance ${formatX(axis, v)}`}
                  onPointerDown={(e) => begin(e, w, -1)}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                  onDblClick={(e) => e.stopPropagation()}
                >
                  {w === "min" ? "Min" : "Max"} {formatX(axis, v)}
                </button>
              );
            })}
          {handles &&
            (["in", "out"] as const).map((w) => {
              const p = handles[w];
              return p ? (
                <button
                  key={w}
                  type="button"
                  class="ce-handle"
                  style={{ left: pc(p[0]), top: pcy(p[1]) }}
                  aria-label={w === "in" ? "In handle" : "Out handle"}
                  title={w === "in" ? "In handle" : "Out handle"}
                  onPointerDown={(e) => begin(e, w, sel!)}
                  onPointerMove={move}
                  onPointerUp={end}
                  onPointerCancel={end}
                  onDblClick={(e) => e.stopPropagation()}
                />
              ) : null;
            })}
          {!activeHidden &&
            curve.map((k, i) => {
              if (k[0] < vx0 - 1e-9 || k[0] > vx1 + 1e-9) return null;
              const yn = toNorm(lane, k[1]);
              const on = sel === i;
              const fx = (k[0] - vx0) / vs;
              return (
                <div key={i} class="ce-kw" style={{ left: pc(k[0]), top: pcy(clamp(yn, 0, 1)) }} onPointerEnter={() => setHover(i)} onPointerLeave={() => setHover((h) => (h === i ? null : h))}>
                  <button
                    type="button"
                    class={`ce-key${on ? " on" : ""}`}
                    data-key={i}
                    style={{ borderColor: color, ...(on ? { background: color } : {}) }}
                    aria-label={`${lane.name} key at ${formatX(axis, k[0])}, ${formatValue(lane, k[1])}`}
                    aria-pressed={on}
                    title={`${lane.name} key at ${formatX(axis, k[0])}, ${formatValue(lane, k[1])}`}
                    onPointerDown={(e) => begin(e, "key", i)}
                    onPointerMove={move}
                    onPointerUp={end}
                    onPointerCancel={end}
                    onFocus={() => props.onSelect(i)}
                    onDblClick={(e) => e.stopPropagation()}
                  />
                  {toolbarFor === i && (
                    <KeyToolbar ctx={ctx} curve={curve} index={i} below={yn > 0.82} side={fx > 0.8 ? "r" : fx < 0.2 ? "l" : ""} onEdit={apply} onSelect={(on) => props.onSelect(on ? i : null)} />
                  )}
                </div>
              );
            })}
        </div>
      </div>
      <span />
      <div class="ce-xlabels" aria-hidden="true">
        {ticks.map((t, i) => {
          const fx = (t - vx0) / vs;
          return (
            <span key={i} style={{ left: pc(t), transform: `translateX(${fx < 0.02 ? "0" : fx > 0.98 ? "-100%" : "-50%"})` }}>
              {formatX(axis, t)}
            </span>
          );
        })}
      </div>
    </div>
  );
}

/** The shape tools for one key: the six shapes, Free handles (Bézier only) and Delete. */
export function KeyToolbar(props: { ctx: LaneContext; curve: Curve; index: number; below: boolean; side: string; onEdit(label: string, r: CurveEdit<Curve>): void; onSelect(on: boolean): void }) {
  const { ctx, curve, index } = props;
  const k = curve[index];
  const shape = shapeOf(k);
  const end = index === 0 || index === curve.length - 1;
  const free = !!curveKeyHandles(k)?.free;
  const shapes = ctx.linearOnly || ctx.lane.bool ? [] : KEY_SHAPES;
  return (
    <div class={`ce-ktb${props.below ? " below" : ""}${props.side ? ` ${props.side}` : ""}`} role="toolbar" aria-label="Key shape" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      {shapes.map((s) => (
        <button
          key={s}
          type="button"
          class="ce-tb"
          aria-pressed={shape === s}
          aria-label={SHAPE_LABELS[s]}
          title={shapeRefusal(ctx, s) ?? SHAPE_LABELS[s]}
          disabled={shapeRefusal(ctx, s) !== null}
          onClick={() => {
            props.onEdit(`Set key shape: ${SHAPE_LABELS[s]}`, setKeyShape(ctx, curve, index, s));
            props.onSelect(true);
          }}
        >
          <Icon d={SHAPE_ICONS[s]} />
        </button>
      ))}
      {shapes.length > 0 && (
        <button type="button" class="ce-tb" aria-pressed={free} disabled={shape !== "bezier"} aria-label="Free handles: move each side on its own" title="Free handles: move each side on its own (Bézier only)" onClick={() => props.onEdit(free ? "Mirror handles" : "Free handles", setKeyFree(curve, index, !free))}>
          <Icon d={FREE_ICON} />
        </button>
      )}
      <button type="button" class="ce-tb del" disabled={end || curve.length <= 2} aria-label="Delete key" title={end ? "End keys can't be deleted" : "Delete key (Del)"} onClick={() => {
          props.onEdit("Delete key", deleteKey(curve, index));
          props.onSelect(false);
        }}>
        <Icon d={DELETE_ICON} />
      </button>
    </div>
  );
}

