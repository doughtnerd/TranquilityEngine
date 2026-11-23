// The blend-space editor (ADR 0373 "A blend-space editor: 1D track and 2D plot with samples, triangulation and a draggable
// preview point"): the samples on a track (1D) or a plot (2D) with the core's triangulation, each sample draggable (one
// undo step per drag), and a preview point you drag to see every sample's weight by the runtime's rule
// (`blendSpaceLogic.ts`). Below, the samples as rows with their coordinates, and a row to add one from another node.
import { useRef, useState } from "preact/hooks";
import type { AnimGraph, GraphNode } from "../../../../engine/animation/animGraph";
import type { EditResult } from "../../../../editor/sdk";
import type { Point2 } from "./blendSpaceGeometry";
import { addSample, blendSamples, blendTriangulation, moveSample, plotBounds, previewWeights, removeSample } from "./blendSpaceLogic";
import { blendDims, nodeTitle, reaches } from "./graphEditLogic";

export interface BlendSpaceEditorProps {
  graph: AnimGraph;
  node: GraphNode;
  apply(result: EditResult<AnimGraph>, label: string): void;
  readOnly?: boolean;
  /** The preview point to start with (default: the middle of the samples). */
  preview?: Point2;
}

const W = 260, H = 200, PAD = 14;

const fmt = (n: number) => (Math.abs(n) >= 100 ? n.toFixed(0) : n.toFixed(2).replace(/\.?0+$/, "") || "0");

export function BlendSpaceEditor(props: BlendSpaceEditorProps) {
  const { graph, node, apply, readOnly = false } = props;
  const dims = blendDims(node);
  const samples = blendSamples(graph, node);
  const [preview, setPreview] = useState<Point2>(() => props.preview ?? [samples.length ? samples.reduce((s, x) => s + x.x, 0) / samples.length : 0, samples.length ? samples.reduce((s, x) => s + x.y, 0) / samples.length : 0]);
  /** A sample being dragged and where it is drawn until released. */
  const [drag, setDrag] = useState<{ index: number; at: Point2 } | null>(null);
  const svg = useRef<SVGSVGElement>(null);
  const shown = samples.map((s, i) => (drag?.index === i ? { ...s, x: drag.at[0], y: drag.at[1] } : s));
  const b = plotBounds(samples, preview);
  const h = dims === 2 ? H : 60;
  const sx = (x: number) => PAD + ((x - b.x0) / (b.x1 - b.x0)) * (W - 2 * PAD);
  const sy = (y: number) => (dims === 2 ? h - PAD - ((y - b.y0) / (b.y1 - b.y0)) * (h - 2 * PAD) : h / 2);
  const toSpace = (e: PointerEvent): Point2 => {
    const r = svg.current!.getBoundingClientRect();
    const px = ((e.clientX - r.left) / r.width) * W, py = ((e.clientY - r.top) / r.height) * h;
    const x = b.x0 + ((px - PAD) / (W - 2 * PAD)) * (b.x1 - b.x0);
    const y = dims === 2 ? b.y0 + ((h - PAD - py) / (h - 2 * PAD)) * (b.y1 - b.y0) : 0;
    const snap = (v: number) => Math.round(v * 100) / 100;
    return [snap(x), snap(y)];
  };
  const weights = previewWeights(node, shown, preview);
  const tri = blendTriangulation(node, shown);

  const dragPoint = (e: PointerEvent, onMove: (p: Point2) => void, onEnd: (p: Point2) => void) => {
    if (e.button !== 0) return;
    e.stopPropagation();
    const el = e.currentTarget as Element;
    el.setPointerCapture(e.pointerId);
    let last = toSpace(e);
    const move = (m: PointerEvent) => { last = toSpace(m); onMove(last); };
    const up = () => { el.removeEventListener("pointermove", move as EventListener); el.removeEventListener("pointerup", up); onEnd(last); };
    el.addEventListener("pointermove", move as EventListener);
    el.addEventListener("pointerup", up);
  };

  const label = nodeTitle(node);
  const candidates = graph.nodes.filter((n) => n.id !== node.id && !reaches(graph, n.id, node.id));
  return (
    <div class="ag-blendspace" role="group" aria-label={`Blend space ${label}`}>
      <div class="ag-section-head"><span>{dims === 2 ? "2D blend space" : "1D blend space"}</span><span class="ag-muted">drag the samples, or the preview point to see the weights</span></div>
      <svg
        ref={svg}
        class="ag-plot"
        viewBox={`0 0 ${W} ${h}`}
        width={W}
        height={h}
        role="img"
        aria-label={`${label} samples`}
        onPointerDown={(e) => { if (e.target === svg.current) { const p = toSpace(e as unknown as PointerEvent); setPreview(p); } }}
      >
        {dims === 1 && <line class="ag-plot-axis" x1={PAD} x2={W - PAD} y1={h / 2} y2={h / 2} />}
        {dims === 2 && <rect class="ag-plot-frame" x={PAD} y={PAD} width={W - 2 * PAD} height={h - 2 * PAD} />}
        {tri.triangles.map((t, k) => (
          <polygon key={k} class="ag-plot-tri" points={t.map((i) => `${sx(shown[i]!.x)},${sy(shown[i]!.y)}`).join(" ")} />
        ))}
        {shown.map((s, i) => (
          <g key={i} class="ag-sample" data-sample={i}>
            <circle cx={sx(s.x)} cy={sy(s.y)} r={6} class={`ag-sample-dot${weights[i]! > 0 ? " weighted" : ""}`}
              aria-label={`Sample ${s.label} at ${fmt(s.x)}${dims === 2 ? `, ${fmt(s.y)}` : ""}`}
              onPointerDown={(e) => !readOnly && dragPoint(e as unknown as PointerEvent, (p) => setDrag({ index: i, at: p }), (p) => { setDrag(null); apply(moveSample(graph, node.id, i, p[0], p[1]), `Move sample ${s.label}`); })} />
            <text x={sx(s.x) + 8} y={sy(s.y) - 8} class="ag-sample-label">{s.label}</text>
          </g>
        ))}
        <g class="ag-preview" aria-label={`Preview point at ${fmt(preview[0])}${dims === 2 ? `, ${fmt(preview[1])}` : ""}`}>
          <circle cx={sx(preview[0])} cy={sy(preview[1])} r={5} onPointerDown={(e) => dragPoint(e as unknown as PointerEvent, setPreview, setPreview)} />
        </g>
      </svg>
      <table class="ag-table" aria-label={`${label} samples and weights`}>
        <thead><tr><th>Sample</th><th>x</th>{dims === 2 && <th>y</th>}<th>Weight</th><th /></tr></thead>
        <tbody>
          {samples.map((s, i) => (
            <tr key={i} data-sample-row={i}>
              <td>{s.label}</td>
              <td><input type="number" step="any" aria-label={`${s.label} x`} value={s.x} disabled={readOnly} onChange={(e) => apply(moveSample(graph, node.id, i, (e.currentTarget as HTMLInputElement).valueAsNumber, s.y), `Move sample ${s.label}`)} /></td>
              {dims === 2 && <td><input type="number" step="any" aria-label={`${s.label} y`} value={s.y} disabled={readOnly} onChange={(e) => apply(moveSample(graph, node.id, i, s.x, (e.currentTarget as HTMLInputElement).valueAsNumber), `Move sample ${s.label}`)} /></td>}
              <td><span class="ag-weight" aria-label={`${s.label} weight`}><span class="ag-weight-bar" style={{ width: `${Math.round(weights[i]! * 100)}%` }} />{weights[i]!.toFixed(2)}</span></td>
              <td><button class="icon" aria-label={`Remove sample ${s.label}`} disabled={readOnly} onClick={() => apply(removeSample(graph, node.id, i), `Remove sample ${s.label}`)}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <label class="ag-add-row">
        <span>Add a sample at the preview point:</span>
        <select aria-label={`Add a sample to ${label}`} value="" disabled={readOnly || candidates.length === 0} onChange={(e) => {
          const id = (e.currentTarget as HTMLSelectElement).value;
          if (id) apply(addSample(graph, node.id, id, preview[0], preview[1]), `Add sample to ${label}`);
        }}>
          <option value="">…</option>
          {candidates.map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)}</option>)}
        </select>
      </label>
    </div>
  );
}
