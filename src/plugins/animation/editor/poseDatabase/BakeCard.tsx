// The pose database tool's Bake card (ADR 0373 "bake in the worker (0370) with progress"; T55): the Bake button, its progress
// by stage (the skeleton, each clip, the bake in the bake worker, the write), the problems and warnings a bake reports, and
// the summary of the baked file beside the source (frames, size, clips, tags). The debug view toggle sits here too: it is
// the scene view's trajectory and matched-frame drawing while playing (`poseDbDebug.ts`).
import { useState } from "preact/hooks";
import { editor, type EditorProject } from "../../../../editor/sdk";
import type { PoseDatabaseSource } from "../../../../engine/animation/poseDatabase";
import { bakePoseDatabaseSource, progressFraction, type BakeProgress, type PoseDbBakeEnv, type PoseDbBakeOutcome } from "./bakeLogic";
import { bakedPathOf } from "./poseDbLogic";
import { matchDebugSource, matchDebugView } from "./poseDbDebug";
import { projectPoseDbEnv } from "./poseDbEnv";
import { useBakedSummary } from "./poseDbHooks";
import { BakedSummary } from "./BakedSummary";
import "./poseDatabase.css";

export interface BakeCardProps {
  /** The source's project path. */
  readonly path: string;
  readonly db: PoseDatabaseSource;
  readonly project: EditorProject;
  readonly disabled?: boolean;
  /** What the bake reads and writes (default: the open project's). */
  readonly env?: PoseDbBakeEnv;
}

export function BakeCard(props: BakeCardProps) {
  const { path, db, project, disabled } = props;
  const [progress, setProgress] = useState<BakeProgress | null>(null);
  const [outcome, setOutcome] = useState<PoseDbBakeOutcome | null>(null);
  const baked = bakedPathOf(path);
  const summary = useBakedSummary(baked, `${editor.project.version}`);
  const busy = progress !== null;
  const why = disabled ? "This project can't be changed." : db.sources.length === 0 ? "Add a clip first." : null;

  const bake = async () => {
    setOutcome(null);
    setProgress({ stage: "skeleton", done: 0, total: 1, label: "Starting" });
    const result = await bakePoseDatabaseSource(props.env ?? projectPoseDbEnv(project), path, db, setProgress);
    setProgress(null);
    setOutcome(result);
    if (result.ok) {
      editor.project.changed();
      editor.messages.info(`Baked ${editor.assets.fileName(path)} into ${editor.assets.fileName(result.path)}.`);
    } else editor.messages.error(`Can't bake ${editor.assets.fileName(path)}: ${result.error}`);
  };

  return (
    <div class="component asset-import-card posedb-bake">
      <h3>Bake</h3>
      <div class="posedb-actions">
        <button class="primary" disabled={busy || why !== null} title={why ?? `Bake the frames of the tagged ranges into ${baked}`} onClick={() => void bake()}>
          {busy ? "Baking…" : "Bake"}
        </button>
        {why && <span class="posedb-note">{why}</span>}
      </div>
      {progress && (
        <div class="posedb-progress" role="status" aria-label="Bake progress">
          <progress max={1} value={progressFraction(progress)} aria-label="Bake progress" />
          <span class="posedb-note">{progress.label}</span>
        </div>
      )}
      {outcome && !outcome.ok && (
        <p class="posedb-problem" role="alert">
          {outcome.error}
        </p>
      )}
      {outcome?.ok && (
        <p class="posedb-result" role="status">
          Wrote {outcome.path}.
        </p>
      )}
      {outcome?.ok && outcome.warnings.length > 0 && (
        <ul class="posedb-warnings" aria-label="Bake warnings">
          {outcome.warnings.map((w) => (
            <li key={w}>{w}</li>
          ))}
        </ul>
      )}
      <h4 class="posedb-heading">Baked file</h4>
      {summary ? <BakedSummary summary={summary} path={baked} /> : <p class="posedb-note">Not baked yet: {baked} doesn't exist beside the source.</p>}
      <h4 class="posedb-heading">Debug view</h4>
      <label class="import-row" title="While the game plays, draw the selected Animator's predicted trajectory and matched frame in the scene view">
        <span>Show in viewport</span>
        <input type="checkbox" aria-label="Show the match debug view in the viewport" checked={matchDebugView.value} onChange={(e) => (matchDebugView.value = (e.currentTarget as HTMLInputElement).checked)} />
      </label>
      <p class="posedb-note">
        {matchDebugSource.value
          ? "While playing, the selected Animator's predicted trajectory (blue) and its matched frame's (green) are drawn in the scene view."
          : "Nothing feeds the view yet: the animation host doesn't read the core's match report, so the scene view draws nothing until it does."}
      </p>
    </div>
  );
}
