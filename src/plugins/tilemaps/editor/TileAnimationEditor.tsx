// The selected tile's Animation section in the Tileset inspector (ADR 0421 "Animated tiles"): its frames (each a
// slice of the tile sprite's image, with a duration in seconds), how the cells start (together or at random offsets),
// and a live preview. The edits are `tileAnimationLogic.ts`; each is one tileset edit, and a refused one (a frame of
// another image, a duration of 0) is shown as a problem and changes nothing.
import { useEffect, useRef, useState } from "preact/hooks";
import type { TileAnimation, TileDef } from "../runtime/tileset";
import { AssetPicker, editor, type EditorProject } from "../../../editor/sdk";
import { addFrame, frameAt, moveFrame, removeFrame, setFrameDuration, setFrameSprite, setStart, type AnimationEdit } from "./tileAnimationLogic";
import { TileThumb, tileSpriteSource } from "./TileThumb";

const PREVIEW = 64;

export function TileAnimationEditor(props: { project: EditorProject; tile: TileDef; readOnly: boolean; onPatch: (patch: Partial<TileDef>, label: string) => void }) {
  const { project, tile, readOnly } = props;
  const animation = tile.animation;
  const frames = animation?.frames ?? [];
  // Remounts the sprite pickers after a pick, so Add frame shows its prompt again and a refused pick shows what the file
  // holds (a controlled select whose value didn't change keeps the DOM's choice).
  const [picks, setPicks] = useState(0);
  const apply = (edit: AnimationEdit, label: string) => {
    if (readOnly) return;
    if ("problem" in edit) {
      setPicks((n) => n + 1);
      editor.messages.error(`Can't ${label.toLowerCase()}: ${edit.problem}`);
      return;
    }
    props.onPatch({ animation: edit.animation }, label);
  };
  return (
    <div class="tile-animation" role="group" aria-label="Animation">
      <span class="tile-animation-title" title="Frames the tile cycles through in play (the edit view shows its sprite). Every frame must be a slice of the tile sprite's image.">
        Animation
      </span>
      {frames.length > 0 && (
        <div class="tile-animation-body">
          <AnimationPreview project={project} tile={tile} animation={animation!} />
          <ol class="tile-animation-frames">
            {frames.map((f, i) => (
              <li key={i}>
                <TileThumb project={project} tile={{ ...tile, sprite: f.sprite }} size={24} />
                <AssetPicker key={picks} label={`Frame ${i + 1} sprite`} kinds={["sprite"]} none={null} disabled={readOnly} value={f.sprite} onCommit={(s) => apply(setFrameSprite(animation, i, tile.sprite, s), "Set frame sprite")} />
                <input
                  type="number"
                  min={0.01}
                  step={0.05}
                  aria-label={`Frame ${i + 1} duration`}
                  title="Seconds, more than 0"
                  disabled={readOnly}
                  value={f.duration}
                  onChange={(e) => {
                    const input = e.currentTarget as HTMLInputElement;
                    const edit = setFrameDuration(animation, i, Number(input.value));
                    if ("problem" in edit) input.value = String(f.duration);
                    apply(edit, "Set frame duration");
                  }}
                />
                <span class="tile-animation-buttons">
                  <button aria-label={`Move frame ${i + 1} earlier`} title="Earlier" disabled={readOnly || i === 0} onClick={() => apply(moveFrame(animation, i, -1), "Reorder frames")}>
                    ↑
                  </button>
                  <button aria-label={`Move frame ${i + 1} later`} title="Later" disabled={readOnly || i === frames.length - 1} onClick={() => apply(moveFrame(animation, i, 1), "Reorder frames")}>
                    ↓
                  </button>
                  <button aria-label={`Remove frame ${i + 1}`} title={frames.length === 1 ? "Remove the frame (and the animation)" : "Remove the frame"} disabled={readOnly} onClick={() => apply(removeFrame(animation, i), "Remove frame")}>
                    ✕
                  </button>
                </span>
              </li>
            ))}
          </ol>
        </div>
      )}
      <div class="tile-animation-row">
        <AssetPicker
          key={picks}
          label="Add frame"
          kinds={["sprite"]}
          none="Add frame…"
          disabled={readOnly || !tile.sprite}
          value=""
          onCommit={(s) => {
            setPicks((n) => n + 1);
            if (s) apply(addFrame(animation, tile.sprite, s), "Add frame");
          }}
        />
        <label class="tile-animation-start" title="Together: every cell shows the same frame. Random: each cell starts at its own offset, the same every run.">
          <span>Start</span>
          <select aria-label="Animation start" disabled={readOnly || !animation} value={animation?.start ?? "together"} onChange={(e) => apply(setStart(animation, (e.currentTarget as HTMLSelectElement).value as "together" | "random"), "Set animation start")}>
            <option value="together">Together</option>
            <option value="random">Random</option>
          </select>
        </label>
      </div>
    </div>
  );
}

const images = new Map<string, HTMLImageElement>();
/** The image at `url`, loading (and kept) on first use. */
function imageAt(url: string): HTMLImageElement {
  let img = images.get(url);
  if (!img) {
    img = new Image();
    img.src = url;
    images.set(url, img);
  }
  return img;
}

/** The animation playing on a canvas, from when it was last changed, until the section closes. */
function AnimationPreview(props: { project: EditorProject; tile: TileDef; animation: TileAnimation }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const { project, tile, animation } = props;
  const key = JSON.stringify(animation.frames);
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext("2d");
    if (!canvas || !ctx) return;
    const sources = animation.frames.map((f) => tileSpriteSource(project, { ...tile, sprite: f.sprite }));
    const start = performance.now();
    let raf = 0;
    const draw = (now: number) => {
      raf = requestAnimationFrame(draw);
      const source = sources[frameAt(animation, (now - start) / 1000)];
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      if (!source) return;
      const img = imageAt(source.url);
      if (!img.complete || img.naturalWidth === 0) return;
      const [x, y, w, h] = source.rect ?? [0, 0, img.naturalWidth, img.naturalHeight];
      const scale = Math.min(canvas.width / w, canvas.height / h);
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(img, x, y, w, h, (canvas.width - w * scale) / 2, (canvas.height - h * scale) / 2, w * scale, h * scale);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
    // Keyed by the frames' content, not the object's identity, so an unrelated edit doesn't restart the preview.
  }, [project, tile.sprite, key]);
  return <canvas ref={ref} class="tile-animation-preview" width={PREVIEW} height={PREVIEW} role="img" aria-label="Animation preview" />;
}
