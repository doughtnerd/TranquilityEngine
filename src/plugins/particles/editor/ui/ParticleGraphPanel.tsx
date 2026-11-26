import { PARTICLE_GRAPH_PANEL } from "../particleAssets";
import { ParticleGraphEditor } from "./particleGraph/GraphEditor";
import { editor, Panel, EmptyState } from "../../../../editor/sdk";
import "./particleGraph/particleGraph.css";

/** The Particle Graph panel (ADR 0060): the effect open from the Assets panel or a Particle System, or how to open one. */
export function ParticleGraphPanel() {
  const path = editor.assets.openIn(PARTICLE_GRAPH_PANEL);
  const project = editor.project.current;
  if (!project) return <Panel><EmptyState compact title="No project open" /></Panel>;
  if (!path || !project.files.includes(path)) {
    return (
      <Panel>
        <EmptyState compact title="Double-click a particle effect (*.particles.json) in the Assets panel, or click Open in Particle Graph on a Particle System." />
      </Panel>
    );
  }
  return (
    <Panel>
      <ParticleGraphEditor key={path} project={project} path={path} />
    </Panel>
  );
}
