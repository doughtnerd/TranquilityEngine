// The clip preview in the Asset Inspector (ADR 0373; T18): an authored (`*.anim.json`), compiled (`*.anim.bin`) or model
// clip, shown on its model (a model's own clip) or on a model dragged onto it, in the Inspector's live model preview,
// with play/pause and a time scrubber. The model side (which model, the clip's length, the playhead) is
// `clipPreviewLogic.ts`.
//
// The preview poses the model at the playhead (T18b): the live preview hosts a World of its own (`LargePreview`'s `posed`),
// and `PosedClipPreview` plays the clip on its Animator through the runtime at speed 0 from the playhead's normalised time,
// scrubbing and playing alike. A model without a skeleton shows at rest.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import { editor, LargePreview, registerAssetDropTarget } from "../../../../editor/sdk";
import { clipName } from "./clipDrop";
import { PosedClipPreview, prepareClip } from "./posedPreview";
import { usePosedScene } from "./usePosedScene";
import { ClipPlayhead, clipTiming, modelOfClip, previewModel, type ClipTiming } from "./clipPreviewLogic";
import "./scene.css";

const isModel = (entry: string) => editor.assets.kindOf(entry) === "model";
const ROLE = "Preview";
const seconds = (t: number) => `${t.toFixed(2)} s`;

/** The drop zone that takes a model to preview the clip on. */
function ModelDrop(props: { onModel: (path: string) => void; children: ComponentChildren; class: string }) {
  const zone = useRef<HTMLDivElement>(null);
  const [over, setOver] = useState(false);
  useEffect(() => {
    const el = zone.current;
    if (!el) return;
    return registerAssetDropTarget(el, {
      accepts: (assets) => assets.length === 1 && isModel(assets[0]!),
      label: (assets) => `Preview the clip on ${assets[0]!.split("/").pop()}`,
      drop: (assets) => props.onModel(assets[0]!),
      over: () => setOver(true),
      leave: () => setOver(false),
    });
  }, []);
  return (
    <div ref={zone} class={`${props.class}${over ? " over" : ""}`}>
      {props.children}
    </div>
  );
}

export function ClipPreview(props: { path: string }) {
  const { path } = props;
  const model = previewModel(path);
  const playhead = useMemo(() => new ClipPlayhead(), [path]);
  const [timing, setTiming] = useState<ClipTiming | null>(null);
  useEffect(() => {
    let live = true;
    void clipTiming(path).then((t) => {
      if (!live) return;
      playhead.setTiming(t);
      setTiming(t);
    });
    return () => void (live = false);
  }, [path, playhead]);
  // The preview's frame clock: the playhead advances while playing.
  useEffect(() => {
    let frame = 0;
    let last: number | null = null;
    const step = (now: number) => {
      if (last !== null) playhead.advance((now - last) / 1000);
      last = now;
      frame = requestAnimationFrame(step);
    };
    frame = requestAnimationFrame(step);
    return () => cancelAnimationFrame(frame);
  }, [playhead]);

  const own = modelOfClip(path);
  const shown = model.value;
  const time = playhead.time.value;
  // The posed preview: the clip served from memory and played on the preview World's Animator at the playhead.
  const driver = useMemo(() => new PosedClipPreview(), [path]);
  useEffect(() => () => driver.dispose(), [driver]);
  const version = editor.project.version;
  useEffect(() => {
    let live = true;
    void prepareClip(driver.files, path).then((clip) => live && driver.setClip(ROLE, clip));
    return () => void (live = false);
  }, [driver, path, version]);
  driver.setTime(time);
  const posed = usePosedScene([{ role: ROLE, path: shown }]);
  const playing = playhead.playing.value;
  const duration = timing?.duration ?? 1;
  return (
    <div class="clip-preview">
      <h3 class="clip-preview-title">{clipName(path)}</h3>
      {shown ? (
        <>
          <ModelDrop class="clip-preview-model" onModel={(m) => (model.value = m)}>
            <span>On</span>
            <span class="clip-preview-model-name" title={shown}>
              {shown.split("/").pop()}
            </span>
            {!own && <span>(drop another model here to change it)</span>}
          </ModelDrop>
          <LargePreview path={shown} posed={posed.scene ? driver.content(posed.key, posed.scene) : undefined} />
        </>
      ) : (
        <ModelDrop class="clip-preview-drop" onModel={(m) => (model.value = m)}>
          Drag a model here to preview the clip on it
        </ModelDrop>
      )}
      <div class="clip-preview-controls">
        <button type="button" aria-label={playing ? "Pause" : "Play"} aria-pressed={playing} onClick={() => playhead.toggle()}>
          {playing ? "❚❚" : "▶"}
        </button>
        <input
          type="range"
          aria-label="Time"
          min={0}
          max={duration}
          step={Math.max(duration / 1000, 0.001)}
          value={time}
          onInput={(e) => playhead.seek(Number((e.currentTarget as HTMLInputElement).value))}
        />
        <span class="clip-preview-time" aria-live="off">
          {seconds(time)} / {seconds(duration)}
        </span>
      </div>
      {timing && !timing.known && <p class="clip-preview-note">The clip's length isn't known until it's imported and compiled; the scrubber spans one second.</p>}
      {shown && posed.state === "none" && <p class="clip-preview-note">The model has no skeleton, so it shows at rest.</p>}
    </div>
  );
}
