// The Animation Graph panel (ADR 0373; T51): the `*.animgraph.json` opened from the Assets panel (the kind's `panel`), or
// how to open one.
import { Panel, editor } from "../../../../editor/sdk";
import { AnimGraphEditor } from "./AnimGraphEditor";
import { ANIM_GRAPH_PANEL } from "./panelId";
import "./animGraphEditor.css";

export function AnimGraphPanel() {
  const path = editor.assets.openIn(ANIM_GRAPH_PANEL);
  const project = editor.project.current;
  if (!project) return <Panel><p class="empty">No project open</p></Panel>;
  if (!path || !project.files.includes(path)) {
    return (
      <Panel>
        <div class="ag-empty">
          <p>Double-click an animation graph (<code>*.animgraph.json</code>) in the Assets panel to edit it here.</p>
          <button onClick={() => void editor.assets.create("animgraph", { name: "Animation Graph" }).then((made) => made && editor.assets.open(made))}>New Animation Graph</button>
        </div>
      </Panel>
    );
  }
  return (
    <Panel>
      <AnimGraphEditor key={path} project={project} path={path} />
    </Panel>
  );
}
