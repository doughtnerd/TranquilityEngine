// One review position for Take and the Profiler (spec §2.16, §4.5.7; the prototype's `myco.review`): while the Profiler
// shows a capture backed by a take (a take file opened as a capture, or a replay capture naming its take) and that take is
// open in the Studio's replay, the Profiler's cursor and the take's replay time are one position. Moving either moves the
// other; a take opened after the capture ("Open in Take") lands at the Profiler's cursor, and a capture opened after the
// take (a replay capture just saved) shows the take's position. A live recording is never linked: its cursor follows the
// newest block. Times are the same seconds on both sides (a replay capture starts with its replay at 0, `profileReplay`),
// each clamped to its own length. Pure over signals: the page links the real stores (`profilerScreen.ts`), tests fakes.
import { effect, type ReadonlySignal } from "@preact/signals";
import type { CaptureReplayOf } from "../../../plugins/audio/runtime/capture/format";
import { isTakePath } from "../run/captureTree";

/** What the link reads of the Profiler's open capture (`ProfilerStore.state`'s open form). */
export type ReviewCapture =
  | { readonly kind: "open"; readonly origin: "file" | "live"; readonly path: string | null; readonly replayOf: CaptureReplayOf | null; readonly take: boolean }
  | { readonly kind: "none" | "opening" | "failed" };

/** The Profiler's side of the link (a `ProfilerStore`). */
export interface ReviewProfiler {
  readonly state: ReadonlySignal<ReviewCapture>;
  readonly data: ReadonlySignal<{ readonly duration: number } | null>;
  readonly cursor: ReadonlySignal<number>;
  seekTo(t: number): void;
}

/** The Studio's replay side of the link (a `ReplayStore`). */
export interface ReviewReplay {
  readonly open: ReadonlySignal<{
    readonly path: string;
    readonly take: { readonly duration: number };
    readonly replay: { readonly time: ReadonlySignal<number>; seek(t: number): void };
  } | null>;
}

/** The take file a capture is backed by: itself when it holds take data, else the take a replay capture names; null for a live recording or none. */
export function takeOfCapture(state: ReviewCapture): string | null {
  if (state.kind !== "open" || state.origin !== "file") return null;
  // ADR 0409: every recording is a `.sporesample`; one with take data (META `take`) is its own take.
  if (state.take && state.path && isTakePath(state.path)) return state.path;
  return state.replayOf?.path ?? null;
}

/** Positions closer than this are the same (a frame is ~16 ms). */
const SAME = 1e-3;

/** Link the Profiler's cursor and the take replay into one review position; returns the unlink. */
export function linkReview(profiler: ReviewProfiler, replay: ReviewReplay): () => void {
  let seen = { state: profiler.state.peek() as ReviewCapture, open: replay.open.peek() };
  let seq = 0;
  let captureAt = 0;
  let takeAt = 0;
  return effect(() => {
    const state = profiler.state.value;
    const open = replay.open.value;
    const data = profiler.data.value;
    if (state !== seen.state) captureAt = ++seq;
    if (open !== seen.open) takeAt = ++seq;
    seen = { state, open };
    const takePath = takeOfCapture(state);
    if (!takePath || !open || open.path !== takePath || !data) return;
    const takeLength = open.take.duration;
    const captureLength = data.duration;
    // One position: the cursor (past the take's end, the take's end) and the take's time (past the capture's end, the
    // capture's end) agree.
    const inStep = () => Math.abs(Math.min(profiler.cursor.peek(), takeLength) - Math.min(open.replay.time.peek(), captureLength)) < SAME;
    if (!inStep()) {
      // The side opened last follows the other: a take opened from the Profiler lands at its cursor.
      if (takeAt > captureAt) open.replay.seek(profiler.cursor.peek());
      else profiler.seekTo(open.replay.time.peek());
    }
    const stops = [
      effect(() => {
        void open.replay.time.value;
        if (!inStep()) profiler.seekTo(open.replay.time.peek());
      }),
      effect(() => {
        void profiler.cursor.value;
        if (!inStep()) open.replay.seek(profiler.cursor.peek());
      }),
    ];
    return () => {
      for (const stop of stops) stop();
    };
  });
}
