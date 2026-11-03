// The one module that imports xyflow's framework-free core, `@xyflow/system` (ADR 0046): panning
// and zooming the canvas, dragging nodes, drawing connections from ports, and wire curves. The
// rest of the Shader Graph panel is Preact and never sees xyflow's types, so an upgrade of this
// pinned, pre-1.0 package touches this file only.
//
// xyflow's core finds ports through DOM conventions: elements with the classes
// `myco-flow__handle`, `source` or `target`, `connectable` and `connectableend`, and the
// attributes `data-id` (`<flow>-<node>-<port>-<type>`), `data-nodeid` and `data-handleid`.
// `handleProps` gives a port element all of them.
import {
  ConnectionMode,
  PanOnScrollMode,
  Position,
  XYDrag,
  XYHandle,
  XYPanZoom,
  getBezierPath,
  pointToRendererPoint,
  type ConnectionState,
  type FinalConnectionState,
  type Handle,
  type InternalNodeBase,
  type NodeBase,
  type PanZoomInstance,
  type XYDragInstance,
} from "@xyflow/system";

const LIB = "myco";
export const NO_DRAG = "nodrag";
export const NO_PAN = "nopan";
export const NO_WHEEL = "nowheel";

export interface View {
  x: number;
  y: number;
  zoom: number;
}

export interface Point {
  x: number;
  y: number;
}

/** A node as xyflow needs it: position, size, selection, and its ports' centres relative to it. */
export interface CanvasNode {
  id: string;
  x: number;
  y: number;
  width: number;
  height: number;
  selected: boolean;
  inputs: { id: string; x: number; y: number }[];
  outputs: { id: string; x: number; y: number }[];
}

const HANDLE = 12;

function internalNodes(nodes: readonly CanvasNode[]): Map<string, InternalNodeBase> {
  const map = new Map<string, InternalNodeBase>();
  for (const n of nodes) {
    const handle = (p: { id: string; x: number; y: number }, type: "source" | "target"): Handle => ({
      id: p.id,
      nodeId: n.id,
      type,
      position: type === "source" ? Position.Right : Position.Left,
      x: p.x - HANDLE / 2,
      y: p.y - HANDLE / 2,
      width: HANDLE,
      height: HANDLE,
    });
    const userNode: NodeBase = { id: n.id, position: { x: n.x, y: n.y }, data: {}, selected: n.selected, width: n.width, height: n.height };
    map.set(n.id, {
      ...userNode,
      measured: { width: n.width, height: n.height },
      internals: {
        positionAbsolute: { x: n.x, y: n.y },
        z: 0,
        userNode,
        handleBounds: { source: n.outputs.map((p) => handle(p, "source")), target: n.inputs.map((p) => handle(p, "target")) },
      },
    });
  }
  return map;
}

/** The attributes and classes a port element needs for xyflow to find it. */
export function handleProps(flowId: string, nodeId: string, port: string, side: "input" | "output"): Record<string, string> {
  const type = side === "output" ? "source" : "target";
  return {
    class: `${LIB}-flow__handle ${type} connectable connectableend ${NO_DRAG}`,
    "data-id": `${flowId}-${nodeId}-${port}-${type}`,
    "data-nodeid": nodeId,
    "data-handleid": port,
  };
}

/** A canvas point (CSS pixels from the pane's top-left) in graph coordinates. */
export const toGraph = (p: Point, v: View): Point => pointToRendererPoint(p, [v.x, v.y, v.zoom]);

/** A wire's SVG path from an output at `from` to an input at `to`, in graph coordinates. */
export function wirePath(from: Point, to: Point): string {
  return getBezierPath({ sourceX: from.x, sourceY: from.y, sourcePosition: Position.Right, targetX: to.x, targetY: to.y, targetPosition: Position.Left })[0];
}

export interface PaneOptions {
  view: View;
  onView(view: View): void;
  onContextMenu(e: MouseEvent): void;
}

/** Pan with the middle or right mouse button, zoom with the wheel or a pinch. Left drags are left to box selection. */
export function createPane(dom: HTMLElement, o: PaneOptions): { setView(v: View): void; panBy(dx: number, dy: number): Promise<boolean>; destroy(): void } {
  const pz: PanZoomInstance = XYPanZoom({
    domNode: dom,
    minZoom: 0.2,
    maxZoom: 2.5,
    viewport: o.view,
    translateExtent: [
      [-Infinity, -Infinity],
      [Infinity, Infinity],
    ],
    onDraggingChange: () => undefined,
  });
  pz.update({
    noWheelClassName: NO_WHEEL,
    noPanClassName: NO_PAN,
    onPaneContextMenu: o.onContextMenu,
    preventScrolling: true,
    panOnScroll: false,
    panOnDrag: [1, 2],
    panOnScrollMode: PanOnScrollMode.Free,
    panOnScrollSpeed: 0.5,
    userSelectionActive: false,
    zoomOnPinch: true,
    zoomOnScroll: true,
    zoomOnDoubleClick: false,
    zoomActivationKeyPressed: false,
    lib: LIB,
    onTransformChange: ([x, y, zoom]) => o.onView({ x, y, zoom }),
    connectionInProgress: false,
    paneClickDistance: 0,
    selectionOnDrag: false,
  });
  return {
    setView: (v) => void pz.setViewport(v),
    panBy: async (dx, dy) => {
      const v = pz.getViewport();
      await pz.setViewport({ x: v.x - dx, y: v.y - dy, zoom: v.zoom });
      return dx !== 0 || dy !== 0;
    },
    destroy: () => pz.destroy(),
  };
}

export interface DragOptions {
  pane: HTMLElement;
  nodes(): readonly CanvasNode[];
  view(): View;
  panBy(dx: number, dy: number): Promise<boolean>;
  /** Live positions while dragging. */
  onMove(positions: Map<string, Point>): void;
  /** The drag ended (positions as last moved). */
  onEnd(positions: Map<string, Point>): void;
}

/** Make a node element draggable; dragging a selected node moves every selected node. */
export function createNodeDrag(el: HTMLElement, nodeId: string, o: DragOptions): { destroy(): void } {
  let last = new Map<string, Point>();
  const drag: XYDragInstance = XYDrag({
    getStoreItems: () => {
      const v = o.view();
      return {
        nodes: [],
        nodeLookup: internalNodes(o.nodes()),
        edges: [],
        nodeExtent: [
          [-Infinity, -Infinity],
          [Infinity, Infinity],
        ],
        snapGrid: [10, 10],
        snapToGrid: false,
        nodeOrigin: [0, 0],
        multiSelectionActive: false,
        domNode: o.pane,
        transform: [v.x, v.y, v.zoom],
        autoPanOnNodeDrag: true,
        nodesDraggable: true,
        selectNodesOnDrag: true, // selection is the panel's; xyflow mustn't clear it
        nodeDragThreshold: 2,
        panBy: ({ x, y }) => o.panBy(x, y),
        unselectNodesAndEdges: () => undefined,
        updateNodePositions: (items) => {
          last = new Map([...items].map(([id, item]) => [id, { x: item.position.x, y: item.position.y }]));
          o.onMove(last);
        },
      };
    },
    onDragStop: () => o.onEnd(last),
  });
  drag.update({ domNode: el, nodeId, noDragClassName: NO_DRAG, isSelectable: true });
  return { destroy: () => drag.destroy() };
}

/** A connection being drawn: where it starts (graph coordinates) and where the pointer or snapped port is. */
export interface DraftWire {
  from: Point;
  to: Point;
  /** True when the pointer is over a port the connection may end on. */
  valid: boolean;
}

export interface ConnectOptions {
  flowId: string;
  pane: HTMLElement;
  nodes(): readonly CanvasNode[];
  view(): View;
  panBy(dx: number, dy: number): Promise<boolean>;
  /** May an output (`node.port`) connect to an input? */
  canConnect(from: string, to: string): boolean;
  onDraft(draft: DraftWire | null): void;
  onConnect(from: string, to: string): void;
  /** The drag ended away from any port, at this canvas point (CSS pixels in the pane). */
  onDropInSpace(at: Point): void;
  /** The drag ended (after onConnect or onDropInSpace, if either). */
  onEnd(): void;
}

/** Start drawing a connection from a port element (on its mousedown). */
export function startConnection(e: MouseEvent, handleEl: Element, nodeId: string, port: string, side: "input" | "output", o: ConnectOptions): void {
  let current: ConnectionState<InternalNodeBase> | null = null;
  const nodeLookup = internalNodes(o.nodes());
  XYHandle.onPointerDown(e, {
    autoPanOnConnect: true,
    connectionMode: ConnectionMode.Strict,
    connectionRadius: 24,
    domNode: o.pane as HTMLDivElement,
    handleId: port,
    nodeId,
    isTarget: side === "input",
    nodeLookup,
    lib: LIB,
    flowId: o.flowId,
    updateConnection: (state) => {
      current = state;
      if (!state.inProgress) return o.onDraft(null);
      const v = o.view();
      o.onDraft({ from: state.from, to: toGraph(state.to, v), valid: state.isValid === true });
    },
    panBy: ({ x, y }) => o.panBy(x, y),
    cancelConnection: () => {
      current = null;
      o.onDraft(null);
      o.onEnd();
    },
    onConnect: (c) => {
      if (c.source && c.target && c.sourceHandle && c.targetHandle) o.onConnect(`${c.source}.${c.sourceHandle}`, `${c.target}.${c.targetHandle}`);
    },
    onConnectEnd: (_event, state: FinalConnectionState<InternalNodeBase>) => {
      if (!state.toHandle && current?.inProgress) o.onDropInSpace(state.pointer ?? current.pointer);
    },
    isValidConnection: (c) => !!c.sourceHandle && !!c.targetHandle && o.canConnect(`${c.source}.${c.sourceHandle}`, `${c.target}.${c.targetHandle}`),
    getTransform: () => {
      const v = o.view();
      return [v.x, v.y, v.zoom];
    },
    getFromHandle: () => nodeLookup.get(nodeId)?.internals.handleBounds?.[side === "output" ? "source" : "target"]?.find((h) => h.id === port) ?? null,
    handleDomNode: handleEl,
    dragThreshold: 2,
  });
}
