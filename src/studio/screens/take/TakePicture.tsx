// The take's pictures on the Take screen (ADR 0348 "The Take screen": the picture lane): the filmstrip lane under the
// ruler (the kit's `Filmstrip`; a click moves the playhead there) and the picture at the playhead, larger, in the
// Inspector. Views over props.
import { useMemo } from "preact/hooks";
import type { TakeFrame } from "../../../engine/audio/take/types";
import { Filmstrip, useFrameUrls } from "../../components/Filmstrip";
import { formatTime, type TimeAxis } from "../../components/timeAxis";

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
  return (
    <div class="tk-row tk-picture-row">
      <div class="tk-head">
        <span class="tk-head-name">Picture</span>
        <span class="tk-head-sub">{frames.length === 1 ? "1 frame" : `${frames.length} frames`}</span>
      </div>
      <div class="tk-lane tk-picture">
        <Filmstrip frames={frames} toX={axis.toX} time={props.time} onSeek={(t) => props.onSeek(t, true)} />
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
