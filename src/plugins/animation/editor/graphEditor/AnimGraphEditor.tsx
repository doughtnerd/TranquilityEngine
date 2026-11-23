// The animation graph editor (ADR 0373 "Animation graph editor"; T51) for one `*.animgraph.json`: its pose-node canvas,
// state machines as nested canvases (double-click a machine, then a state for its sub-graph; the breadcrumb goes back),
// the selected node's generated card with its side-table editor (blend space, chooser table, linked graph, slot), the
// selected state's transition list, and the parameters, layers (masks) and rig stack beside the canvas. The compiler's
// problems (T30) show on the nodes, fields, states and transitions their paths name. Every edit goes through the file's
// asset document (ADR 0134, 0233) as one labelled undo step (`applyToDocument`, ADR 0307, 0313), so Ctrl+Z, the frame's
// Undo and the History act on it.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { AnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { AssetDocumentFrame, AssetPicker, TextField, applyToDocument, openAssetDocument, type EditResult, type EditorProject } from "../../../../editor/sdk";
import { BlendSpaceEditor } from "./BlendSpaceEditor";
import { ChooserTable } from "./ChooserTable";
import { GraphParameters } from "./GraphParameters";
import { blendDims, nodeById, nodeTitle, setOutput, subGraph, type Added } from "./graphEditLogic";
import { LayersPanel } from "./LayersPanel";
import { LinkedGraphPicker } from "./LinkedGraphPicker";
import { MachineCanvas } from "./MachineCanvas";
import { entryOf, renameState, setEntry, setExit, setStateRoot, stateOf, type TransitionRef } from "./machineLogic";
import { NodeCard } from "./NodeCard";
import { PoseCanvas } from "./PoseCanvas";
import { indexProblems, transitionKey, type PlacedProblem } from "./problemLogic";
import { RigEntries } from "./RigEntries";
import { pickedRigEntry } from "./rigGizmo";
import { TransitionList } from "./TransitionList";
import "../../../../editor/graph/graph.css";
import "./animGraphEditor.css";

/** Which canvas is open: the graph, a machine, or one state's sub-graph. */
export type GraphView = { readonly kind: "graph" } | { readonly kind: "machine"; readonly machine: string } | { readonly kind: "state"; readonly machine: string; readonly state: string };

type SideTab = "parameters" | "layers" | "rig";

const fileName = (path: string) => path.slice(path.lastIndexOf("/") + 1).replace(/\.animgraph\.json$/i, "");

export function AnimGraphEditor(props: { project: EditorProject; path: string }) {
  const { project, path } = props;
  const doc = openAssetDocument<AnimGraph>(project, path);
  const graph = doc.value.value;
  const readOnly = doc.readOnly;
  const root = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<GraphView>({ kind: "graph" });
  const [selection, setSelection] = useState<ReadonlySet<string>>(new Set());
  const [transition, setTransitionRef] = useState<TransitionRef | null>(null);
  const [tab, setTab] = useState<SideTab>("parameters");
  const [problemsOpen, setProblemsOpen] = useState(false);
  useEffect(() => () => void doc.flush(), [doc]);
  useEffect(() => () => { if (pickedRigEntry.peek()?.path === path) pickedRigEntry.value = null; }, [path]);

  const apply = (result: EditResult<AnimGraph>, label: string) => void applyToDocument(doc, result, label);
  const compiled = useMemo(() => compileAnimGraph(graph), [graph]);
  const problems = useMemo(() => indexProblems(graph, compiled.problems), [graph, compiled]);

  // A view whose machine or state went away (an undo, a rename) falls back to its parent.
  const machineNode = view.kind !== "graph" ? nodeById(graph, view.machine) : undefined;
  const machine = machineNode?.machine;
  const state = view.kind === "state" && machine ? stateOf(machine, view.state) : undefined;
  const shownView: GraphView = view.kind === "graph" || !machine ? { kind: "graph" } : view.kind === "state" && !state ? { kind: "machine", machine: view.machine } : view;

  const go = (v: GraphView) => {
    setView(v);
    setSelection(new Set());
    setTransitionRef(null);
  };

  const fieldProblems = (node: string) => (field: string): readonly PlacedProblem[] =>
    field === "" ? (problems.byNode.get(node) ?? []).filter((p) => !p.place.field && !p.place.state && !p.place.transition && p.place.row === undefined) : (problems.byField.get(`${node}/${field}`) ?? []);

  const selectedNode = shownView.kind !== "machine" && selection.size === 1 ? nodeById(graph, [...selection][0]!) : undefined;
  const selectedState = shownView.kind === "machine" && machine && selection.size === 1 ? stateOf(machine, [...selection][0]!) : undefined;

  const focusProblem = (p: PlacedProblem) => {
    setProblemsOpen(false);
    const { node, state: st, transition: tr, parameter, layer } = p.place;
    if (parameter) return setTab("parameters");
    if (layer) return setTab("layers");
    if (!node) return;
    const n = nodeById(graph, node);
    if (n?.machine && (st || tr)) {
      setView({ kind: "machine", machine: node });
      setSelection(new Set(st ? [st] : tr?.from ? [tr.from] : []));
      setTransitionRef(tr ?? null);
      return;
    }
    setView({ kind: "graph" });
    setSelection(new Set([node]));
  };

  const onAdded = (added: Added) => {
    if (shownView.kind === "state" && state && !state.root) apply(setStateRoot(added.graph, shownView.machine, state.name, added.id), `Play ${added.id} in state ${state.name}`);
  };

  const errors = compiled.problems.filter((p) => p.severity === "error").length;
  const crumbs = [
    { label: graph.name || fileName(path), view: { kind: "graph" } as GraphView },
    ...(machineNode && shownView.kind !== "graph" ? [{ label: nodeTitle(machineNode), view: { kind: "machine", machine: machineNode.id } as GraphView }] : []),
    ...(state && shownView.kind === "state" ? [{ label: state.name, view: shownView }] : []),
  ];

  return (
    <AssetDocumentFrame doc={doc} kind="Animation Graph" class="ag-editor">
      <div class="ag-root" ref={root} tabIndex={-1}>
        <div class="sg-toolbar ag-toolbar">
          <nav class="ag-crumbs" aria-label="Graph path">
            {crumbs.map((c, i) => (
              <span key={i}>
                {i > 0 && <span class="ag-muted"> › </span>}
                <button class="ag-crumb" aria-current={i === crumbs.length - 1 ? "page" : undefined} onClick={() => go(c.view)}>{c.label}</button>
              </span>
            ))}
          </nav>
          <span class="sg-spacer" />
          <span class="ag-problems-anchor">
            <button class={`ag-problem-count${compiled.problems.length ? (errors ? " error" : " warning") : ""}`} aria-label="Problems" aria-expanded={problemsOpen} disabled={compiled.problems.length === 0} onClick={() => setProblemsOpen(!problemsOpen)}>
              {compiled.problems.length === 0 ? "No problems" : `${compiled.problems.length} problem${compiled.problems.length === 1 ? "" : "s"}`}
            </button>
            {problemsOpen && (
              <ul class="ag-problem-list" aria-label="Graph problems">
                {problems.all.map((p, i) => (
                  <li key={i} class={p.severity}>
                    <button onClick={() => focusProblem(p)} title={p.path}>{p.severity === "error" ? "Error: " : ""}{p.message}</button>
                  </li>
                ))}
              </ul>
            )}
          </span>
        </div>
        <div class="ag-body">
          <aside class="ag-sidebar" aria-label="Graph panels">
            <div class="ag-tabs" role="tablist">
              {(["parameters", "layers", "rig"] as const).map((t) => (
                <button key={t} role="tab" aria-selected={tab === t} class={tab === t ? "active" : ""} onClick={() => setTab(t)}>{t === "parameters" ? "Parameters" : t === "layers" ? "Layers" : "Rig"}</button>
              ))}
            </div>
            <div class="ag-tab-body" role="tabpanel">
              {tab === "parameters" && <GraphParameters graph={graph} apply={apply} readOnly={readOnly} problems={(n) => problems.byParameter.get(n) ?? []} />}
              {tab === "layers" && <LayersPanel graph={graph} apply={apply} readOnly={readOnly} problems={(n) => problems.byLayer.get(n) ?? []} />}
              {tab === "rig" && (
                <RigEntries graph={graph} selected={pickedRigEntry.value?.path === path ? pickedRigEntry.value.node : null}
                  onSelect={(id) => { pickedRigEntry.value = id ? { path, node: id } : null; if (id) { go({ kind: "graph" }); setSelection(new Set([id])); } }} />
              )}
            </div>
          </aside>
          {shownView.kind === "machine" ? (
            <MachineCanvas key={shownView.machine} graph={graph} machine={shownView.machine} viewKey={path} selection={selection} onSelection={setSelection} transition={transition} onTransition={setTransitionRef}
              apply={apply} readOnly={readOnly} problems={problems} root={root} onOpenState={(s) => go({ kind: "state", machine: shownView.machine, state: s })} />
          ) : (
            <PoseCanvas key={shownView.kind === "state" ? `${shownView.machine}/${shownView.state}` : "graph"} graph={graph} viewKey={shownView.kind === "state" ? `${path}#${shownView.machine}/${shownView.state}` : path}
              visible={shownView.kind === "state" ? subGraph(graph, state?.root ?? null) : null} selection={selection} onSelection={setSelection} apply={apply} onAdded={onAdded}
              readOnly={readOnly} problems={problems} root={root} onOpenMachine={(id) => go({ kind: "machine", machine: id })} />
          )}
          <aside class="ag-inspector" aria-label="Graph inspector">
            {shownView.kind === "machine" && machine ? (
              <>
                {selectedState && (
                  <div class="ag-card" role="group" aria-label={`State ${selectedState.name}`}>
                    <div class="ag-card-head"><span class="ag-card-kind">State</span></div>
                    <div class="ag-fields">
                      <label class="ag-field"><span>Name</span>
                        <TextField value={selectedState.name} label={`State ${selectedState.name} name`} onCommit={(v) => {
                          const r = renameState(graph, shownView.machine, selectedState.name, v);
                          apply(r, `Rename state ${selectedState.name}`);
                          if (!("refused" in r)) setSelection(new Set([v.trim()]));
                        }} />
                      </label>
                      <label class="ag-field"><span>Plays</span>
                        <select aria-label={`State ${selectedState.name} root`} value={selectedState.root ?? ""} disabled={readOnly}
                          onChange={(e) => apply(setStateRoot(graph, shownView.machine, selectedState.name, (e.currentTarget as HTMLSelectElement).value || null), `Change what ${selectedState.name} plays`)}>
                          <option value="">Nothing yet</option>
                          {graph.nodes.filter((n) => n.id !== shownView.machine).map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)}</option>)}
                        </select>
                      </label>
                      <label class="ag-field ag-flag"><span>Entry</span>
                        <input type="checkbox" aria-label={`${selectedState.name} is the entry state`} checked={entryOf(machine) === selectedState.name} disabled={readOnly || entryOf(machine) === selectedState.name}
                          onChange={() => apply(setEntry(graph, shownView.machine, selectedState.name), `Make ${selectedState.name} the entry state`)} />
                      </label>
                      <label class="ag-field ag-flag"><span>Exit state</span>
                        <input type="checkbox" aria-label={`${selectedState.name} is an exit state`} checked={selectedState.exit} disabled={readOnly}
                          onChange={(e) => apply(setExit(graph, shownView.machine, selectedState.name, (e.currentTarget as HTMLInputElement).checked), `${(e.currentTarget as HTMLInputElement).checked ? "Make" : "Unmake"} ${selectedState.name} an exit state`)} />
                      </label>
                    </div>
                    {(problems.byState.get(`${shownView.machine}/${selectedState.name}`) ?? []).filter((p) => !p.place.transition).map((p, k) => <p key={k} class={`ag-problem ${p.severity}`}>{p.message}</p>)}
                    <button class="ag-link" onClick={() => go({ kind: "state", machine: shownView.machine, state: selectedState.name })}>Open its sub-graph</button>
                  </div>
                )}
                {(selectedState || transition?.from === null || selection.size === 0) && (
                  <TransitionList graph={graph} machine={shownView.machine} from={selectedState ? selectedState.name : null} apply={apply} readOnly={readOnly}
                    open={transition && transition.from === (selectedState ? selectedState.name : null) ? transition.index : null}
                    onOpen={(i) => setTransitionRef(i === null ? null : { from: selectedState ? selectedState.name : null, index: i })}
                    problems={(i) => problems.byTransition.get(transitionKey(shownView.machine, { from: selectedState ? selectedState.name : null, index: i })) ?? []} />
                )}
              </>
            ) : selectedNode ? (
              <NodeCard graph={graph} node={selectedNode} apply={apply} readOnly={readOnly} problems={fieldProblems(selectedNode.id)} self={path}>
                {selectedNode.machine && <button class="ag-link" onClick={() => go({ kind: "machine", machine: selectedNode.id })}>Open the state machine</button>}
                {blendDims(selectedNode) > 0 && <BlendSpaceEditor key={selectedNode.id} graph={graph} node={selectedNode} apply={apply} readOnly={readOnly} />}
                {selectedNode.chooser && <ChooserTable graph={graph} node={selectedNode} apply={apply} readOnly={readOnly} problems={(row) => (problems.byNode.get(selectedNode.id) ?? []).filter((p) => p.place.row === row)} />}
                {(selectedNode.linked || selectedNode.slot) && <LinkedGraphPicker graph={graph} node={selectedNode} apply={apply} readOnly={readOnly} self={path} />}
              </NodeCard>
            ) : (
              <div class="ag-card" role="group" aria-label="Graph settings">
                <div class="ag-card-head"><span class="ag-card-kind">Graph</span></div>
                <div class="ag-fields">
                  <label class="ag-field"><span>Name</span>
                    <TextField value={graph.name} label="Graph name" placeholder={fileName(path)} onCommit={(v) => apply({ next: { ...graph, name: v.trim() } }, "Rename graph")} />
                  </label>
                  <label class="ag-field ag-field-wide"><span>Skeleton</span>
                    <AssetPicker value={graph.skeleton ?? ""} kinds={["skeleton"]} label="Graph skeleton" disabled={readOnly} onCommit={(v) => apply({ next: { ...graph, skeleton: v || null } }, "Set graph skeleton")} />
                  </label>
                  <label class="ag-field"><span>Output</span>
                    <select aria-label="Graph output" value={graph.output ?? ""} disabled={readOnly} onChange={(e) => apply(setOutput(graph, (e.currentTarget as HTMLSelectElement).value || null), "Change the output")}>
                      <option value="">None</option>
                      {graph.nodes.map((n) => <option key={n.id} value={n.id}>{nodeTitle(n)}</option>)}
                    </select>
                  </label>
                </div>
                <p class="ag-muted">Select a node to edit it. Right-click the canvas or press Space to add one from the catalogue.</p>
              </div>
            )}
          </aside>
        </div>
      </div>
    </AssetDocumentFrame>
  );
}
