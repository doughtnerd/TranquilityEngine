// The blend-space editor's model (ADR 0373 "A blend-space editor: 1D track and 2D plot with samples, triangulation and a
// draggable preview point"): a blend space node's samples (its inputs with their coordinates, `coords`), their edits
// (move a sample, add one from another node, remove one) and the preview, the core's weights at a point
// (`blendSpaceGeometry.ts`, the same rule the runtime blends by). Edits are refused-or-next (ADR 0307).
import type { AnimGraph, GraphNode } from "../../../../engine/animation/animGraph";
import { accept, refuse, type EditResult } from "../../../../editor/sdk";
import { blendDims, connect, disconnect, nodeById, nodeTitle } from "./graphEditLogic";
import { triangulate, weights1D, weights2D, type Point2, type Triangulation } from "./blendSpaceGeometry";

/** One sample: the input node it plays and where it is. */
export interface BlendSample {
  readonly input: string;
  readonly label: string;
  readonly x: number;
  readonly y: number;
}

/** A blend space node's samples (coordinates the file lacks read as 0, as the compiler packs them). */
export function blendSamples(graph: AnimGraph, node: GraphNode): BlendSample[] {
  const dims = blendDims(node);
  const coords = Array.isArray(node.params.coords) ? (node.params.coords as readonly number[]) : [];
  return node.inputs.map((input, i) => {
    const n = nodeById(graph, input);
    return { input, label: n ? nodeTitle(n) : input, x: coords[dims * i] ?? 0, y: dims === 2 ? (coords[2 * i + 1] ?? 0) : 0 };
  });
}

/** The space's extent to plot: the samples' bounds and the preview point, padded (at least 1 wide). */
export function plotBounds(samples: readonly BlendSample[], preview?: Point2): { x0: number; x1: number; y0: number; y1: number } {
  const xs = [...samples.map((s) => s.x), ...(preview ? [preview[0]] : [])], ys = [...samples.map((s) => s.y), ...(preview ? [preview[1]] : [])];
  const pad = (lo: number, hi: number): [number, number] => {
    if (!Number.isFinite(lo)) return [-1, 1];
    const w = Math.max(1, hi - lo);
    return [lo - w * 0.1, hi + w * 0.1];
  };
  const [x0, x1] = pad(Math.min(...xs, 0), Math.max(...xs, 0));
  const [y0, y1] = pad(Math.min(...ys, 0), Math.max(...ys, 0));
  return { x0, x1, y0, y1 };
}

/** The triangulation the core builds for a 2D space (empty for 1D). */
export const blendTriangulation = (node: GraphNode, samples: readonly BlendSample[]): Triangulation =>
  blendDims(node) === 2 ? triangulate(samples.map((s) => [s.x, s.y])) : { triangles: [], hull: [] };

/** Each sample's weight at `point`, by the runtime's rule. */
export function previewWeights(node: GraphNode, samples: readonly BlendSample[], point: Point2): number[] {
  if (blendDims(node) === 1) return weights1D(samples.map((s) => s.x), point[0]);
  const pts = samples.map((s): Point2 => [s.x, s.y]);
  return weights2D(pts, triangulate(pts), point);
}

const coordsWith = (node: GraphNode, samples: readonly BlendSample[]): number[] =>
  samples.flatMap((s) => (blendDims(node) === 2 ? [s.x, s.y] : [s.x]));

const setCoords = (graph: AnimGraph, id: string, coords: number[]): AnimGraph => ({
  ...graph,
  nodes: graph.nodes.map((n) => (n.id === id ? { ...n, params: { ...n.params, coords } } : n)),
});

/** Sample `index` moved to (`x`, `y`). Non-finite values and a point another sample has are refused (the core would drop it). */
export function moveSample(graph: AnimGraph, id: string, index: number, x: number, y = 0): EditResult<AnimGraph> {
  const node = nodeById(graph, id);
  if (!node || !blendDims(node)) return refuse("that node isn't a blend space");
  const samples = blendSamples(graph, node);
  if (!samples[index]) return refuse("there's no such sample");
  if (!Number.isFinite(x) || !Number.isFinite(y)) return refuse("a coordinate is a number");
  const two = blendDims(node) === 2;
  const clash = samples.findIndex((s, i) => i !== index && s.x === x && (!two || s.y === y));
  if (clash >= 0) return refuse(`${samples[clash]!.label} is already at ${two ? `(${x}, ${y})` : x}; a sample there would get no weight`);
  const before = samples[index]!;
  if (before.x === x && (!two || before.y === y)) return accept(graph);
  return accept(setCoords(graph, id, coordsWith(node, samples.map((s, i) => (i === index ? { ...s, x, y } : s)))));
}

/** A sample playing node `input` added at (`x`, `y`): wired as the space's next input. */
export function addSample(graph: AnimGraph, id: string, input: string, x: number, y = 0): EditResult<AnimGraph> {
  const node = nodeById(graph, id);
  if (!node || !blendDims(node)) return refuse("that node isn't a blend space");
  const wired = connect(graph, input, id, node.inputs.length);
  if ("refused" in wired) return wired;
  return moveSample(wired.next, id, node.inputs.length, x, y);
}

/** Sample `index` removed (its input and coordinates). */
export function removeSample(graph: AnimGraph, id: string, index: number): EditResult<AnimGraph> {
  const node = nodeById(graph, id);
  if (!node || !blendDims(node)) return refuse("that node isn't a blend space");
  if (!node.inputs[index]) return refuse("there's no such sample");
  return accept(disconnect(graph, id, index));
}
