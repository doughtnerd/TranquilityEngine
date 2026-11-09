import { openParticleGraph } from "../particleAssets";
import { ParticleGraphEditor } from "./particleGraph/GraphEditor";
import { editor } from "../../../../editor/sdk";
import "./particleGraph/particleGraph.css";

/** The Particle Graph panel (ADR 0060): the effect open from the Assets panel or a Particle System, or how to open one. */
export function ParticleGraphPanel() {
  const path = openParticleGraph.value;
  const project = editor.project.current;
  if (!project) return <p class="empty">No project open</p>;
  if (!path || !project.files.includes(path)) {
    return (
      <div class="particle-graph-empty">
        <p>
          Double-click a particle effect (<code>*.particles.json</code>) in the Assets panel, or click Open in Particle Graph on a Particle System.
        </p>
      </div>
    );
  }
  return <ParticleGraphEditor key={path} project={project} path={path} />;
}
