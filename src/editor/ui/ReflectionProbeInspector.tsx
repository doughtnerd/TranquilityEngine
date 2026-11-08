// Under a ReflectionProbe's fields in the Inspector (ADR 0110): the Bake button.
import { useState } from "preact/hooks";
import { bakeOpenSceneProbe } from "../probeBake";
import { currentProject, type OpenScene } from "../state";
import "./navBake.css";
import type { InspectorSectionProps } from "./inspectorSections";

export function ReflectionProbeBake(props: { scene: OpenScene; nodeId: string }) {
  const { scene, nodeId } = props;
  const project = currentProject.value;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!project) return null;
  const run = async () => {
    setBusy(true);
    setError(null);
    try {
      await bakeOpenSceneProbe(scene, nodeId, project);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div class="nav-chunk-bake" aria-label="Reflection probe bake">
      <div class="nav-chunk-bake-row">
        <button disabled={!project.canSave || busy} title={project.canSave ? "Capture this probe into a .env file" : "Read-only project: open a project folder to bake"} onClick={() => void run()}>
          {busy ? "Baking…" : "Bake"}
        </button>
        <span class="nav-chunk-bake-status" aria-live="polite">{!project.canSave ? "Read-only: open a project folder to bake." : ""}</span>
      </div>
      {error && <p class="nav-chunk-error" role="alert">{error}</p>}
    </div>
  );
}

/** The Inspector section under a top-level ReflectionProbe (ADR 0131). */
export function ReflectionProbeSection({ scene, paths }: InspectorSectionProps) {
  return <ReflectionProbeBake scene={scene} nodeId={paths[0][0]} />;
}
