// The Inspector's view of a selected `*.animgraph.json` (the kind's `inspector`): what the graph holds (nodes, state
// machines and states, parameters, layers), the compiler's problem count, and a button that opens it in the Animation
// Graph panel.
import type { AnimGraph } from "../../../../engine/animation/animGraph";
import { compileAnimGraph } from "../../../../engine/animation/graphCompile";
import { editor } from "../../../../editor/sdk";
import "./animGraphEditor.css";

export function AnimGraphSummary(props: { path: string }) {
  const project = editor.project.current;
  void editor.project.version; // follow edits and file changes
  if (!project) return null;
  const graph = editor.assets.read<AnimGraph>(project, props.path).value;
  const machines = graph.nodes.filter((n) => n.machine);
  const states = machines.reduce((s, n) => s + n.machine!.states.length, 0);
  const problems = compileAnimGraph(graph).problems;
  const errors = problems.filter((p) => p.severity === "error").length;
  return (
    <div class="ag-summary" aria-label="Animation graph summary">
      <dl>
        <dt>Nodes</dt><dd>{graph.nodes.length}</dd>
        <dt>State machines</dt><dd>{machines.length} ({states} state{states === 1 ? "" : "s"})</dd>
        <dt>Parameters</dt><dd>{graph.parameters.map((p) => p.name).join(", ") || "none"}</dd>
        <dt>Layers</dt><dd>{graph.layers.map((l) => l.name).join(", ") || "none"}</dd>
        <dt>Problems</dt><dd class={errors ? "ag-problem error" : problems.length ? "ag-problem warning" : ""}>{problems.length ? `${errors} error${errors === 1 ? "" : "s"}, ${problems.length - errors} warning${problems.length - errors === 1 ? "" : "s"}` : "none"}</dd>
      </dl>
      <button onClick={() => editor.assets.open(props.path)}>Open in Animation Graph</button>
    </div>
  );
}
