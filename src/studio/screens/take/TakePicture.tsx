// The take's pictures on the Take screen (ADR 0334 "The Take screen": the picture lane): the filmstrip lane under the
// ruler (thumbnails spaced so none overlap, the one on screen at the playhead marked and always shown; a click moves the
// playhead there) and the picture at the playhead, larger, in the Inspector. The JPEGs become object URLs once per take
// and are revoked when it closes. Views over props.
import { useEffect, useMemo } from "preact/hooks";
import type { TakeFrame } from "../../../engine/audio/take/types";
import { formatTime, type TimeAxis } from "../../components/timeAxis";
import { pictureStrip } from "./takeTimeline";

/** Thumbnail width on the lane, px. */
const THUMB_W = 64;

/** One object URL per picture, revoked when the pictures change or the view goes. */
export function useFrameUrls(frames: readonly TakeFrame[]): readonly string[] {
  const urls = useMemo(() => frames.map((f) => URL.createObjectURL(new Blob([f.jpeg as BlobPart], { type: "image/jpeg" }))), [frames]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

export interface PictureLaneProps {
  readonly frames: readonly TakeFrame[];
  readonly axis: TimeAxis;
  /** The playhead, take seconds. */
  readonly time: number;
  onSeek(t: number, done: boolean): void;
}

/** The filmstrip lane: a row of the timeline. */
export function PictureLane(props: PictureLaneProps) {
  const { frames, axis } = props;
  const urls = useFrameUrls(frames);
  const { shown, current } = pictureStrip(frames, axis.toX, THUMB_W + 2, props.time);
  return (
    <div class="tk-row tk-picture-row">
      <div class="tk-head">
        <span class="tk-head-name">Picture</span>
        <span class="tk-head-sub">{frames.length === 1 ? "1 frame" : `${frames.length} frames`}</span>
      </div>
      <div class="tk-lane tk-picture" role="group" aria-label="Pictures of the game view">
        {shown.map((i) => {
          const f = frames[i]!;
          return (
            <button
              key={i}
              type="button"
              class={`tk-thumb${i === current ? " current" : ""}`}
              style={{ left: `${axis.toX(f.t)}px`, width: `${THUMB_W}px` }}
              aria-label={`Picture at ${formatTime(f.t)}`}
              aria-current={i === current ? "true" : undefined}
              title={formatTime(f.t)}
              onClick={(e) => {
                e.stopPropagation();
                props.onSeek(f.t, true);
              }}
            >
              <img src={urls[i]} alt="" />
            </button>
          );
        })}
      </div>
    </div>
  );
}

/** The picture on screen at the playhead, for the Inspector; nothing for a take without pictures. */
export function PlayheadPicture(props: { readonly frame: TakeFrame | null }) {
  const f = props.frame;
  const one = useMemo(() => (f ? [f] : []), [f]);
  const [url] = useFrameUrls(one);
  if (!f || !url) return null;
  return (
    <figure class="tk-picture-now">
      <img src={url} width={f.width} height={f.height} alt={`The game view at ${formatTime(f.t)}`} />
      <figcaption>Game view at {formatTime(f.t)}</figcaption>
    </figure>
  );
}
