// What the Particle Graph's systems, contexts, blocks and nodes need from the editor around them
// (ADR 0060), passed down through a Preact context rather than through every component.
import { createContext } from "preact";
import { useContext } from "preact/hooks";
import type { ContextKind, GraphNode, ParticleGraph } from "../../../../../engine/scene/particleGraph";
import type { PortType, Rate } from "../../../../../engine/scene/particleNodes";
import type { AssetResolver } from "../../../../../engine/scene/particleSubgraphs";
import type { AssetMeta } from "../../particleGraph/assetDocs";
import type { ProblemIndex } from "../../particleGraph/problems";

/** Where a dragged block would land. */
export interface BlockDrop {
  system: string;
  kind: ContextKind;
  /** The output (0 = main, 1 and up = extra outputs) when `kind` is "output"; 0 otherwise. */
  output: number;
  /** The slot in the context's list as shown (the dragged block included). */
  index: number;
}

export interface GraphEditorApi {
  graph: ParticleGraph;
  readOnly: boolean;
  /** Prefix of the port elements' `data-id` (xyflow). */
  flowId: string;
  /** Apply an edit (undoable, saved). */
  commit(next: ParticleGraph): void;
  /** Value-wire target → its source (`s1.b2.rate` → `n1.out`). */
  wired: ReadonlyMap<string, string>;
  /** Event targets (`s1.start`) that have a wire. */
  eventTargets: ReadonlySet<string>;
  /** Event sources (`s1.b4`, `n2`) that have a wire. */
  eventSources: ReadonlySet<string>;
  problems: ProblemIndex;
  /** The selected block (`system.block`), if any. */
  selectedBlock: string | null;
  selectBlock(key: string | null): void;
  /** A pointer-down on a port: start (or pick up) a wire. `owner` is the system or node id. */
  onPortDown(e: MouseEvent, owner: string, port: string, side: "input" | "output"): void;
  /** Open the block search for a context, at a point on the screen. */
  openBlockSearch(system: string, kind: ContextKind, output: number, client: { x: number; y: number }): void;
  /** Start dragging a block by its handle. */
  startBlockDrag(e: PointerEvent, system: string, block: string): void;
  /** The block being dragged (`system.block`) and where it would land. */
  draggingBlock: string | null;
  blockDrop: BlockDrop | null;
  /** Project assets offered by the pickers (`asset:` references). */
  assets: { images: string[]; materials: string[]; meshes: string[]; subgraphs: string[]; blocks: string[] };
  /** Reads a project asset's JSON by `asset:` reference (sub-graph and block ports come from it). */
  resolve: AssetResolver;
  /** Set when the open file is a sub-graph or custom block asset rather than an effect. */
  assetDoc: AssetMeta | null;
  /** The value type of a node's output port (sub-graph outputs from their assets). */
  typeOf(node: GraphNode, port: string): PortType | null;
  /** The rate of a wire source (`node.port`), seeing through sub-graphs. */
  rateOf(ref: string): Rate;
  /** A short name for a wire's source, shown on the input it feeds. */
  sourceLabel(from: string): string;
  /** The zoom, for drags measured in screen pixels. */
  zoom(): number;
}

export const GraphEditorContext = createContext<GraphEditorApi | null>(null);

export function useGraphEditor(): GraphEditorApi {
  const api = useContext(GraphEditorContext);
  if (!api) throw new Error("useGraphEditor outside the Particle Graph editor");
  return api;
}
