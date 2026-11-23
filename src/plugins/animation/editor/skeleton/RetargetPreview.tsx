// The retarget card's side-by-side preview (ADR 0373 "A side-by-side retarget preview"; T18b): the source model and the
// target model stand in one preview World, the source playing its clip and the target playing the clip retargeted onto it
// (the bake's compile step, `retargetClipBytes`, served from memory), both at the same playhead, so the result shows
// before it is baked. The map and profile are the draft's, so a change above shows at once. Without a source, or when the
// bake can't run yet (`problem`), the models show at rest.
import { useEffect, useMemo, useState } from "preact/hooks";
import { LargePreview, editor, type EditorProject } from "../../../../editor/sdk";
import { readClipInfo } from "../../runtime/assetInfo";
import { ClipPlayhead } from "../scene/clipPreviewLogic";
import { PosedClipPreview, prepareClip } from "../scene/posedPreview";
import { usePlayheadClock } from "../scene/usePlayheadClock";
import { usePosedScene } from "../scene/usePosedScene";
import type { BoneMap } from "./boneMapLogic";
import { projectRetargetEnv } from "./retargetEnv";
import { retargetClipBytes, sourceClipRef } from "./retargetLogic";

const seconds = (t: number) => `${t.toFixed(2)} s`;

export interface RetargetPreviewProps {
  readonly project: EditorProject;
  /** The target model (the one whose Import Settings are open). */
  readonly path: string;
  /** The source model and clip, or null before they're chosen. */
  readonly source: { readonly model: string; readonly clip: string } | null;
  /** The draft's profile reference and bone map for the target. */
  readonly profile: string | null;
  readonly boneMap: BoneMap;
  /** Why the retarget can't run yet (an empty map, a missing role), or null. */
  readonly problem: string | null;
}

export function RetargetPreview(props: RetargetPreviewProps) {
  const { project, path, source, profile, boneMap, problem } = props;
  const sourceModel = source?.model ?? null;
  const posed = usePosedScene(sourceModel ? [{ role: "Source", path: sourceModel }, { role: "Target", path }] : [{ role: "Target", path }]);
  const driver = useMemo(() => new PosedClipPreview(), []);
  useEffect(() => () => driver.dispose(), [driver]);
  const playhead = useMemo(() => new ClipPlayhead(), []);
  usePlayheadClock(playhead);
  const [error, setError] = useState<string | null>(null);
  const version = editor.project.version;
  const request = source && problem === null ? JSON.stringify([source.model, source.clip, path, profile, boneMap, version]) : null;
  useEffect(() => {
    driver.setClip("Source", null);
    driver.setClip("Target", null);
    setError(null);
    if (!source || request === null) return;
    let live = true;
    void prepareClip(driver.files, sourceClipRef(source.model, source.clip)).then((clip) => {
      if (!live) return;
      driver.setClip("Source", clip);
      if (clip) playhead.setTiming({ duration: clip.duration, looping: true, known: true });
    });
    void retargetClipBytes(projectRetargetEnv(project), { source: source.model, clip: source.clip, target: { model: path, profile, boneMap } }).then((out) => {
      if (!live) return;
      if (!out.ok) return setError(out.error);
      const info = readClipInfo(out.bytes);
      driver.setClip("Target", info ? { path: driver.files.serveBytes(out.bytes, "retargeted.anim.bin"), duration: info.duration, looping: info.looping } : null);
    });
    return () => void (live = false);
  }, [driver, request]);
  driver.setTime(playhead.time.value);
  const time = playhead.time.value;
  const playing = playhead.playing.value;
  const duration = playhead.duration;
  return (
    <div class="retarget-previews" aria-label="Retarget preview">
      <div class="retarget-titles">
        {sourceModel && <span class="retarget-side-title">Source: {editor.assets.fileName(sourceModel)}</span>}
        <span class="retarget-side-title">Target: {editor.assets.fileName(path)}</span>
      </div>
      <LargePreview path={path} posed={posed.scene ? driver.content(posed.key, posed.scene) : undefined} />
      {sourceModel && (
        <div class="clip-preview-controls">
          <button type="button" aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={() => playhead.toggle()}>
            {playing ? "❚❚" : "▶"}
          </button>
          <input type="range" aria-label="Clip time" min={0} max={duration} step={Math.max(duration / 1000, 0.001)} value={time} onInput={(e) => playhead.seek(Number((e.currentTarget as HTMLInputElement).value))} />
          <span class="clip-preview-time">
            {seconds(time)} / {seconds(duration)}
          </span>
        </div>
      )}
      {!sourceModel && <p class="skeleton-note">Choose a source model and clip to see them side by side.</p>}
      {sourceModel && problem !== null && <p class="skeleton-note">Both models show at rest: {problem}</p>}
      {error && (
        <p class="retarget-problem" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
