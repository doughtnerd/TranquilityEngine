// A preview's frame clock (ADR 0373, T18b): advances a `ClipPlayhead` by the real time between animation frames while it plays.
import { useEffect } from "preact/hooks";
import type { ClipPlayhead } from "./clipPreviewLogic";

export function usePlayheadClock(playhead: ClipPlayhead): void {
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
}
