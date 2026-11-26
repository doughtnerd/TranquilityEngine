// The Animation Graph panel (ADR 0373; T51): the `*.animgraph.json` opened from the Assets panel (the kind's `panel`), or
// how to open one.
import { EmptyState, Panel, editor } from "../../../../editor/sdk";
import { AnimGraphEditor } from "./AnimGraphEditor";
import { ANIM_GRAPH_PANEL } from "./panelId";
import "./animGraphEditor.css";

export function AnimGraphPanel() {
  const path = editor.assets.openIn(ANIM_GRAPH_PANEL);
  const project = editor.project.current;
  if (!project) return <Panel><EmptyState compact title="No project open" /></Panel>;
  if (!path || !project.files.includes(path)) {
    return (
      <Panel>
        <EmptyState
          compact
          title="Double-click an animation graph (*.animgraph.json) in the Assets panel to edit it here."
          action={{ label: "New Animation Graph", run: () => void editor.assets.create("animgraph", { name: "Animation Graph" }).then((made) => made && editor.assets.open(made)) }}
        />
      </Panel>
    );
  }
  return (
    <Panel>
      <AnimGraphEditor key={path} project={project} path={path} />
    </Panel>
  );
}
