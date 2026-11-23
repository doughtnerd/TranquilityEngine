// A take's pictures on a time axis (ADR 0348: the Take screen's picture lane and the Profiler's Picture track): a row
// of thumbnails spaced so none overlap, the one on screen at the playhead marked and always shown; a click seeks there.
// The JPEGs become object URLs once per set of pictures and are revoked when it changes or the view goes. A view over
// props (`filmstripModel.ts` decides what shows).
import { useEffect, useMemo } from "preact/hooks";
import type { TakeFrame } from "../../engine/audio/take/types";
import { pictureStrip } from "./filmstripModel";
import { formatTime } from "./timeAxis";
import "./audioParts.css";

/** One object URL per picture, revoked when the pictures change or the view goes. */
export function useFrameUrls(frames: readonly TakeFrame[]): readonly string[] {
  const urls = useMemo(() => frames.map((f) => URL.createObjectURL(new Blob([f.jpeg as BlobPart], { type: "image/jpeg" }))), [frames]);
  useEffect(() => () => urls.forEach((u) => URL.revokeObjectURL(u)), [urls]);
  return urls;
}

export interface FilmstripProps {
  readonly frames: readonly TakeFrame[];
  /** A picture's time (seconds on the strip's axis) as px from the strip's left edge. */
  toX(t: number): number;
  /** The playhead, the same axis's seconds. */
  readonly time: number;
  /** Thumbnail width, px (default 64). */
  readonly thumbWidth?: number;
  onSeek(t: number): void;
}

export function Filmstrip(props: FilmstripProps) {
  const { frames } = props;
  const w = props.thumbWidth ?? 64;
  const urls = useFrameUrls(frames);
  const { shown, current } = pictureStrip(frames, props.toX, w + 2, props.time);
  return (
    <div class="studio-filmstrip" role="group" aria-label="Pictures of the game view">
      {shown.map((i) => {
        const f = frames[i]!;
        return (
          <button
            key={i}
            type="button"
            class={`studio-thumb${i === current ? " current" : ""}`}
            style={{ left: `${props.toX(f.t)}px`, width: `${w}px` }}
            aria-label={`Picture at ${formatTime(f.t)}`}
            aria-current={i === current ? "true" : undefined}
            title={formatTime(f.t)}
            onClick={(e) => {
              e.stopPropagation();
              props.onSeek(f.t);
            }}
          >
            <img src={urls[i]} alt="" />
          </button>
        );
      })}
    </div>
  );
}
