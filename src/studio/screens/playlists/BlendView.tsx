// A Blend's settings and views (the prototype's Blend view; ADR 0343 "Blend"): the axes (a numeric parameter or voice
// time), 1D or 2D, fade (crossfade or layer), curve (linear or equal power), while playing (Follow with glide, or Hold),
// then the 1D lane (each entry's weight polygon, its node with a ▲ handle to drag, ← → to nudge with Shift ×10) or the
// 2D plane (grid, Delaunay edges, the active triangle, spokes from the input to the entries playing, draggable nodes)
// with a nodes list, and the voice envelope. The input marker follows the test values; dragging on the background
// scrubs them. Weights are the engine's (`blendViewModel.ts`). A view over props.
import { useRef, useState } from "preact/hooks";
import type { Adsr, BlendAxis, PlaylistBody } from "../../../engine/audio/playlist/types";
import { isLabelled } from "../../../engine/audio/parameters";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { NumberBox, SelectBox, Section } from "../../../editor/ui/PanelFields";
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
import { ADSR_LIMITS, setAdsr, setAxis, setBlend, setDimensions, setEntryUse, setEnvelopeMode, voiceTimeAxis, type EditContext } from "./playlistEdits";
import { entryName } from "./playlistPaths";

export interface BlendViewProps {
  readonly body: PlaylistBody;
  readonly ctx: EditContext;
  readonly writable: boolean;
  readonly values: Readonly<Record<string, number>>;
  readonly selected: number | null;
  onEdit(label: string, edit: BodyEdit, drag?: boolean): void;
  onSelect(i: number): void;
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

const VOICE_TIME = "__voiceTime";
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
    end();
  };
  doc.addEventListener("pointermove", onMove);
  doc.addEventListener("pointerup", onUp);
  move(pointerFraction(e, el));
}

export function BlendView(props: BlendViewProps) {
  const { body, ctx, writable, onEdit } = props;
  const blend = body.blend;
  const [voiceTime, setVoiceTime] = useState(0);
  const svg = useRef<SVGSVGElement>(null);
  if (!blend) return null;
  const numeric = ctx.parameters.filter((p) => !isLabelled(p));
  const ranges = blend.axes.map((a) => axisRange(a, ctx.parameters));
  const pts = normalisedPoints(body.entries, ranges);
  const weights = liveWeights(body, ctx.parameters, props.values, voiceTime);
  const input = blend.axes.map((a, k) => normalise(axisInput(a, ctx.parameters, props.values, voiceTime), ranges[k]!));
  const twoD = blend.axes.length === 2;

  const axisOptions = [...numeric.map((p) => ({ value: p.name, label: p.name })), { value: VOICE_TIME, label: "Voice time" }];
  const axisValue = (a: BlendAxis) => ("voiceTime" in a ? VOICE_TIME : a.parameter);
  const pickAxis = (k: 0 | 1, v: string) => onEdit("Change setting", (b) => setAxis(b, k, v === VOICE_TIME ? voiceTimeAxis("voiceTime" in blend.axes[k]! ? (blend.axes[k] as { voiceTime: number }).voiceTime : 2) : { parameter: v }, ctx));
  const axisRow = (k: 0 | 1) => {
    const a = blend.axes[k]!;
    return (
      <span class="pl-inline">
        <SelectBox label={k === 0 ? "Blend X axis" : "Blend Y axis"} value={axisValue(a)} disabled={!writable} options={axisOptions} onValue={(v) => pickAxis(k, v)} />
        {"voiceTime" in a && (
          <>
            <NumberBox label="Voice time length" value={a.voiceTime} min={0.2} max={30} step={0.1} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setAxis(b, k, voiceTimeAxis(v), ctx))} />
            <span class="pl-unit">s</span>
          </>
        )}
      </span>
    );
  };

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
  const trapezoid = (r: BlendRegion) => `${lx(r.start)},${H1} ${lx(r.start + r.fadeIn)},8 ${lx(r.end - r.fadeOut)},8 ${lx(r.end)},${H1}`;

  const lane = () => {
    const curves = laneCurves(pts.map((p) => p.x), blend.fade, blend.curve, 101, regionsOf(body.entries, ranges[0]!), weightCurvesOf(body.entries));
    const sel = props.selected !== null && body.entries[props.selected] ? props.selected : null;
    const selRegion = sel !== null ? regionOf(sel) : null;
    return (
      <svg ref={svg} class="pl-lane" viewBox={`0 0 ${W} ${H1 + 24}`} preserveAspectRatio="none" role="group" aria-label="Blend lane"
        onPointerDown={(e) => svg.current && e.target === e.currentTarget && dragOn(e, svg.current, (f) => scrub(0, f.x), () => {})}>
        <rect class="pl-lane-bg" x="0" y="0" width={W} height={H1} onPointerDown={(e) => svg.current && dragOn(e, svg.current, (f) => scrub(0, f.x), () => {})} />
        {body.entries.map((e, i) => e.region && <polygon key={`r${i}`} class={`pl-region ${series(i)}`} points={trapezoid(e.region)} />)}
        {curves.map((c, i) => (
          <polygon key={i} class={`pl-poly ${series(i)}${props.selected === i ? " selected" : ""}`} points={`0,${H1} ${c.map(([x, w]) => `${x * W},${H1 - w * (H1 - 8)}`).join(" ")} ${W},${H1}`} />
        ))}
        {sel !== null && selRegion && (
          <g class={`pl-region-edit ${series(sel)}${selRegion.explicit ? "" : " derived"}`}>
            <polygon class="pl-region-outline" points={trapezoid(selRegion.region)} />
            {HANDLES.map((h) => {
              const at = handleAt(selRegion.region, h.id);
              const top = h.id === "fadeIn" || h.id === "fadeOut";
              return (
                <rect key={h.id} class="pl-region-handle" x={lx(at) - 5} y={top ? 2 : H1 - 12} width="10" height="12" tabIndex={writable ? 0 : -1} role="slider"
                  aria-label={`${entryName(body.entries[sel]!, sel)} ${h.label}`} aria-valuenow={at}
                  onPointerDown={(e) => startHandle(sel, h.id, e)} onKeyDown={(e) => handleKeys(sel, h.id, e)} />
              );
            })}
          </g>
        )}
        <line class="pl-input" x1={input[0]! * W} x2={input[0]! * W} y1="0" y2={H1} />
        {pts.map((p, i) => (
          <g key={i} class={`pl-node ${series(i)}${props.selected === i ? " selected" : ""}`} tabIndex={writable ? 0 : -1} role="slider" aria-label={`${entryName(body.entries[i]!, i)} position`}
            aria-valuenow={body.entries[i]!.x ?? 0} onPointerDown={(e) => startNode(i, e)} onKeyDown={(e) => nodeKeys(i, e)} onFocus={() => props.onSelect(i)}>
            <circle cx={p.x * W} cy={H1 - weights[i]! * (H1 - 8)} r="6" />
            <path d={`M${p.x * W - 7},${H1 + 18} L${p.x * W},${H1 + 6} L${p.x * W + 7},${H1 + 18} Z`} />
          </g>
        ))}
      </svg>
    );
  };

  const plane = () => {
    const edges = triangleEdges(pts);
    const tri = activeTriangle(weights);
    const P = (p: { x: number; y: number }) => [p.x * W, (1 - p.y) * W] as const;
    const inP = P({ x: input[0]!, y: input[1]! });
    return (
      <svg ref={svg} class="pl-plane" viewBox={`0 0 ${W} ${W}`} role="group" aria-label="Blend plane"
        onPointerDown={(e) => svg.current && dragOn(e, svg.current, (f) => { scrub(0, f.x); scrub(1, f.y); }, () => {})}>
        <rect class="pl-lane-bg" x="0" y="0" width={W} height={W} />
        {influenceGrid(pts, blend.fade === "layer" ? "linear" : blend.curve, weightCurvesOf(body.entries), 16).map((c, k) => (
          <rect key={`h${k}`} class={`pl-influence ${series(c.entry)}`} x={(c.x - 1 / 32) * W} y={(1 - c.y - 1 / 32) * W} width={W / 16} height={W / 16} style={{ opacity: String(0.06 + 0.3 * c.weight) }} />
        ))}
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
        {pts.map((p, i) => weights[i]! > 1e-6 && <line key={`s${i}`} class="pl-spoke" x1={inP[0]} y1={inP[1]} x2={P(p)[0]} y2={P(p)[1]} style={{ opacity: String(0.25 + 0.75 * weights[i]!) }} />)}
        {pts.map((p, i) => (
          <g key={i} class={`pl-node ${series(i)}${props.selected === i ? " selected" : ""}`} tabIndex={writable ? 0 : -1} role="slider" aria-label={`${entryName(body.entries[i]!, i)} position`}
            aria-valuenow={body.entries[i]!.x ?? 0} onPointerDown={(e) => startNode(i, e)} onKeyDown={(e) => nodeKeys(i, e)} onFocus={() => props.onSelect(i)}>
            <circle cx={P(p)[0]} cy={P(p)[1]} r={10 + 8 * (weights[i] ?? 0)} />
          </g>
        ))}
        <circle class="pl-input-dot" cx={inP[0]} cy={inP[1]} r="9" />
      </svg>
    );
  };

  return (
    <div class="pl-blend">
      <div class="pl-blend-settings">
        <div class="pl-kv"><span class="pl-field-label">Axes</span><SegmentedControl<"1" | "2"> size="small" label="Blend dimensions" value={twoD ? "2" : "1"} options={[{ value: "1", label: "1D" }, { value: "2", label: "2D" }]} onChange={(v) => writable && onEdit("Change setting", (b) => setDimensions(b, v === "2" ? 2 : 1, ctx))} /></div>
        <div class="pl-kv"><span class="pl-field-label">{twoD ? "X" : "Input"}</span>{axisRow(0)}</div>
        {twoD && <div class="pl-kv"><span class="pl-field-label">Y</span>{axisRow(1)}</div>}
        <div class="pl-kv"><span class="pl-field-label">Fade</span><SegmentedControl<"crossfade" | "layer"> size="small" label="Fade" value={blend.fade} options={[{ value: "crossfade", label: "Crossfade", title: "Neighbouring entries crossfade" }, { value: "layer", label: "Layer", title: "Entries fade in and stay" }]} onChange={(v) => writable && onEdit("Change setting", (b) => setBlend(b, { fade: v }))} /></div>
        <div class="pl-kv"><span class="pl-field-label">Curve</span><SegmentedControl<"linear" | "equalPower"> size="small" label="Curve" value={blend.curve} options={[{ value: "linear", label: "Linear" }, { value: "equalPower", label: "Equal power" }]} onChange={(v) => writable && onEdit("Change setting", (b) => setBlend(b, { curve: v }))} /></div>
        <div class="pl-kv">
          <span class="pl-field-label">While playing</span>
          <span class="pl-inline">
            <SegmentedControl<"follow" | "hold"> size="small" label="While playing" value={blend.follow === "hold" ? "hold" : "follow"} options={[{ value: "follow", label: "Follow", title: "The playing voice follows the value, smoothed by Glide" }, { value: "hold", label: "Hold", title: "The voice keeps the value it started with" }]}
              onChange={(v) => writable && onEdit(`While playing: ${v === "hold" ? "Hold" : "Follow"}`, (b) => setBlend(b, { follow: v === "hold" ? "hold" : { glideMs: typeof blend.follow === "object" ? blend.follow.glideMs : 120 } }))} />
            {blend.follow !== "hold" && (
              <>
                <NumberBox label="Glide" value={blend.follow.glideMs} min={0} max={5000} step={10} digits={0} disabled={!writable} onValue={(v) => onEdit("Glide", (b) => setBlend(b, { follow: { glideMs: v } }))} />
                <span class="pl-unit">ms glide</span>
              </>
            )}
          </span>
        </div>
      </div>
      {body.entries.length === 0 ? <p class="pl-note">Add entries to place them on the {twoD ? "plane" : "lane"}.</p> : twoD ? plane() : lane()}
      {body.entries.length > 0 && (
        <div class="pl-table pl-nodes" role="table" aria-label="Nodes">
          <div class="pl-tr pl-th" role="row"><span>Entry</span><span>{twoD ? "X" : "Position"}</span>{twoD && <span>Y</span>}<span>Weight now</span></div>
          {body.entries.map((e, i) => (
            <div key={i} role="row" class={`pl-tr${props.selected === i ? " selected" : ""}`} onClick={() => props.onSelect(i)}>
              <span class={`pl-swatch ${series(i)}`}>{entryName(e, i)}</span>
              <NumberBox label={`${entryName(e, i)} x`} value={e.x ?? ranges[0]![0]} min={ranges[0]![0]} max={ranges[0]![1]} step={(ranges[0]![1] - ranges[0]![0]) / 100} digits={3} disabled={!writable} onValue={(v) => onEdit(`Move ${entryName(e, i)}`, (b) => setEntryUse(b, i, { x: v }))} />
              {twoD && <NumberBox label={`${entryName(e, i)} y`} value={e.y ?? ranges[1]![0]} min={ranges[1]![0]} max={ranges[1]![1]} step={(ranges[1]![1] - ranges[1]![0]) / 100} digits={3} disabled={!writable} onValue={(v) => onEdit(`Move ${entryName(e, i)}`, (b) => setEntryUse(b, i, { y: v }))} />}
              <span class="pl-num-text">{((weights[i] ?? 0) * 100).toFixed(0)} %</span>
            </div>
          ))}
        </div>
      )}
      {props.selected !== null && body.entries[props.selected] && <EntryShaping {...props} twoD={twoD} regionOf={regionOf} setRegion={setRegion} />}
      {!twoD && <EnvelopeEditor body={body} writable={writable} onEdit={onEdit} />}
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
      <NumberBox label={`${name} ${label}`} value={region[key]} step={0.01} digits={3} disabled={!writable}
        onValue={(v) => props.setRegion(i, key === "start" || key === "end" ? dragRegion(region, key, v) : dragRegion(region, key, key === "fadeIn" ? region.start + v : region.end - v), `Region · ${name}`)} />
    </span>
  );
  const preset = WEIGHT_PRESETS.find((p) => JSON.stringify(p.curve()) === JSON.stringify(e.weightCurve))?.value ?? "custom";
  return (
    <Section title={`Shaping · ${name}`} note={props.twoD ? "In 2D an entry's reach comes from where its point sits; its weight curve narrows or shapes its fade." : "Where this entry plays on the axis: its region and fades (drag the handles on the lane, ← → to nudge), and its weight curve."}>
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
  { key: "attackMs", label: "A", unit: "ms" },
  { key: "decayMs", label: "D", unit: "ms" },
  { key: "sustain", label: "S", unit: "%" },
  { key: "releaseMs", label: "R", unit: "ms" },
];

/** The ADSR shape as an SVG path over a 0..1000 × 0..60 box (hold drawn as a fixed segment). */
function adsrPath(e: Adsr): string {
  const total = e.attackMs + e.decayMs + 400 + e.releaseMs || 1;
  const x = (ms: number) => (ms / total) * 1000;
  const y = (lvl: number) => 60 - lvl * 56;
  const a = x(e.attackMs), d = a + x(e.decayMs), h = d + x(400);
  return `M0,60 L${a},${y(1)} L${d},${y(e.sustain)} L${h},${y(e.sustain)} L1000,60`;
}

/** The voice envelope (1D Blend): off, morph between low and high by the input, or per zone. */
export function EnvelopeEditor(props: { readonly body: PlaylistBody; readonly writable: boolean; onEdit(label: string, edit: BodyEdit): void }) {
  const env = props.body.blend?.envelope;
  if (!env) return null;
  const row = (which: "low" | "high") => (
    <div class="pl-adsr">
      <span class="pl-field-label">{which === "low" ? "Low end" : "High end"}</span>
      {ADSR_FIELDS.map((f) => (
        <span class="pl-inline" key={f.key}>
          <span class="pl-faint">{f.label}</span>
          <NumberBox label={`${which} ${f.label}`} value={f.key === "sustain" ? env[which].sustain * 100 : env[which][f.key]} min={ADSR_LIMITS[f.key][0] * (f.key === "sustain" ? 100 : 1)} max={ADSR_LIMITS[f.key][1] * (f.key === "sustain" ? 100 : 1)} step={f.key === "sustain" ? 1 : 10} digits={0} disabled={!props.writable}
            onValue={(v) => props.onEdit(`Envelope ${f.label}`, (b) => setAdsr(b, which, { [f.key]: f.key === "sustain" ? v / 100 : v }))} />
        </span>
      ))}
      <svg class="pl-adsr-shape" viewBox="0 0 1000 60" preserveAspectRatio="none" aria-hidden="true"><path d={adsrPath(env[which])} /></svg>
    </div>
  );
  return (
    <Section title="Voice envelope" note="Shapes each voice's level: morph between the low and high ends by where the input sits, or give each zone its own (Zone).">
      <SegmentedControl<"off" | "morph" | "zone"> size="small" label="Envelope" value={env.mode} options={[{ value: "off", label: "Off" }, { value: "morph", label: "Morph" }, { value: "zone", label: "Zone" }]} onChange={(m) => props.writable && props.onEdit(`Envelope: ${m}`, (b) => setEnvelopeMode(b, m))} />
      {env.mode !== "off" && (
        <>
          {row("low")}
          {row("high")}
        </>
      )}
    </Section>
  );
}

