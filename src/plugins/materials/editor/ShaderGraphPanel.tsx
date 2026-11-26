import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { MaterialPreview, NodePreviewRenderer } from "../../../engine/editor";
import { compileShaderGraph, nodePreviewGraph, shaderGraphListing, type CompiledShaderGraph } from "../../../engine/render/shaderGraph/compile";
import { NODES, nodeDef, type PortDef, type SettingDef, type ValueType } from "../../../engine/render/shaderGraph/nodes";
import { GRAPH_PREVIEW_MESHES, GRAPH_PROPERTY_TYPES, NODE_PREVIEW_SHAPES, nodePreviewShape, type NodePreviewShape, isPortName, portRef, splitPortRef, type CustomFunction, type FunctionPort, type GraphGroup, type GraphNode, type GraphPreviewMesh, type GraphPropertyType, type InputValue, type ShaderGraph } from "../../../engine/scene/shaderGraph";
import {
  addNode,
  shaderGraphEdits,
  addKeyword,
  addSubGraphOutput,
  defaultFunction,
  freePortName,
  removeSubGraphOutput,
  renameSubGraphOutput,
  setFunction,
  setPreview,
  setGraphPreviewMesh,
  setGraphPreviewShape,
  setNodePreviewShape,
  setSubGraphOutputType,
  whyNotPortName,
  categoryRank,
  connect,
  disconnect,
  firstInputFor,
  firstOutputFor,
  moveNodes,
  removeKeyword,
  renameKeyword,
  setKeyword,
  whyNotKeywordName,
  setGraphOptions,
  setInput,
  setPropertyType,
  setSetting,
  shaderWiring,
} from "./shaderGraph/graphEdit";
import { HEADER, PREVIEW, ROW, inlineFields, nodeBox, nodeTitle, portOffset, settingValue, type NodeBox } from "./shaderGraph/nodeLayout";
import { createMaterialForGraph, SHADER_GRAPH_PANEL, shaderGraphDocument } from "./shaderGraphAssets";
import { shaderFindItems } from "./shaderGraph/graphSearch";
import { PropertyValue, TEXTURE_SLOT, numberValue } from "./ShaderPropertyValue";
import { Color } from "../../../engine";
import { AssetPicker, ColorField, editor, type EditorProject, type ValueReport, NO_DRAG, NO_PAN, NO_WHEEL, NoteView, NodeSearchPopup, Minimap, SelectionBox, GraphFindBox, WireRefusal, handleProps, px, toGraph, useGraphCanvas, useGraphFind, useGraphSearch, useGraphSelection, useGraphWiring, useNodeDrag, usePreviewCardSize, GraphPreviewCard, wirePath, type CanvasNode, type GraphDragHooks, type Point, type SearchItem, Panel, EmptyState } from "../../../editor/sdk";
import "../../../editor/graph/graph.css";
import "./shaderGraph.css";

/** What a dropped connection or the node search connects a new node to. */
type Pending = { side: "output" | "input"; ref: string; type: ValueType | "dynamic" } | null;

/** The Shader Graph panel (ADR 0046): the graph open from the Assets panel, or how to open one. */
export function ShaderGraphPanel() {
  const path = editor.assets.openIn(SHADER_GRAPH_PANEL);
  const project = editor.project.current;
  if (!project) return <Panel><EmptyState compact title="No project open" /></Panel>;
  if (!path || !project.files.includes(path)) {
    return (
      <Panel>
        <EmptyState
          compact
          title="Double-click a shader graph (*.shadergraph.json) in the Assets panel to edit it here."
          action={{ label: "New Shader Graph", disabled: !project.canSave, run: () => void editor.assets.create("shadergraph").then((made) => made && editor.assets.open(made)) }}
        />
      </Panel>
    );
  }
  return (
    <Panel>
      <GraphEditor key={path} project={project} path={path} />
    </Panel>
  );
}

const cssType = (t: ValueType | "dynamic") => `t-${t === "dynamic" ? "float" : t}`;

function GraphEditor(props: { project: EditorProject; path: string }) {
  const { project, path } = props;
  editor.project.version; // the file list changes with it
  // The graph's asset document (ADR 0134) owns saving, undo and redo, the read-only refusal and
  // changes made outside the panel; selection, the view and the previews stay here.
  const doc = shaderGraphDocument(project, path);
  const readOnly = doc.readOnly;
  const graph = doc.value.value;
  const parseProblems = doc.problems.value.map((p) => p.message);
  useEffect(() => () => void doc.flush(), [doc]); // write a pending drag or value change when the panel closes
  const [selectedEdge, setSelectedEdge] = useState<string | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [maximized, setMaximized] = useState(false);
  const [shaderError, setShaderError] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(true);
  const [previewSize, setPreviewSize] = usePreviewCardSize("shader-graph", { w: 260, h: 200 });

  const root = useRef<HTMLDivElement>(null);
  // Selection, box select, item drags and the shared shortcuts (ADR 0228, 0259); a selected wire is this panel's own.
  const keys = useGraphSelection({
    edits: shaderGraphEdits,
    graph: () => doc.value.peek(),
    commit: (next, drag) => commit(next, drag),
    move: moveNodes,
    readOnly,
    root,
    canvas: () => canvas,
    nodes: () => live.current.nodes,
    paneIgnore: ".sg-node, .sg-search, .sg-find, .sg-wire-hit, .sg-note, .sg-group-head, .sg-minimap, .sg-previewcard",
    openSearch: () => search.open(paneCenter(), { pending: null }),
    openFind: () => find.open(),
    deleteOther: () => {
      if (!selectedEdge) return false;
      commit(disconnect(doc.value.peek(), selectedEdge));
      setSelectedEdge(null);
      return true;
    },
    onItemDown: () => setSelectedEdge(null),
    onPaneDown: () => {
      search.dismiss();
      setSelectedEdge(null);
    },
    onEscape: () => {
      search.dismiss();
      setSelectedEdge(null);
    },
  });
  const { selection, setSelection, box, dragging } = keys;

  const compiled: CompiledShaderGraph = useMemo(() => compileShaderGraph(graph), [graph]);
  const connectedInputs = useMemo(() => new Set(graph.edges.map((e) => e.to)), [graph]);

  const boxes = useMemo(() => {
    const m = new Map<string, NodeBox>();
    for (const n of graph.nodes) m.set(n.id, nodeBox(n, graph, (port) => connectedInputs.has(portRef(n.id, port)), compiled.dynamicTypes[n.id]));
    return m;
  }, [graph, compiled, connectedInputs]);

  const position = (n: GraphNode): Point => {
    const d = dragging?.get(n.id);
    return d ?? { x: n.position[0], y: n.position[1] };
  };

  const canvasNodes: CanvasNode[] = graph.nodes.map((n) => {
    const b = boxes.get(n.id)!;
    const p = position(n);
    const ports = (side: "input" | "output") => b.rows.filter((r) => r.kind === side).map((r) => ({ id: (r as { port: PortDef }).port.id, ...portOffset(b, side, (r as { port: PortDef }).port.id)! }));
    return { id: n.id, x: p.x, y: p.y, width: b.width, height: b.height, selected: selection.has(n.id), inputs: ports("input"), outputs: ports("output") };
  });

  const canvas = useGraphCanvas({
    viewKey: path,
    nodes: canvasNodes,
    onContextMenu: (e, at) => {
      if ((e.target as Element).closest(".sg-node, .sg-previewcard")) return;
      e.preventDefault();
      search.open(at, { pending: null });
    },
  });
  const { pane, paneApi, view, paneSize, paneCenter, frameAll } = canvas;

  // xyflow reads the latest state through these (the graph straight from the document, so edits in a row see each other).
  const live = useRef({ get graph() { return doc.value.peek(); }, nodes: canvasNodes });
  live.current = { get graph() { return doc.value.peek(); }, nodes: canvasNodes };

  // --- editing ---------------------------------------------------------------------------------------

  /**
   * Apply an edit through the document: one undo step, saved (an edit that changes nothing adds
   * none). `drag`: a node drag or a value or colour change, whose quick changes in a row make one
   * undo step and one write.
   */
  const commit = (next: ShaderGraph, drag = false) => {
    if (next === doc.value.peek()) return;
    doc.edit(next, drag ? { coalesce: true } : undefined);
  };

  const undo = () => doc.undo();
  const redo = () => doc.redo();

  // --- canvas ----------------------------------------------------------------------------------------

  /** The node search: where it opened, and the port a dropped wire connects the new node to. */
  const search = useGraphSearch<{ pending: Pending }>({ pane: canvas.pane, root, readOnly });

  /** A port's definition on its node as drawn (its type, `dynamic` for one that follows its inputs). */
  const portDef = (node: string, port: string, side: "input" | "output"): PortDef | undefined =>
    boxes.get(node)?.rows.flatMap((r) => (r.kind === side && r.port.id === port ? [r.port] : []))[0];

  // The wiring gesture (ADR 0259): a wire dropped in empty space opens the search for nodes that fit its port.
  const wiring = useGraphWiring({
    flowPrefix: "sg",
    edits: shaderWiring,
    graph: () => doc.value.peek(),
    commit: (next) => commit(next),
    readOnly,
    root,
    canvas: () => canvas,
    nodes: () => live.current.nodes,
    onDropInSpace: (at, from) => {
      const def = portDef(from.node, from.port, from.side);
      if (!def) return;
      const type = from.side === "output" ? compiled.portTypes[from.ref] ?? (def.type === "dynamic" ? "float" : def.type) : def.type;
      search.open(at, { pending: { side: from.side, ref: from.ref, type } });
    },
  });
  const { flowId, draft, detached } = wiring;

  // --- find ------------------------------------------------------------------------------------------

  // Ctrl+F (ADR 0117): node titles and types, property names, settings and Custom Function names, notes and group titles.
  const find = useGraphFind({
    edits: shaderGraphEdits,
    graph,
    items: shaderFindItems,
    setSelection,
    frameAll,
    nodes: () => live.current.nodes,
    root,
    onOpen: () => search.dismiss(),
    onGo: () => setSelectedEdge(null),
  });

  const addFromSearch = (type: string, settings: Record<string, string> | undefined, at: Point, pending: Pending) => {
    const p = toGraph(at, canvas.viewRef.current);
    const made = addNode(graph, type, [p.x, p.y - HEADER], settings);
    let next = made.graph;
    if (type === "customFunction") next = setFunction(next, made.id, defaultFunction());
    if (pending?.side === "output") {
      const input = firstInputFor(type, pending.type === "dynamic" ? "float" : pending.type, next, settings);
      if (input) next = connect(next, pending.ref, portRef(made.id, input));
    } else if (pending?.side === "input") {
      const output = firstOutputFor(type, pending.type, next, settings);
      if (output) {
        // Place the new node to the left of the input it feeds.
        next = moveNodes(next, new Map([[made.id, [p.x - (nodeBox(next.nodes.at(-1)!, next, () => false).width + 20), p.y - HEADER] as [number, number]]]));
        next = connect(next, portRef(made.id, output), pending.ref);
      }
    }
    commit(next);
    setSelection(new Set([made.id]));
    search.close();
  };

  // --- preview ---------------------------------------------------------------------------------------

  const previewHost = useRef<HTMLDivElement>(null);
  const preview = useRef<MaterialPreview | null>(null);
  const mesh = graph.previewMesh ?? "sphere";
  // Made while the preview card is shown (docked in the canvas's corner), freed when it's hidden.
  useEffect(() => {
    if (!showPreview || !previewHost.current) return;
    const p = new MaterialPreview(previewHost.current);
    p.onShaderError = setShaderError;
    preview.current = p;
    return () => {
      p.dispose();
      preview.current = null;
      setShaderError(null); // only the preview compiles the shader
    };
  }, [showPreview]);
  // Rebuild the preview's material when anything but node positions changes.
  const codeKey = JSON.stringify({ ...graph, previewMesh: 0, nodes: graph.nodes.map((n) => ({ ...n, position: 0 })) });
  useEffect(() => {
    preview.current?.setGraph(graph);
  }, [codeKey, showPreview]);
  useEffect(() => preview.current?.setMesh(mesh), [mesh, showPreview]); // and a newly shown preview

  // Node previews (ADR 0048): one offscreen renderer draws each node's preview about ten times a second.
  const previewGraphs = useMemo(() => {
    const m = new Map<string, ShaderGraph>();
    for (const n of graph.nodes) {
      const g = n.preview === false ? null : nodePreviewGraph(graph, n.id);
      if (g) m.set(n.id, g);
    }
    return m;
  }, [codeKey]);
  const previewGraphsRef = useRef(previewGraphs);
  previewGraphsRef.current = previewGraphs;
  /** Each node's preview shape (ADR 0117); not part of `codeKey`, as it doesn't change the shader. */
  const previewShapes = new Map(graph.nodes.map((n) => [n.id, nodePreviewShape(graph, n)]));
  const previewShapesRef = useRef(previewShapes);
  previewShapesRef.current = previewShapes;
  useEffect(() => {
    const renderer = new NodePreviewRenderer(PREVIEW - 8);
    const draw = () => {
      if (document.hidden || !pane.current) return;
      renderer.begin();
      for (const canvas of pane.current.querySelectorAll<HTMLCanvasElement>("canvas[data-preview]")) {
        const g = previewGraphsRef.current.get(canvas.dataset.preview!);
        if (g) canvas.classList.toggle("failed", !renderer.draw(g, canvas, previewShapesRef.current.get(canvas.dataset.preview!)));
      }
      renderer.end();
    };
    draw();
    const timer = setInterval(draw, 100);
    return () => {
      clearInterval(timer);
      renderer.dispose();
    };
  }, []);

  // --- drawing ---------------------------------------------------------------------------------------

  const nodeById = new Map(canvasNodes.map((n) => [n.id, n]));
  const portPoint = (ref: string, side: "input" | "output"): Point | null => {
    const { node, port } = splitPortRef(ref);
    const n = nodeById.get(node);
    const p = n && (side === "input" ? n.inputs : n.outputs).find((q) => q.id === port);
    return n && p ? { x: n.x + p.x, y: n.y + p.y } : null;
  };

  const subgraphs = project.files.filter((f) => editor.assets.kindOf(f) === "shadersubgraph" && f !== path);
  const problems = [...parseProblems, ...compiled.problems];
  const sub = !!graph.subgraph;
  const selectedNode = selection.size === 1 ? graph.nodes.find((n) => selection.has(n.id)) : undefined;
  const groupRect = (g: GraphGroup) => {
    const members = canvasNodes.filter((n) => g.nodes.includes(n.id));
    if (members.length === 0) return null;
    const pad = 16, head = 28;
    const x0 = Math.min(...members.map((n) => n.x)) - pad, y0 = Math.min(...members.map((n) => n.y)) - pad - head;
    const x1 = Math.max(...members.map((n) => n.x + n.width)) + pad, y1 = Math.max(...members.map((n) => n.y + n.height)) + pad;
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  };

  return (
    <div class={`shader-graph${maximized ? " maximized" : ""}`} data-asset-document={doc.path} ref={root} tabIndex={0} {...keys.rootProps} aria-label="Shader Graph">
      <div class="sg-toolbar">
        <span class="sg-name" title={path}>
          {editor.assets.fileName(path)}
        </span>
        {sub && <span class="sg-kind">Sub Graph</span>}
        {!sub && (
          <>
        <label>
          Target{" "}
          <select aria-label="Target" disabled={readOnly} value={graph.target} onChange={(e) => commit(setGraphOptions(graph, { target: (e.currentTarget as HTMLSelectElement).value as ShaderGraph["target"] }))}>
            <option value="lit">Lit</option>
            <option value="physical">Physical</option>
            <option value="unlit">Unlit</option>
            <option value="sprite-lit">Sprite Lit</option>
            <option value="sprite-unlit">Sprite Unlit</option>
            <option value="sprite-custom-lit">Sprite Custom Lit</option>
          </select>
        </label>
        <label>
          Surface{" "}
          <select aria-label="Surface" disabled={readOnly} value={graph.surface} onChange={(e) => commit(setGraphOptions(graph, { surface: (e.currentTarget as HTMLSelectElement).value as ShaderGraph["surface"] }))}>
            <option value="opaque">Opaque</option>
            <option value="transparent">Transparent</option>
          </select>
        </label>
        <label>
          <input type="checkbox" aria-label="Double Sided" disabled={readOnly} checked={graph.doubleSided} onChange={(e) => commit(setGraphOptions(graph, { doubleSided: (e.currentTarget as HTMLInputElement).checked }))} /> Double Sided
        </label>
          </>
        )}
        <label>
          Previews{" "}
          <select aria-label="Node preview shape" title="The shape node previews are drawn on" disabled={readOnly} value={graph.previewShape ?? "quad"} onChange={(e) => commit(setGraphPreviewShape(graph, (e.currentTarget as HTMLSelectElement).value as NodePreviewShape))}>
            {NODE_PREVIEW_SHAPES.map((m) => (
              <option key={m} value={m}>
                {m[0]!.toUpperCase() + m.slice(1)}
              </option>
            ))}
          </select>
        </label>
        {selectedNode && selectedNode.type !== "output" && selectedNode.type !== "property" && (
          <label>
            Selected{" "}
            <select aria-label="Selected node preview shape" title="The shape this node's preview is drawn on" disabled={readOnly} value={selectedNode.previewShape ?? ""} onChange={(e) => commit(setNodePreviewShape(graph, selectedNode.id, ((e.currentTarget as HTMLSelectElement).value || null) as NodePreviewShape | null))}>
              <option value="">Graph default</option>
              {NODE_PREVIEW_SHAPES.map((m) => (
                <option key={m} value={m}>
                  {m[0]!.toUpperCase() + m.slice(1)}
                </option>
              ))}
            </select>
          </label>
        )}
        <span class="sg-spacer" />
        <button title="Find in this graph (Ctrl+F)" aria-pressed={find.isOpen} onClick={find.toggle}>
          Find
        </button>
        <button title="Undo (Ctrl+Z)" disabled={readOnly || !doc.canUndo.value} onClick={undo}>
          Undo
        </button>
        <button title="Redo (Ctrl+Shift+Z)" disabled={readOnly || !doc.canRedo.value} onClick={redo}>
          Redo
        </button>
        <button title="Add a node (Space, or right-click the canvas)" disabled={readOnly} onClick={() => search.open(paneCenter(), { pending: null })}>
          Add Node
        </button>
        <button title="Put the selected nodes in a group (Ctrl+G)" disabled={readOnly || selection.size === 0} onClick={keys.groupSelection}>
          Group
        </button>
        <button title="Add a sticky note" disabled={readOnly} onClick={keys.addNoteHere}>
          Note
        </button>
        <button title="Show every node (F)" onClick={() => frameAll()}>
          Frame
        </button>
        <button class={showPreview ? "active" : ""} aria-pressed={showPreview} title="Show the preview" onClick={() => setShowPreview(!showPreview)}>
          Preview
        </button>
        <button class={showCode ? "active" : ""} aria-pressed={showCode} title="Show the WGSL this graph compiles to" onClick={() => setShowCode(!showCode)}>
          WGSL
        </button>
        {!sub && (
          <button title="Create a material that draws with this graph" disabled={readOnly} onClick={() => void createMaterialForGraph(path)}>
            New Material
          </button>
        )}
        <button aria-pressed={maximized} title={maximized ? "Back into the layout" : "Fill the window"} onClick={() => setMaximized(!maximized)}>
          {maximized ? "Restore" : "Maximize"}
        </button>
      </div>
      <div class="sg-body">
        <aside class="sg-side">
          <Blackboard
            sub={sub}
            graph={graph}
            readOnly={readOnly}
            commit={commit}
            placeNode={(name) => {
              const made = addNode(graph, "property", [toGraph(paneCenter(), view).x - 80, toGraph(paneCenter(), view).y], { property: name });
              commit(made.graph);
              setSelection(new Set([made.id]));
            }}
          />
          <KeywordList graph={graph} readOnly={readOnly} commit={commit} />
          {sub && <SubGraphOutputs graph={graph} readOnly={readOnly} commit={commit} />}
          {selectedNode?.type === "customFunction" && <FunctionEditor key={selectedNode.id} node={selectedNode} graph={graph} wgslFiles={project.files.filter((x) => x.toLowerCase().endsWith(".wgsl"))} readOnly={readOnly} commit={commit} />}
        </aside>
        <div
          class="sg-pane"
          ref={pane}
          onPointerDown={keys.onPaneDown}
          onPointerMove={canvas.onPointerMove}
          onContextMenu={(e) => e.preventDefault()}
        >
          <div class="sg-viewport" style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.zoom})` }}>
            {graph.groups?.map((g) => {
              const r = groupRect(g);
              if (!r) return null;
              return (
                <div key={g.id} class="sg-group" style={{ left: px(r.x), top: px(r.y), width: px(r.w), height: px(r.h) }} aria-label={`Group ${g.title}`}>
                  <div class={`sg-group-head ${NO_PAN}`} onPointerDown={(e) => keys.startGroupDrag(e, g.id)}>
                    <input type="text" class={NO_DRAG} aria-label="Group title" disabled={readOnly} value={g.title} onChange={(e) => commit(shaderGraphEdits.setGroupTitle(live.current.graph, g.id, (e.currentTarget as HTMLInputElement).value))} />
                    <button title="Ungroup (the nodes stay)" aria-label={`Ungroup ${g.title}`} disabled={readOnly} onClick={() => commit(shaderGraphEdits.ungroup(live.current.graph, g.id))}>
                      ✕
                    </button>
                  </div>
                </div>
              );
            })}
            {graph.notes?.map((n) => (
              <NoteView key={n.id} note={n} zoom={view.zoom} readOnly={readOnly} onChange={(patch) => commit(shaderGraphEdits.updateNote(live.current.graph, n.id, patch), !("text" in patch))} onRemove={() => commit(shaderGraphEdits.removeNote(live.current.graph, n.id))} />
            ))}
            <svg class="sg-wires">
              {graph.edges.map((e) => {
                if (e.to === detached) return null;
                const a = portPoint(e.from, "output"), b = portPoint(e.to, "input");
                if (!a || !b) return null;
                const d = wirePath(a, b);
                const t = compiled.portTypes[e.from] ?? "float";
                return (
                  <g key={e.to} class={`sg-wire ${cssType(t)}${selectedEdge === e.to ? " selected" : ""}`} data-edge={`${e.from}>${e.to}`}>
                    <path class="sg-wire-hit" d={d} onPointerDown={(ev) => { ev.stopPropagation(); root.current?.focus(); setSelection(new Set()); setSelectedEdge(e.to); }} />
                    <path class="sg-wire-line" d={d} />
                  </g>
                );
              })}
              {draft && <path class={`sg-draft${draft.valid ? " valid" : ""}`} d={wirePath(draft.from, draft.to)} />}
            </svg>
            <WireRefusal draft={draft} hint={wiring.hint} />
            {graph.nodes.map((n) => (
              <NodeView
                key={n.id}
                node={n}
                graph={graph}
                box={boxes.get(n.id)!}
                at={position(n)}
                selected={selection.has(n.id)}
                problems={compiled.nodeProblems[n.id]}
                dynamic={compiled.dynamicTypes[n.id] ?? "float"}
                portTypes={compiled.portTypes}
                connected={connectedInputs}
                flowId={flowId}
                path={path}
                readOnly={readOnly}
                onDown={keys.onItemDown}
                onPortDown={wiring.onPortDown}
                commit={commit}
                drag={keys.drag}
              />
            ))}
          </div>
          {box && <SelectionBox box={box} />}
          <Minimap nodes={canvasNodes} view={view} size={paneSize} pane={paneApi} />
          <GraphFindBox find={find} placeholder="Find nodes, properties, notes…" />
          {search.search && <NodeSearch graph={graph} subgraphs={subgraphs} at={search.search.popup} pending={search.search.pending} onPick={(type, settings) => addFromSearch(type, settings, search.search!.at, search.search!.pending)} onClose={search.close} />}
          {showPreview && (
            <GraphPreviewCard
              label="Shader graph preview"
              size={previewSize}
              onResize={setPreviewSize}
              onClose={() => setShowPreview(false)}
              controls={
                <select aria-label="Preview mesh" title="The mesh the preview draws (saved with the graph)" disabled={readOnly} value={mesh} onChange={(e) => commit(setGraphPreviewMesh(graph, (e.currentTarget as HTMLSelectElement).value as GraphPreviewMesh))}>
                  {GRAPH_PREVIEW_MESHES.map((m) => (
                    <option key={m} value={m}>
                      {m[0].toUpperCase() + m.slice(1)}
                    </option>
                  ))}
                </select>
              }
            >
              <div class="sg-preview" ref={previewHost} aria-label="Shader preview" title="Drag to turn" />
            </GraphPreviewCard>
          )}
          {(problems.length > 0 || shaderError) && (
            // Left of the preview card, which docks in the same corner.
            <ul class="sg-problems" aria-label="Shader graph problems" style={showPreview ? { right: px(previewSize.w + 24) } : undefined}>
              {shaderError && <li class="error">The generated shader didn't compile: {shaderError}</li>}
              {problems.map((p) => (
                <li key={p}>{p}</li>
              ))}
            </ul>
          )}
          {readOnly && <p class="sg-readonly">This project is read-only.</p>}
        </div>
        {showCode && <pre class="sg-glsl" aria-label="Generated WGSL">{shaderGraphListing(compiled)}</pre>}
      </div>
    </div>
  );
}

// --- nodes -------------------------------------------------------------------------------------------

function NodeView(props: {
  node: GraphNode;
  graph: ShaderGraph;
  box: NodeBox;
  at: Point;
  selected: boolean;
  problems?: string[];
  dynamic: ValueType;
  portTypes: Record<string, ValueType>;
  connected: ReadonlySet<string>;
  flowId: string;
  /** The open graph's path (a sub-graph's own Sub Graph slot leaves it out). */
  path: string;
  readOnly: boolean;
  onDown(e: PointerEvent, id: string): void;
  onPortDown(e: MouseEvent, node: string, port: string, side: "input" | "output"): void;
  commit(g: ShaderGraph, drag?: boolean): void;
  drag: GraphDragHooks;
}) {
  const { node, graph, box, at, dynamic } = props;
  const el = useRef<HTMLDivElement>(null);
  useNodeDrag(el, node.id, props.readOnly, props.drag);
  const def = nodeDef(node.type);
  const title = nodeTitle(node);
  return (
    <div
      ref={el}
      class={`sg-node ${NO_PAN}${props.selected ? " selected" : ""}${props.problems?.length ? " has-problem" : ""}${node.type === "output" ? " output" : ""}`}
      style={{ left: px(at.x), top: px(at.y), width: px(box.width), height: px(box.height) }}
      data-node={node.id}
      aria-label={`${title} node`}
      title={props.problems?.join("\n")}
      onPointerDown={(e) => props.onDown(e, node.id)}
    >
      <div class={`sg-node-header cat-${(def?.category ?? "Input").toLowerCase()}`} style={{ height: px(HEADER) }}>
        <span class="sg-node-title">{title}</span>
        {node.type !== "output" && node.type !== "property" && (box.previewTop !== null || node.preview === false) && (
          <button class={`sg-preview-toggle ${NO_DRAG}`} title={node.preview === false ? "Show the preview" : "Hide the preview"} aria-label={`${node.preview === false ? "Show" : "Hide"} ${title} preview`} disabled={props.readOnly} onClick={() => props.commit(setPreview(graph, node.id, node.preview === false))}>
            {node.preview === false ? "▸" : "▾"}
          </button>
        )}
      </div>
      {box.previewTop !== null && <canvas class="sg-node-preview" data-preview={node.id} width={PREVIEW - 8} height={PREVIEW - 8} style={{ top: px(box.previewTop), left: px((box.width - (PREVIEW - 8)) / 2) }} aria-label={`${title} preview`} />}
      {box.rows.map((r, i) => {
        const top = HEADER + i * ROW;
        if (r.kind === "output") {
          const t = props.portTypes[portRef(node.id, r.port.id)] ?? "float";
          return (
            <div key={`o-${r.port.id}`} class="sg-row out" style={{ top: px(top), height: px(ROW) }}>
              <span class="sg-label">{r.port.label}</span>
              <span {...handleProps(props.flowId, node.id, r.port.id, "output")} class={`${handleProps(props.flowId, node.id, r.port.id, "output").class} sg-port ${cssType(t)}`} title={`${r.port.label} (${t})`} onMouseDown={(e) => props.onPortDown(e, node.id, r.port.id, "output")} />
            </div>
          );
        }
        if (r.kind === "input") {
          const ref = portRef(node.id, r.port.id);
          const connected = props.connected.has(ref);
          const t = r.port.type === "dynamic" ? dynamic : r.port.type;
          return (
            <div key={`i-${r.port.id}`} class={`sg-row in${connected ? " connected" : ""}`} style={{ top: px(top), height: px(ROW) }}>
              <span {...handleProps(props.flowId, node.id, r.port.id, "input")} class={`${handleProps(props.flowId, node.id, r.port.id, "input").class} sg-port ${cssType(t)}${connected ? " filled" : ""}`} title={`${r.port.label} (${t})`} onMouseDown={(e) => props.onPortDown(e, node.id, r.port.id, "input")} />
              <span class="sg-label">{r.port.label}</span>
              {!connected && <InlineValue node={node} port={r.port} dynamic={dynamic} readOnly={props.readOnly} onValue={(v, drag) => props.commit(setInput(graph, node.id, r.port.id, v), drag)} />}
            </div>
          );
        }
        return (
          <div key={`s-${r.setting.id}`} class="sg-row setting" style={{ top: px(top), height: px(ROW) }}>
            <SettingField node={node} setting={r.setting} graph={graph} path={props.path} readOnly={props.readOnly} onValue={(v, drag) => props.commit(setSetting(graph, node.id, r.setting.id, v), drag)} />
          </div>
        );
      })}
    </div>
  );
}

const rgbToHex = (v: readonly number[]) => new Color(v[0] ?? 1, v[1] ?? 1, v[2] ?? 1).toHex();
const hexToRgb = (hex: string): number[] => {
  const c = Color.from(hex);
  return [c.r, c.g, c.b];
};

/** An unconnected input's value: number fields, a colour picker for colour inputs, or the built-in it reads. */
function InlineValue(props: { node: GraphNode; port: PortDef; dynamic: ValueType; readOnly: boolean; onValue: ValueReport<InputValue> }) {
  const { node, port, dynamic } = props;
  const label = `${nodeTitle(node)} ${port.label}`;
  if (port.bind) return <span class="sg-bind">{port.bind === "uv" ? "UV0" : port.bind.replace(/([A-Z])/g, " $1").toLowerCase()}</span>;
  if (port.type === "texture") return null;
  const value = node.inputs?.[port.id] ?? port.default ?? 0;
  if (port.color) {
    const rgb = Array.isArray(value) ? value : [value, value, value];
    return <ColorField class={`sg-color ${NO_DRAG}`} label={label} disabled={props.readOnly} value={rgbToHex(rgb)} onValue={(hex, drag) => props.onValue(hexToRgb(hex), drag)} />;
  }
  const n = inlineFields(port, false, dynamic);
  const values = Array.from({ length: n }, (_, i) => (Array.isArray(value) ? value[i] ?? 0 : value));
  return (
    <span class="sg-fields">
      {values.map((v, i) => (
        <input
          key={i}
          type="number"
          step={0.1}
          class={`${NO_DRAG} ${NO_WHEEL}`}
          aria-label={n > 1 ? `${label} ${"XYZW"[i]}` : label}
          disabled={props.readOnly}
          value={+v.toFixed(4)}
          onChange={(e) => {
            const x = numberValue(e);
            if (!Number.isFinite(x)) return;
            if (n === 1) props.onValue(x, false);
            else props.onValue(values.map((old, j) => (j === i ? x : old)), false);
          }}
        />
      ))}
    </span>
  );
}

function SettingField(props: { node: GraphNode; setting: SettingDef; graph: ShaderGraph; path: string; readOnly: boolean; onValue: ValueReport<string> }) {
  const { node, setting, graph } = props;
  const value = settingValue(node, setting);
  const label = `${nodeTitle(node)} ${setting.label}`;
  const select = (options: { value: string; label: string }[]) => (
    <select class={`${NO_DRAG} ${NO_WHEEL}`} aria-label={label} disabled={props.readOnly} value={value} onChange={(e) => props.onValue((e.currentTarget as HTMLSelectElement).value, false)}>
      {options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  );
  let field;
  if (setting.kind === "select") field = select((setting.options ?? []).map((o) => ({ value: o, label: o[0].toUpperCase() + o.slice(1) })));
  else if (setting.kind === "subgraph")
    field = <AssetPicker class={`${NO_DRAG} ${NO_WHEEL}`} label={label} kinds={["shadersubgraph"]} accepts={(f) => f !== props.path} none="(pick a sub-graph)" value={value} disabled={props.readOnly} onCommit={(v) => props.onValue(v, false)} />;
  else if (setting.kind === "property") field = select([{ value: "", label: "(pick a property)" }, ...graph.properties.map((p) => ({ value: p.name, label: p.name }))]);
  else if (setting.kind === "keyword") field = select([{ value: "", label: "(pick a keyword)" }, ...(graph.keywords ?? []).map((k) => ({ value: k.name, label: k.name }))]);
  else if (setting.kind === "texture")
    field = <AssetPicker class={`${NO_DRAG} ${NO_WHEEL}`} label={label} kinds={TEXTURE_SLOT} none="White" value={value} disabled={props.readOnly} onCommit={(v) => props.onValue(v, false)} />;
  else if (setting.kind === "color") field = <ColorField class={NO_DRAG} label={label} disabled={props.readOnly} value={value} onValue={props.onValue} />;
  else field = <input type="text" class={NO_DRAG} aria-label={label} disabled={props.readOnly} value={value} onChange={(e) => props.onValue((e.currentTarget as HTMLInputElement).value, false)} />;
  return (
    <>
      <span class="sg-label">{setting.label}</span>
      {field}
    </>
  );
}

// --- node search -------------------------------------------------------------------------------------

interface NodeItem extends SearchItem {
  type: string;
  settings?: Record<string, string>;
}

function NodeSearch(props: { graph: ShaderGraph; subgraphs: string[]; at: Point; pending: Pending; onPick(type: string, settings?: Record<string, string>): void; onClose(): void }) {
  const { graph, pending } = props;
  const all: NodeItem[] = useMemo(() => {
    const items: NodeItem[] = graph.properties.map((p) => ({ key: `property:${p.name}`, type: "property", label: p.name, category: graph.subgraph ? "Inputs" : "Properties", keywords: `${p.name} property ${p.type}`, settings: { property: p.name } }));
    for (const f of props.subgraphs) {
      const name = editor.assets.fileName(f).replace(/\.shadersubgraph\.json$/i, "");
      items.push({ key: `subgraph:${f}`, type: "subgraph", label: name, category: "Sub Graphs", keywords: `${name} sub graph subgraph`, settings: { subgraph: `asset:${f}` } });
    }
    for (const d of [...NODES].sort((a, b) => categoryRank(a.category) - categoryRank(b.category))) {
      if (d.type === "output" || d.type === "property" || d.type === "subgraph") continue;
      if (d.targets && !graph.subgraph && !d.targets.includes(graph.target)) continue; // nodes for other targets (ADR 0415)
      items.push({ key: d.type, type: d.type, label: d.title, category: d.category, keywords: `${d.title} ${d.category} ${d.keywords ?? ""} ${d.type}` });
    }
    return items;
  }, [graph, props.subgraphs]);
  const fits = (item: NodeItem) => {
    if (!pending) return true;
    if (pending.side === "output") return firstInputFor(item.type, pending.type === "dynamic" ? "float" : pending.type, graph, item.settings) !== null;
    return firstOutputFor(item.type, pending.type, graph, item.settings) !== null;
  };
  const items = useMemo(() => all.filter(fits), [all, pending]);
  return <NodeSearchPopup items={items} at={props.at} onPick={(i) => props.onPick(i.type, i.settings)} onClose={props.onClose} />;
}

// --- blackboard --------------------------------------------------------------------------------------

const PROPERTY_LABELS: Record<GraphPropertyType, string> = { float: "Float", vector2: "Vector 2", vector3: "Vector 3", vector4: "Vector 4", color: "Color", texture: "Texture" };

function Blackboard(props: { sub: boolean; graph: ShaderGraph; readOnly: boolean; commit(g: ShaderGraph, drag?: boolean): void; placeNode(name: string): void }) {
  const { graph, readOnly, commit } = props;
  return (
    <div class="sg-blackboard" aria-label="Properties">
      <div class="sg-blackboard-head">
        <span>{props.sub ? "Inputs" : "Properties"}</span>
        <select
          aria-label="Add property"
          disabled={readOnly}
          value=""
          onChange={(e) => {
            const type = (e.currentTarget as HTMLSelectElement).value as GraphPropertyType;
            (e.currentTarget as HTMLSelectElement).value = "";
            if (type) commit(shaderGraphEdits.addProperty(graph, type).graph);
          }}
        >
          <option value="">+ Add…</option>
          {GRAPH_PROPERTY_TYPES.map((t) => (
            <option key={t} value={t}>
              {PROPERTY_LABELS[t]}
            </option>
          ))}
        </select>
      </div>
      {graph.properties.length === 0 && <p class="sg-hint">{props.sub ? "Inputs are the Sub Graph node's inputs. Add one, then place it in the graph." : "Properties are values each material sets. Add one, then place it in the graph."}</p>}
      {graph.properties.map((p, i) => (
        <div key={p.name} class="sg-property" aria-label={`Property ${p.name}`}>
          <div class="sg-property-row">
            <input
              type="text"
              aria-label="Property name"
              disabled={readOnly}
              value={p.name}
              onChange={(e) => {
                const name = (e.currentTarget as HTMLInputElement).value;
                const why = shaderGraphEdits.whyNotPropertyName(graph, p.name, name);
                if (why) {
                  editor.messages.error(`Can't rename ${p.name}: ${why}.`);
                  (e.currentTarget as HTMLInputElement).value = p.name;
                } else commit(shaderGraphEdits.renameProperty(graph, p.name, name));
              }}
            />
            <select aria-label={`${p.name} type`} disabled={readOnly} value={p.type} onChange={(e) => commit(setPropertyType(graph, p.name, (e.currentTarget as HTMLSelectElement).value as GraphPropertyType))}>
              {GRAPH_PROPERTY_TYPES.map((t) => (
                <option key={t} value={t}>
                  {PROPERTY_LABELS[t]}
                </option>
              ))}
            </select>
          </div>
          <div class="sg-property-row">
            <PropertyValue name={p.name} type={p.type} value={p.value} disabled={readOnly} onValue={(v, drag) => commit(shaderGraphEdits.setPropertyValue(graph, p.name, v), drag)} />
          </div>
          <div class="sg-property-row sg-property-actions">
            <button title="Place a node that reads this property" disabled={readOnly} onClick={() => props.placeNode(p.name)}>
              Place
            </button>
            <button title="Move up" aria-label={`Move ${p.name} up`} disabled={readOnly || i === 0} onClick={() => commit(shaderGraphEdits.moveProperty(graph, p.name, -1))}>
              ↑
            </button>
            <button title="Move down" aria-label={`Move ${p.name} down`} disabled={readOnly || i === graph.properties.length - 1} onClick={() => commit(shaderGraphEdits.moveProperty(graph, p.name, 1))}>
              ↓
            </button>
            <button class="danger" title="Remove the property and its nodes" aria-label={`Remove ${p.name}`} disabled={readOnly} onClick={() => commit(shaderGraphEdits.removeProperty(graph, p.name))}>
              ✕
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

/** The graph's keywords (ADR 0106; a sub-graph's too): on/off or enum switches materials set, each compiling its own variant. */
function KeywordList(props: { graph: ShaderGraph; readOnly: boolean; commit(g: ShaderGraph): void }) {
  const { graph, readOnly, commit } = props;
  const keywords = graph.keywords ?? [];
  const sub = !!graph.subgraph;
  return (
    <div class="sg-blackboard sg-keywords" aria-label="Keywords">
      <div class="sg-blackboard-head">
        <span>Keywords</span>
        <button aria-label="Add keyword" disabled={readOnly} onClick={() => commit(addKeyword(graph).graph)}>
          + Add
        </button>
      </div>
      {keywords.length === 0 && <p class="sg-hint">Keywords are switches a material sets; each combination compiles its own shader. Add one, then use it in a Keyword node.{sub ? " A sub-graph's keywords become the using graph's when it's used (a keyword of the same name the graph declares itself wins)." : ""}</p>}
      {keywords.map((k) => (
        <div key={k.name} class="sg-property" aria-label={`Keyword ${k.name}`}>
          <div class="sg-property-row">
            <input
              type="text"
              aria-label="Keyword name"
              disabled={readOnly}
              value={k.name}
              onChange={(e) => {
                const input = e.currentTarget as HTMLInputElement;
                const name = input.value.trim().toUpperCase().replace(/\s+/g, "_");
                const why = whyNotKeywordName(graph, k.name, name);
                if (why) {
                  editor.messages.error(`Can't rename the keyword: ${why}.`);
                  input.value = k.name;
                } else commit(renameKeyword(graph, k.name, name));
              }}
            />
            <select
              aria-label={`${k.name} kind`}
              disabled={readOnly}
              value={k.values ? "enum" : "bool"}
              onChange={(e) => commit(setKeyword(graph, k.name, { values: (e.currentTarget as HTMLSelectElement).value === "enum" ? ["LOW", "HIGH"] : null }))}
            >
              <option value="bool">On / off</option>
              <option value="enum">Enum</option>
            </select>
            <button class="danger" title="Remove the keyword and its nodes" aria-label={`Remove ${k.name}`} disabled={readOnly} onClick={() => commit(removeKeyword(graph, k.name))}>
              Remove
            </button>
          </div>
          {k.values && (
            <div class="sg-property-row">
              <input
                type="text"
                aria-label={`${k.name} values`}
                title="Comma-separated, two or more, upper case; the first is the default"
                disabled={readOnly}
                value={k.values.join(", ")}
                onChange={(e) => {
                  const input = e.currentTarget as HTMLInputElement;
                  const values = input.value.split(",").map((v) => v.trim().toUpperCase()).filter((v) => v);
                  const next = setKeyword(graph, k.name, { values });
                  if (next === graph) {
                    editor.messages.error("An enum keyword needs two or more distinct upper-case values (letters, digits, _).");
                    input.value = k.values!.join(", ");
                  } else commit(next);
                }}
              />
            </div>
          )}
          <label class="sg-property-row" title="Warm-up compiles every combination, so scripts can switch it at run time">
            <input type="checkbox" aria-label={`${k.name} compile all variants`} disabled={readOnly} checked={k.variants === "all"} onChange={(e) => commit(setKeyword(graph, k.name, { variants: (e.currentTarget as HTMLInputElement).checked ? "all" : "used" }))} />
            <span>Compile all variants (switched by scripts)</span>
          </label>
        </div>
      ))}
    </div>
  );
}

/** A property value editor, shared by the Blackboard and the Material inspector. */
// --- sub-graph outputs and custom functions (ADR 0048) -------------------------------------------------

const PORT_TYPES: FunctionPort["type"][] = ["float", "vec2", "vec3", "vec4", "texture"];

/** A list of named, typed ports: a sub-graph's outputs or a custom function's inputs or outputs. */
function PortList(props: {
  title: string;
  ports: FunctionPort[];
  textures: boolean;
  readOnly: boolean;
  onAdd(): void;
  onRename(from: string, to: string): void;
  onType(name: string, type: FunctionPort["type"]): void;
  onRemove(name: string): void;
}) {
  return (
    <div class="sg-ports" aria-label={props.title}>
      <div class="sg-ports-head">
        <span>{props.title}</span>
        <button aria-label={`Add to ${props.title}`} title="Add a port" disabled={props.readOnly} onClick={props.onAdd}>
          +
        </button>
      </div>
      {props.ports.map((p) => (
        <div key={p.name} class="sg-property-row">
          <input
            type="text"
            aria-label={`${props.title} ${p.name} name`}
            disabled={props.readOnly}
            value={p.name}
            onChange={(e) => {
              const name = (e.currentTarget as HTMLInputElement).value;
              const why = whyNotPortName(name, props.ports.map((q) => q.name).filter((n) => n !== p.name));
              if (why) {
                editor.messages.error(`Can't rename ${p.name}: ${why}.`);
                (e.currentTarget as HTMLInputElement).value = p.name;
              } else props.onRename(p.name, name);
            }}
          />
          <select aria-label={`${props.title} ${p.name} type`} disabled={props.readOnly} value={p.type} onChange={(e) => props.onType(p.name, (e.currentTarget as HTMLSelectElement).value as FunctionPort["type"])}>
            {PORT_TYPES.filter((t) => props.textures || t !== "texture").map((t) => (
              <option key={t} value={t}>
                {t === "texture" ? "Texture" : t}
              </option>
            ))}
          </select>
          <button class="danger" aria-label={`Remove ${p.name}`} title="Remove" disabled={props.readOnly} onClick={() => props.onRemove(p.name)}>
            ✕
          </button>
        </div>
      ))}
    </div>
  );
}

/** A sub-graph's outputs: the Sub Graph node's outputs, and its output node's ports. */
function SubGraphOutputs(props: { graph: ShaderGraph; readOnly: boolean; commit(g: ShaderGraph): void }) {
  const { graph, commit } = props;
  return (
    <div class="sg-side-card">
      <PortList
        title="Outputs"
        ports={graph.subgraph!.outputs}
        textures
        readOnly={props.readOnly}
        onAdd={() => commit(addSubGraphOutput(graph))}
        onRename={(a, b) => commit(renameSubGraphOutput(graph, a, b))}
        onType={(n, t) => commit(setSubGraphOutputType(graph, n, t))}
        onRemove={(n) => commit(removeSubGraphOutput(graph, n))}
      />
    </div>
  );
}

/** The selected Custom Function node's name, ports and WGSL body. */
function FunctionEditor(props: { node: GraphNode; graph: ShaderGraph; wgslFiles: string[]; readOnly: boolean; commit(g: ShaderGraph): void }) {
  const { node, graph, commit } = props;
  const f: CustomFunction = node.function ?? defaultFunction();
  const set = (next: CustomFunction, renamed?: Record<string, string>) => commit(setFunction(graph, node.id, next, renamed));
  const side = (key: "inputs" | "outputs", title: string) => (
    <PortList
      title={title}
      ports={f[key]}
      textures={key === "inputs"}
      readOnly={props.readOnly}
      onAdd={() => set({ ...f, [key]: [...f[key], { name: freePortName([...f.inputs, ...f.outputs].map((p) => p.name), key === "inputs" ? "In" : "Out"), type: "float" }] })}
      onRename={(a, b) => set({ ...f, [key]: f[key].map((p) => (p.name === a ? { ...p, name: b } : p)) }, { [a]: b })}
      onType={(n, t) => set({ ...f, [key]: f[key].map((p) => (p.name === n ? { ...p, type: t } : p)) })}
      onRemove={(n) => set({ ...f, [key]: f[key].filter((p) => p.name !== n) })}
    />
  );
  return (
    <div class="sg-side-card sg-function" aria-label="Custom Function">
      <div class="sg-blackboard-head">
        <span>Custom Function</span>
      </div>
      <label class="sg-property-row">
        <span>Name</span>
        <input
          type="text"
          aria-label="Function name"
          disabled={props.readOnly}
          value={f.name}
          onChange={(e) => {
            const name = (e.currentTarget as HTMLInputElement).value;
            if (isPortName(name)) set({ ...f, name });
            else {
              editor.messages.error(`"${name}" isn't a valid function name (letters, digits and _, not starting with a digit).`);
              (e.currentTarget as HTMLInputElement).value = f.name;
            }
          }}
        />
      </label>
      {side("inputs", "Inputs")}
      {side("outputs", "Outputs")}
      <label class="sg-property-row">
        <span>Source</span>
        <select
          aria-label="Body source"
          disabled={props.readOnly}
          value={f.file !== undefined ? "file" : "inline"}
          onChange={(e) => {
            const file = (e.currentTarget as HTMLSelectElement).value === "file";
            const { file: _drop, ...rest } = f;
            set(file ? { ...rest, file: "" } : rest);
          }}
        >
          <option value="inline">Inline</option>
          <option value="file">File</option>
        </select>
      </label>
      {f.file !== undefined ? (
        <>
          <label class="sg-property-row">
            <span>WGSL file</span>
            <input
              type="text"
              list="sg-wgsl-files"
              aria-label="WGSL file"
              spellcheck={false}
              disabled={props.readOnly}
              placeholder="asset:shaders/body.wgsl"
              value={f.file}
              onChange={(e) => set({ ...f, file: (e.currentTarget as HTMLInputElement).value.trim() })}
            />
            <datalist id="sg-wgsl-files">
              {props.wgslFiles.map((x) => (
                <option key={x} value={`asset:${x}`} />
              ))}
            </datalist>
          </label>
          <p class="sg-hint">The file holds just the function body (same as the inline WGSL body). It wins over any inline body, and the material rebuilds when the file changes.{!f.file && " Without a file the node outputs its defaults."}</p>
        </>
      ) : (
        <>
          <label class="sg-property-row sg-wgsl-label">
            <span>WGSL body</span>
          </label>
          <textarea
            class="sg-function-body sg-function-wgsl"
            aria-label="WGSL body"
            spellcheck={false}
            disabled={props.readOnly}
            placeholder="Out = In;"
            value={f.wgsl ?? ""}
            onChange={(e) => set({ ...f, wgsl: (e.currentTarget as HTMLTextAreaElement).value })}
          />
          <p class="sg-hint">Assign every output (each is a var already declared); inputs and outputs are named as above.{!f.wgsl?.trim() && " Without a body the node outputs its defaults."}</p>
        </>
      )}
      {f.body?.trim() && (
        <>
          <label class="sg-property-row">
            <span>Old GLSL body</span>
          </label>
          <textarea class="sg-function-body" aria-label="Old GLSL body" spellcheck={false} readOnly value={f.body} />
          <p class="sg-hint">
            From before WGSL; nothing compiles it now. Port it to the WGSL body, then{" "}
            <button disabled={props.readOnly} onClick={() => set({ ...f, body: undefined })}>
              remove it
            </button>
            .
          </p>
        </>
      )}
    </div>
  );
}
