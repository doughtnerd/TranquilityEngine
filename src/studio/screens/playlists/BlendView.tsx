// A Blend's views (the prototype's Blend view; ADR 0343 "Blend"; its settings sit in the toolbar row above,
// `ModeToolbar.tsx`). 1D: the lane (each entry's weight polygon, ADR 0350's regions with four handles on the selected
// one), node labels along its top (name and weight now, bordered in the entry's colour; click selects, double-click
// opens), the test-value cursor with its value, ▲ position handles under it (drag, ← → to nudge with Shift ×10) and
// the axis values; the voice envelope with a big preview (the morphed envelope at the input between dashed low and high
// ends, a preview moment to click or drag, the release line). 2D: the plane (grid, Delaunay edges, the active
// triangle, spokes and halos from the input to the entries playing, node pills with their weights, the axes with their
// ranges) and the Nodes list beside it (Playing / Silent and the weight; hover lights a node). Dragging on the lane or
// plane's background scrubs the test values. Weights are the engine's (`blendViewModel.ts`). A view over props.
import { useId, useRef, useState } from "preact/hooks";
import type { Adsr, BlendAxis, PlaylistBody } from "../../../engine/audio/playlist/types";
import { adsrLevel, lerpAdsr } from "../../../engine/audio/playlist/envelope";
import { NumberBox, SelectBox, Section } from "../../../editor/ui/PanelFields";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import type { BodyEdit } from "./EntryList";
import { axisRange, denormalise, normalise } from "./blendPlacement";
import {
  activeTriangle, axisInput, dragRegion, handleAt, influenceGrid, laneCurves, liveWeights, normalisedPoints, nudge, nudgeRegion, regionsOf,
  shownRegion, triangleEdges, weightCurvesOf, type RegionHandle,
} from "./blendViewModel";
import type { Curve } from "../../../engine/core/curve";
import type { BlendRegion } from "../../../engine/audio/playlist/types";
import { FadeShapeSelect } from "../../components/FadeShapeSelect";
import { FADE_SHAPE_OPTIONS, narrowWeightCurve, weightCurvePreset } from "../../components/fadeShapeModel";
import { ADSR_LIMITS, setAdsr, setEntryUse, setEnvelopeMode, type EditContext } from "./playlistEdits";
import { entryName } from "./playlistPaths";
import { EmptyState } from "../../../editor/ui/EmptyState";

export interface BlendViewProps {
  readonly body: PlaylistBody;
  readonly ctx: EditContext;
  readonly writable: boolean;
  readonly values: Readonly<Record<string, number>>;
  readonly selected: number | null;
  onEdit(label: string, edit: BodyEdit, drag?: boolean): void;
  onSelect(i: number): void;
  /** Open an entry (double-click a node label). */
  onOpen?(i: number): void;
  /** Scrub a parameter's test value (dragging on the lane's background). */
  onTestValue(name: string, value: number): void;
  /** ADR 0350: open an entry's weight curve in the shared curve editor. */
  onEditWeightCurve?(i: number): void;
}

const HANDLES: { id: RegionHandle; label: string }[] = [
  { id: "start", label: "region start" },
  { id: "fadeIn", label: "fade-in end" },
  { id: "fadeOut", label: "fade-out start" },
  { id: "end", label: "region end" },
];

/** The weight-curve presets: the default, the fade shapes (as a fade in of the weight) and two narrower overlaps. */
const WEIGHT_PRESETS: { value: string; label: string; curve: () => Curve | undefined }[] = [
  { value: "default", label: "Default (the weight)", curve: () => undefined },
  ...FADE_SHAPE_OPTIONS.filter((o) => o.value !== "linear").map((o) => ({ value: o.value, label: o.label, curve: () => weightCurvePreset(o.value) })),
  { value: "narrow25", label: "Narrow overlap (from 25 %)", curve: () => narrowWeightCurve(0.25) },
  { value: "narrow40", label: "Narrow overlap (from 40 %)", curve: () => narrowWeightCurve(0.4) },
];

const W = 1000;
const H1 = 150;
const series = (i: number) => `studio-series-${(i % 8) + 1}`;

function pointerFraction(e: PointerEvent, el: Element): { x: number; y: number } {
  const r = el.getBoundingClientRect();
  return { x: Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))), y: Math.min(1, Math.max(0, 1 - (e.clientY - r.top) / Math.max(1, r.height))) };
}

/** Track a pointer drag on `el`, calling `move` with the pointer's place, `end` once on release. */
function dragOn(e: PointerEvent, el: Element, move: (f: { x: number; y: number }) => void, end: () => void): void {
  e.preventDefault();
  const doc = el.ownerDocument;
  const onMove = (ev: PointerEvent) => move(pointerFraction(ev, el));
  const onUp = () => {
    doc.removeEventListener("pointermove", onMove);
    doc.removeEventListener("pointerup", onUp);
    doc.removeEventListener("pointercancel", onUp);
    end();
  };
  doc.addEventListener("pointermove", onMove);
  doc.addEventListener("pointerup", onUp);
  // A touch the browser takes over still ends the drag (the lane and plane are `touch-action: none`, so it rarely does).
  doc.addEventListener("pointercancel", onUp);
  move(pointerFraction(e, el));
}

/** A value on an axis as the prototype writes it: a 0..1 parameter in %, voice time in seconds, else the number. */
function axisText(axis: BlendAxis, range: readonly [number, number], v: number): string {
  if ("voiceTime" in axis) return `${v.toFixed(2)} s`;
  if (range[0] === 0 && range[1] === 1) return `${Math.round(v * 100)}%`;
  const span = Math.abs(range[1] - range[0]);
  const k = span >= 100 ? 1 : span >= 10 ? 10 : 100;
  return String(Math.round(v * k) / k);
}

export function BlendView(props: BlendViewProps) {
  const { body, ctx, writable, onEdit } = props;
  const blend = body.blend;
  const [voiceTime, setVoiceTime] = useState(0);
  const [hovered, setHovered] = useState<number | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const soft = `pl-plane-soft-${useId()}`;
  if (!blend) return null;
  const ranges = blend.axes.map((a) => axisRange(a, ctx.parameters));
  const pts = normalisedPoints(body.entries, ranges);
  const weights = liveWeights(body, ctx.parameters, props.values, voiceTime);
  const input = blend.axes.map((a, k) => normalise(axisInput(a, ctx.parameters, props.values, voiceTime), ranges[k]!));
  const twoD = blend.axes.length === 2;
  const fmtAt = (k: 0 | 1, v: number) => axisText(blend.axes[k]!, ranges[k]!, v);

  /** Scrub the input: a parameter's test value, or the voice-time preview. */
  const scrub = (k: 0 | 1, f: number) => {
    const a = blend.axes[k]!;
    const v = denormalise(f, ranges[k]!);
    if ("voiceTime" in a) setVoiceTime(v);
    else props.onTestValue(a.parameter, v);
  };
  const moveNode = (i: number, f: { x: number; y: number }, drag: boolean) =>
    onEdit(`Move ${entryName(body.entries[i]!, i)}`, (b) => setEntryUse(b, i, twoD ? { x: denormalise(f.x, ranges[0]!), y: denormalise(f.y, ranges[1]!) } : { x: denormalise(f.x, ranges[0]!) }), drag);
  const startNode = (i: number, e: PointerEvent) => {
    if (!writable || !svg.current) return;
    e.stopPropagation();
    props.onSelect(i);
    let last = { x: pts[i]!.x, y: pts[i]!.y };
    dragOn(e, svg.current, (f) => { last = f; moveNode(i, f, true); }, () => moveNode(i, last, false));
  };
  const nodeKeys = (i: number, e: KeyboardEvent) => {
    if (!writable) return;
    const big = e.shiftKey;
    const e0 = body.entries[i]!;
    let patch: { x?: number; y?: number } | null = null;
    if (e.key === "ArrowLeft" || e.key === "ArrowRight") patch = { x: nudge(e0.x ?? ranges[0]![0], ranges[0]!, e.key === "ArrowLeft" ? -1 : 1, big) };
    else if (twoD && (e.key === "ArrowUp" || e.key === "ArrowDown")) patch = { y: nudge(e0.y ?? ranges[1]![0], ranges[1]!, e.key === "ArrowDown" ? -1 : 1, big) };
    if (!patch) return;
    e.preventDefault();
    onEdit(`Move ${entryName(e0, i)}`, (b) => setEntryUse(b, i, patch!));
  };

  // --- ADR 0350: 1D regions (trapezoids with four handles) ---
  const regionOf = (i: number) => shownRegion(body.entries, i, ranges[0]!, blend.fade);
  const setRegion = (i: number, r: BlendRegion | undefined, label: string, drag = false) => onEdit(label, (b) => setEntryUse(b, i, { region: r }), drag);
  const startHandle = (i: number, h: RegionHandle, e: PointerEvent) => {
    if (!writable || !svg.current) return;
    e.stopPropagation();
    props.onSelect(i);
    const from = regionOf(i).region;
    let last = from;
    const label = `Region · ${entryName(body.entries[i]!, i)}`;
    dragOn(e, svg.current, (f) => { last = dragRegion(from, h, denormalise(f.x, ranges[0]!)); setRegion(i, last, label, true); }, () => setRegion(i, last, label));
  };
  const handleKeys = (i: number, h: RegionHandle, e: KeyboardEvent) => {
    if (!writable || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    setRegion(i, nudgeRegion(regionOf(i).region, h, ranges[0]!, e.key === "ArrowLeft" ? -1 : 1, e.shiftKey), `Region · ${entryName(body.entries[i]!, i)}`);
  };
  const lx = (v: number) => normalise(v, ranges[0]!) * W;
  const TOP = 44; // room for the node labels
  const trapezoid = (r: BlendRegion) => `${lx(r.start)},${H1} ${lx(r.start + r.fadeIn)},${TOP} ${lx(r.end - r.fadeOut)},${TOP} ${lx(r.end)},${H1}`;

  const lane = () => {
    const curves = laneCurves(pts.map((p) => p.x), blend.fade, blend.curve, 101, regionsOf(body.entries, ranges[0]!), weightCurvesOf(body.entries));
    const sel = props.selected !== null && body.entries[props.selected] ? props.selected : null;
    const selRegion = sel !== null ? regionOf(sel) : null;
    const lanePress = (e: PointerEvent) => svg.current && dragOn(e, svg.current, (f) => scrub(0, f.x), () => {});
    return (
      <div class="pl-lane-wrap">
        <div class="pl-lane-box" title="Click or drag empty space to move the test value">
          <svg ref={svg} class="pl-lane" viewBox={`0 0 ${W} ${H1}`} preserveAspectRatio="none" role="group" aria-label="Blend lane" onPointerDown={(e) => e.target === e.currentTarget && lanePress(e)}>
            <rect class="pl-lane-bg" x="0" y="0" width={W} height={H1} onPointerDown={lanePress} />
            {body.entries.map((e, i) => e.region && <polygon key={`r${i}`} class={`pl-region ${series(i)}`} points={trapezoid(e.region)} />)}
            {curves.map((c, i) => (
              <polygon key={i} class={`pl-poly ${series(i)}${props.selected === i ? " selected" : ""}${(weights[i] ?? 0) > 1e-3 ? " hot" : ""}`} points={`0,${H1} ${c.map(([x, w]) => `${x * W},${H1 - w * (H1 - TOP)}`).join(" ")} ${W},${H1}`} />
            ))}
            {sel !== null && selRegion && (
              <g class={`pl-region-edit ${series(sel)}${selRegion.explicit ? "" : " derived"}`}>
                <polygon class="pl-region-outline" points={trapezoid(selRegion.region)} />
                {HANDLES.map((h) => {
                  const at = handleAt(selRegion.region, h.id);
                  const top = h.id === "fadeIn" || h.id === "fadeOut";
                  return (
                    <rect key={h.id} class="pl-region-handle" x={lx(at) - 5} y={top ? TOP - 6 : H1 - 12} width="10" height="12" tabindex={writable ? 0 : -1} role="slider"
                      aria-label={`${entryName(body.entries[sel]!, sel)} ${h.label}`} aria-valuenow={at}
                      onPointerDown={(e) => startHandle(sel, h.id, e)} onKeyDown={(e) => handleKeys(sel, h.id, e)} />
                  );
                })}
              </g>
            )}
          </svg>
          {pts.map((p, i) => (
            <button key={`n${i}`} type="button" class={`pl-zlab ${series(i)}${props.selected === i ? " on" : ""}${(weights[i] ?? 0) > 1e-3 ? " hot" : ""}`}
              style={{ left: `${p.x * 100}%`, transform: `translateX(${p.x > 0.8 ? "-100%" : p.x < 0.2 ? "0" : "-50%"})` }}
              aria-pressed={props.selected === i} title={`${entryName(body.entries[i]!, i)} at ${fmtAt(0, body.entries[i]!.x ?? ranges[0]![0])}: weight now ${Math.round((weights[i] ?? 0) * 100)}%. Click to select, double-click to open.`}
              onPointerDown={(e) => e.stopPropagation()} onClick={() => props.onSelect(i)} onDblClick={() => props.onOpen?.(i)}>
              <b>{entryName(body.entries[i]!, i)}</b>
              <span>{Math.round((weights[i] ?? 0) * 100)}%</span>
            </button>
          ))}
          <div class="pl-cur" style={{ left: `${input[0]! * 100}%` }} aria-hidden="true"><span class="pl-curt" style={input[0]! > 0.85 ? { transform: "translateX(calc(-100% - 6px))" } : undefined}>{fmtAt(0, denormalise(input[0]!, ranges[0]!))}</span></div>
        </div>
        <div class="pl-bh-row">
          {pts.map((p, i) => (
            <span key={i} class={`pl-bh ${series(i)}${props.selected === i ? " on" : ""}`} style={{ left: `${p.x * 100}%`, transform: `translateX(${-p.x * 100}%)` }} tabIndex={writable ? 0 : -1} role="slider"
              aria-label={`${entryName(body.entries[i]!, i)} position`} aria-valuenow={body.entries[i]!.x ?? 0} aria-valuetext={fmtAt(0, body.entries[i]!.x ?? ranges[0]![0])}
              title="Drag to move this entry along the axis (← → nudge, Shift ×10)"
              onPointerDown={(e) => startNode(i, e)} onKeyDown={(e) => nodeKeys(i, e)} onFocus={() => props.onSelect(i)}>
              ▲ {fmtAt(0, body.entries[i]!.x ?? ranges[0]![0])}
            </span>
          ))}
        </div>
        <div class="pl-xl" aria-hidden="true">
          {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f} style={{ left: `${f * 100}%` }}>{fmtAt(0, denormalise(f, ranges[0]!))}</span>)}
        </div>
      </div>
    );
  };

  const axisName = (k: 0 | 1) => {
    const a = blend.axes[k];
    return !a ? "" : "voiceTime" in a ? "Voice time" : a.parameter;
  };
  const plane = () => {
    const edges = triangleEdges(pts);
    const tri = activeTriangle(weights);
    const P = (p: { x: number; y: number }) => [p.x * W, (1 - p.y) * W] as const;
    const inP = P({ x: input[0]!, y: input[1]! });
    const triangles = Math.max(0, edges.length - pts.length + 1);
    return (
      <div class="pl-plane-row">
        <div class="pl-plane-col">
          <div class="pl-plane-box">
            <span class="pl-yl" aria-hidden="true"><span>{fmtAt(1, ranges[1]![1])}</span><span class="pl-ym">{axisName(1)}</span><span>{fmtAt(1, ranges[1]![0])}</span></span>
            <svg ref={svg} class="pl-plane" viewBox={`0 0 ${W} ${W}`} role="group" aria-label="Blend plane"
              onPointerDown={(e) => svg.current && dragOn(e, svg.current, (f) => { scrub(0, f.x); scrub(1, f.y); }, () => {})}>
              <rect class="pl-lane-bg" x="0" y="0" width={W} height={W} />
              {/* Each entry's influence, sampled on a grid and blurred into a smooth field (BL2: no staircase of cells). */}
              <filter id={soft} x="0" y="0" width="1" height="1"><feGaussianBlur stdDeviation={W / 40} /></filter>
              <g class="pl-influence-field" filter={`url(#${soft})`}>
                {influenceGrid(pts, blend.fade === "layer" ? "linear" : blend.curve, weightCurvesOf(body.entries), 16).map((c, k) => (
                  <rect key={`h${k}`} class={`pl-influence ${series(c.entry)}`} x={(c.x - 1 / 32) * W} y={(1 - c.y - 1 / 32) * W} width={W / 16} height={W / 16} style={{ opacity: String(0.03 + 0.14 * c.weight) }} />
                ))}
              </g>
              {[0.25, 0.5, 0.75].map((g) => (
                <g key={g} class="pl-grid">
                  <line x1={g * W} x2={g * W} y1="0" y2={W} />
                  <line y1={g * W} y2={g * W} x1="0" x2={W} />
                </g>
              ))}
              {tri && <polygon class="pl-tri" points={tri.map((i) => P(pts[i]!).join(",")).join(" ")} />}
              {edges.map(([a, b]) => {
                const [x1, y1] = P(pts[a]!), [x2, y2] = P(pts[b]!);
                return <line key={`${a}-${b}`} class="pl-edge" x1={x1} y1={y1} x2={x2} y2={y2} />;
              })}
              {pts.map((p, i) => (weights[i] ?? 0) > 1e-3 && <circle key={`h${i}`} class={`pl-halo ${series(i)}`} cx={P(p)[0]} cy={P(p)[1]} r={24 + 60 * (weights[i] ?? 0)} />)}
              {pts.map((p, i) => weights[i]! > 1e-6 && <line key={`s${i}`} class={`pl-spoke ${series(i)}`} x1={inP[0]} y1={inP[1]} x2={P(p)[0]} y2={P(p)[1]} style={{ opacity: String(0.4 + 0.6 * weights[i]!) }} />)}
              {pts.map((p, i) => {
                const [x, y] = P(p);
                const name = entryName(body.entries[i]!, i);
                const w = Math.round((weights[i] ?? 0) * 100);
                const width = 60 + (name.length + String(w).length + 2) * 13;
                const left = Math.max(2, Math.min(W - width - 2, x - width / 2));
                const top = Math.max(2, Math.min(W - 46, y - 22));
                return (
                  <g key={i} class={`pl-node ${series(i)}${props.selected === i ? " selected" : ""}${hovered === i ? " hv" : ""}${w > 0 ? " hot" : " dim"}`} tabindex={writable ? 0 : -1} role="slider" aria-label={`${name} position`}
                    aria-valuenow={body.entries[i]!.x ?? 0} onPointerDown={(e) => startNode(i, e)} onKeyDown={(e) => nodeKeys(i, e)} onFocus={() => props.onSelect(i)}>
                    <rect class="pl-nd" x={left} y={top} width={width} height={44} rx={22} />
                    <circle class="pl-nd-dot" cx={left + 24} cy={top + 22} r={8} />
                    <text class="pl-node-name" x={left + 42} y={top + 31}>{name} <tspan class="pl-node-w">{w}%</tspan></text>
                  </g>
                );
              })}
              <circle class="pl-input-dot" cx={inP[0]} cy={inP[1]} r="13" />
            </svg>
          </div>
          <div class="pl-xl2" aria-hidden="true">
            {[0, 0.25, 0.5, 0.75, 1].map((f) => <span key={f}>{fmtAt(0, denormalise(f, ranges[0]!))}</span>)}
          </div>
          <div class="pl-xname" aria-hidden="true">{axisName(0)}</div>
        </div>
        <div class="pl-bnl" role="group" aria-label="Nodes">
          <div class="pl-bnh"><span class="pl-cap">Nodes</span><span class="pl-faint">{pts.length} {pts.length === 1 ? "node" : "nodes"} · {triangles} {triangles === 1 ? "triangle" : "triangles"}</span></div>
          {pts.map((_, i) => {
            const w = weights[i] ?? 0;
            return (
              <button key={i} type="button" class={`pl-bnr ${series(i)}${props.selected === i ? " on" : ""}`} aria-current={props.selected === i ? "true" : undefined}
                onMouseEnter={() => setHovered(i)} onMouseLeave={() => setHovered(null)} onFocus={() => setHovered(i)} onBlur={() => setHovered(null)} onClick={() => props.onSelect(i)} onDblClick={() => props.onOpen?.(i)}>
                <i />
                <span class="pl-nm">{entryName(body.entries[i]!, i)}</span>
                <span class={w > 1e-3 ? "pl-playing" : "pl-silent"}>{w > 1e-3 ? "Playing" : "Silent"}</span>
                <b>{w > 1e-3 ? `${Math.round(w * 100)}%` : "0"}</b>
              </button>
            );
          })}
        </div>
      </div>
    );
  };

  return (
    <div class="pl-blend">
      {body.entries.length === 0 ? <EmptyState compact title={`Add entries to place them on the ${twoD ? "plane" : "lane"}.`} /> : twoD ? plane() : lane()}
      {props.selected !== null && body.entries[props.selected] && <EntryShaping {...props} twoD={twoD} regionOf={regionOf} setRegion={setRegion} />}
      {!twoD && <EnvelopeEditor body={body} writable={writable} onEdit={onEdit} input={input[0] ?? 0} inputText={fmtAt(0, denormalise(input[0] ?? 0, ranges[0]!))} axis={axisName(0)} />}
    </div>
  );
}

/**
 * ADR 0350: the selected entry's shaping: its 1D region (Automatic or Custom, the four widths, each fade's shape, Reset
 * to automatic) and, secondary to the region, its weight curve (a preset, the full curve editor, Reset).
 */
function EntryShaping(props: BlendViewProps & { twoD: boolean; regionOf(i: number): { region: BlendRegion; explicit: boolean }; setRegion(i: number, r: BlendRegion | undefined, label: string): void }) {
  const { body, writable } = props;
  const i = props.selected!;
  const e = body.entries[i]!;
  const name = entryName(e, i);
  const blend = body.blend!;
  const { region, explicit } = props.regionOf(i);
  const def = blend.curve === "equalPower" ? "equalPower" : "linear";
  const field = (key: "start" | "end" | "fadeIn" | "fadeOut", label: string) => (
    <span class="pl-inline">
      <span class="pl-faint">{label}</span>
      <NumberBox class="pl-n56" label={`${name} ${label}`} value={region[key]} step={0.01} digits={3} disabled={!writable}
        onValue={(v) => props.setRegion(i, key === "start" || key === "end" ? dragRegion(region, key, v) : dragRegion(region, key, key === "fadeIn" ? region.start + v : region.end - v), `Region · ${name}`)} />
    </span>
  );
  const preset = WEIGHT_PRESETS.find((p) => JSON.stringify(p.curve()) === JSON.stringify(e.weightCurve))?.value ?? "custom";
  return (
    <Section title={`Shaping · ${name}`} hint={props.twoD ? "In 2D an entry's reach comes from where its point sits; its weight curve narrows or shapes its fade." : "Where this entry plays on the axis: its region and fades (drag the handles on the lane, ← → to nudge), and its weight curve."}>
      {!props.twoD && (
        <div class="pl-kv pl-region-fields">
          <span class="pl-field-label">Region</span>
          <span class="pl-inline pl-wrap">
            <span class="pl-faint">{explicit ? "Custom" : "Automatic (from its neighbours)"}</span>
            {field("start", "Start")}
            {field("fadeIn", "Fade in")}
            {field("fadeOut", "Fade out")}
            {field("end", "End")}
            <FadeShapeSelect label={`${name} fade-in shape`} value={region.shapeIn ?? def} disabled={!writable} onValue={(v) => props.setRegion(i, { ...region, shapeIn: v }, `Region · ${name}`)} />
            <FadeShapeSelect label={`${name} fade-out shape`} out value={region.shapeOut ?? def} disabled={!writable} onValue={(v) => props.setRegion(i, { ...region, shapeOut: v }, `Region · ${name}`)} />
            <button type="button" class="pl-small" disabled={!writable || !explicit} onClick={() => props.setRegion(i, undefined, `Reset region · ${name}`)}>Reset to automatic</button>
          </span>
        </div>
      )}
      <div class="pl-kv">
        <span class="pl-field-label">Weight curve</span>
        <span class="pl-inline">
          <SelectBox label={`${name} weight curve`} value={preset} disabled={!writable}
            options={[...WEIGHT_PRESETS.map((p) => ({ value: p.value, label: p.label })), ...(preset === "custom" ? [{ value: "custom", label: "Custom" }] : [])]}
            onValue={(v) => { const p = WEIGHT_PRESETS.find((x) => x.value === v); if (p) props.onEdit(`Weight curve · ${name}`, (b) => setEntryUse(b, i, { weightCurve: p.curve() })); }} />
          {props.onEditWeightCurve && <button type="button" class="pl-small" disabled={!writable} onClick={() => props.onEditWeightCurve!(i)}>Edit curve…</button>}
          <button type="button" class="pl-small" disabled={!writable || !e.weightCurve} onClick={() => props.onEdit(`Reset weight curve · ${name}`, (b) => setEntryUse(b, i, { weightCurve: undefined }))}>Reset</button>
        </span>
      </div>
    </Section>
  );
}

const ADSR_FIELDS: { key: keyof Adsr; label: string; unit: string }[] = [
  { key: "attackMs", label: "Attack", unit: "ms" },
  { key: "decayMs", label: "Decay", unit: "ms" },
  { key: "sustain", label: "Sustain", unit: "%" },
  { key: "releaseMs", label: "Release", unit: "ms" },
];

/** How long the preview holds the sustain before the release, ms. */
const HOLD_MS = 300;

/** The span an envelope preview shows, ms: the longer end's attack, decay, the hold and its release. */
function envelopeSpan(low: Adsr, high: Adsr): number {
  const one = (e: Adsr) => e.attackMs + e.decayMs + HOLD_MS + e.releaseMs;
  return Math.max(200, one(low), one(high));
}

/** An envelope's level along `span` ms, released after its attack, decay and the hold, as SVG points over 1000 × 100. */
function envelopePoints(e: Adsr, span: number, n = 120): string {
  const release = e.attackMs + e.decayMs + HOLD_MS;
  const pts: string[] = [];
  for (let k = 0; k <= n; k++) {
    const ms = (k / n) * span;
    pts.push(`${((ms / span) * 1000).toFixed(1)},${(100 - adsrLevel(e, ms, ms >= release ? release : null) * 92).toFixed(1)}`);
  }
  return pts.join(" ");
}

/**
 * The voice envelope (1D Blend): off, morph between the low and high ends by where the input sits, or per zone. A big
 * preview: the envelope at the input (filled), the low and high ends dashed, the release line; click or drag it to see
 * the level at a moment, double-click to clear. Then the Low end / High end cards.
 */
export function EnvelopeEditor(props: { readonly body: PlaylistBody; readonly writable: boolean; readonly input: number; readonly inputText: string; readonly axis: string; onEdit(label: string, edit: BodyEdit): void }) {
  const env = props.body.blend?.envelope;
  const box = useRef<HTMLDivElement>(null);
  const [at, setAt] = useState<number | null>(null);
  if (!env) return null;
  const names = props.body.entries.map((e, i) => entryName(e, i));
  const span = envelopeSpan(env.low, env.high);
  const now = lerpAdsr(env.low, env.high, Math.max(0, Math.min(1, props.input)));
  const release = now.attackMs + now.decayMs + HOLD_MS;
  const levelAt = at === null ? null : adsrLevel(now, at, at >= release ? release : null);
  const press = (e: PointerEvent) => {
    const el = box.current;
    if (!el) return;
    e.preventDefault();
    const doc = el.ownerDocument;
    const set = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      setAt(Math.max(0, Math.min(1, (ev.clientX - r.left) / Math.max(1, r.width))) * span);
    };
    const up = () => {
      doc.removeEventListener("pointermove", set);
      doc.removeEventListener("pointerup", up);
    };
    doc.addEventListener("pointermove", set);
    doc.addEventListener("pointerup", up);
    set(e);
  };
  const card = (which: "low" | "high") => (
    <div class="pl-zenv">
      <div class="pl-zenv-head"><b>{which === "low" ? "Low end" : "High end"}</b><span class="pl-faint">at {which === "low" ? names[0] ?? "the lowest entry" : names[names.length - 1] ?? "the highest entry"}</span></div>
      <div class="pl-adsr">
        {ADSR_FIELDS.map((f) => (
          <label key={f.key}>
            {f.label}
            <NumberBox label={`${which === "low" ? "Low" : "High"} end ${f.label}`} value={f.key === "sustain" ? env[which].sustain * 100 : env[which][f.key]} min={ADSR_LIMITS[f.key][0] * (f.key === "sustain" ? 100 : 1)} max={ADSR_LIMITS[f.key][1] * (f.key === "sustain" ? 100 : 1)} step={f.key === "sustain" ? 1 : 10} digits={0} disabled={!props.writable}
              onValue={(v) => props.onEdit(`Envelope ${f.label}`, (b) => setAdsr(b, which, { [f.key]: f.key === "sustain" ? v / 100 : v }))} />
          </label>
        ))}
      </div>
    </div>
  );
  return (
    <section class="pl-envelope" aria-label="Voice envelope">
      <div class="pl-env-head">
        <span class="pl-cap" title="Shapes each voice's level over voice time: morph between the low and high ends by where the input sits, or give each zone its own">Voice envelope</span>
        <span class="pl-gbadge">Voice time</span>
        <span class="pl-flex" />
        <SegmentedControl<"off" | "morph" | "zone"> size="small" look="fill" label="Envelope" value={env.mode}
          options={[{ value: "off", label: "Off", title: "No envelope: each voice plays at its weight" }, { value: "morph", label: `Morph by ${props.axis}`, title: "Morph between the low and high ends by where the input sits" }, { value: "zone", label: "Per zone", title: "Each zone gets its own envelope, between the two ends" }]}
          onChange={(m) => props.writable && props.onEdit(`Envelope: ${m}`, (b) => setEnvelopeMode(b, m))} />
      </div>
      {env.mode !== "off" && (
        <>
          <div ref={box} class="pl-envbig" role="img" aria-label={`Envelope at ${props.inputText}: attack ${Math.round(now.attackMs)} ms, decay ${Math.round(now.decayMs)} ms, sustain ${Math.round(now.sustain * 100)}%, release ${Math.round(now.releaseMs)} ms`}
            title="Click or drag to see the level at a moment; double-click to clear" onPointerDown={press} onDblClick={() => setAt(null)}>
            <svg viewBox="0 0 1000 100" preserveAspectRatio="none" aria-hidden="true">
              <polyline class="pl-env-ghost low" points={envelopePoints(env.low, span)} />
              <polyline class="pl-env-ghost high" points={envelopePoints(env.high, span)} />
              <polygon class="pl-env-fill" points={`0,100 ${envelopePoints(now, span)} 1000,100`} />
              <polyline class="pl-env-line" points={envelopePoints(now, span)} />
              <line class="pl-env-release" x1={(release / span) * 1000} x2={(release / span) * 1000} y1="0" y2="100" />
            </svg>
            <span class="pl-env-names"><span class="low">Low end · {names[0] ?? "—"}</span><span class="high">High end · {names[names.length - 1] ?? "—"}</span></span>
            <span class="pl-env-sum">At {props.inputText}: {Math.round(now.attackMs)} · {Math.round(now.decayMs)} · {Math.round(now.sustain * 100)}% · {Math.round(now.releaseMs)} ms</span>
            <span class="pl-env-rel" style={{ left: `${(release / span) * 100}%` }}>release</span>
            {at !== null && levelAt !== null && (
              <>
                <span class="pl-env-ph" style={{ left: `${(at / span) * 100}%` }} />
                <span class="pl-env-dot" style={{ left: `${(at / span) * 100}%`, top: `${100 - levelAt * 92}%` }} />
                <span class="pl-env-tag" style={{ left: `${(at / span) * 100}%` }}>{Math.round(at)} ms · {Math.round(levelAt * 100)}%</span>
              </>
            )}
          </div>
          <div class="pl-env-foot"><span>0 ms</span><span>{Math.round(span)} ms shown · looping entries: held until released (Trigger again to release)</span></div>
          <div class="pl-zenvs">
            {card("low")}
            {card("high")}
          </div>
        </>
      )}
    </section>
  );
}
