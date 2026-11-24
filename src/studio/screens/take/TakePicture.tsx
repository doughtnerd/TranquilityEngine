// The take's pictures on the Take screen (ADR 0348 "The Take screen": the picture lane): the filmstrip lane under the
// ruler (the kit's `Filmstrip`; a click moves the playhead there) and the picture at the playhead, larger, in the
// Inspector. Views over props.
import { useEffect, useMemo, useRef, useState } from "preact/hooks";
import type { TakeFrame } from "../../../engine/audio/take/types";
import { Filmstrip, useFrameUrls } from "../../components/Filmstrip";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
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

/**
 * The picture on screen at the playhead, for the Inspector, the panel's full width; a click (or Enter) shows it as large
 * as the window allows, following the playhead, until Escape, a click or Close (ADR 0408). Nothing for a take without
 * pictures.
 */
export function PlayheadPicture(props: { readonly frame: TakeFrame | null }) {
  const f = props.frame;
  const one = useMemo(() => (f ? [f] : []), [f]);
  const [url] = useFrameUrls(one);
  const [big, setBig] = useState(false);
  const opener = useRef<HTMLButtonElement>(null);
  const close = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!big) return;
    close.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopPropagation();
      setBig(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      opener.current?.focus();
    };
  }, [big]);
  if (!f || !url) return null;
  const alt = `The game view at ${formatTime(f.t)}`;
  return (
    <figure class="tk-picture-now">
      <button ref={opener} type="button" class="tk-picture-open" title="Show the game view larger" aria-label={`${alt}: show it larger`} onClick={() => setBig(true)}>
        <img src={url} width={f.width} height={f.height} alt={alt} />
      </button>
      <figcaption>
        Game view at {formatTime(f.t)} · {f.width}×{f.height}
      </figcaption>
      {big && (
        <FloatingPortal>
        <div class="tk-picture-big" role="dialog" aria-modal="true" aria-label={`Game view at ${formatTime(f.t)}`} onClick={() => setBig(false)}>
          <img src={url} width={f.width} height={f.height} alt={alt} />
          <div class="tk-picture-big-bar">
            <span>
              Game view at {formatTime(f.t)} · {f.width}×{f.height}
            </span>
            <button ref={close} type="button" class="tk-btn" onClick={() => setBig(false)}>
              Close
            </button>
          </div>
        </div>
        </FloatingPortal>
      )}
    </figure>
  );
}
