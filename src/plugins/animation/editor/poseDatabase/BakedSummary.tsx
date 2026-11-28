// A baked pose database's summary (ADR 0373; T55): the lines `describeSummary` makes, the clips with their frame counts and the
// tags with theirs. The Bake card shows it for the file beside the source, and it is the Inspector view of a
// `*.posedb.bin` selected in the Assets panel (`BakedPoseDatabase`).
import { editor, assetRefTarget } from "../../../../editor/sdk";
import { describeSummary, type PoseDbSummary } from "./summaryLogic";
import { useBakedSummary } from "./poseDbHooks";
import "./poseDatabase.css";

/** The summary of a baked database. */
export function BakedSummary(props: { summary: PoseDbSummary; path: string }) {
  const { summary } = props;
  return (
    <dl class="posedb-summary" aria-label={`Summary of ${props.path}`}>
      {describeSummary(summary).map((l) => (
        <div key={l.label} class="posedb-summary-row">
          <dt>{l.label}</dt>
          <dd>{l.value}</dd>
        </div>
      ))}
      <div class="posedb-summary-row">
        <dt>Clips</dt>
        <dd>
          {summary.clips.length === 0 ? (
            "none"
          ) : (
            <ul>
              {summary.clips.map((c, i) => (
                <li key={i}>
                  {assetRefTarget(c.asset)}: {c.frames} frames
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
      <div class="posedb-summary-row">
        <dt>Tags</dt>
        <dd>
          {summary.tags.length === 0 ? (
            "none"
          ) : (
            <ul>
              {summary.tags.map((t) => (
                <li key={t.name}>
                  {t.name}: {t.frames} frames
                </li>
              ))}
            </ul>
          )}
        </dd>
      </div>
    </dl>
  );
}

/** A `*.posedb.bin` selected in the Assets panel: what it holds, read from its header. */
export function BakedPoseDatabase(props: { path: string }) {
  const summary = useBakedSummary(props.path, `${editor.project.version}`);
  return (
    <div class="inspector-body asset-inspector posedb-baked" aria-label="Pose Database (baked)">
      <div class="asset-inspector-head">
        <span class="asset-inspector-kind">Pose Database (baked)</span>
        <span class="asset-inspector-name" title={props.path}>
          {editor.assets.fileName(props.path)}
        </span>
      </div>
      {summary ? <BakedSummary summary={summary} path={props.path} /> : <p class="posedb-note">This file can't be read as a baked pose database.</p>}
      <p class="posedb-note">Made by the Bake button of the pose database source beside it; it is never edited by hand.</p>
    </div>
  );
}
