// Moving emitters while the Spatial screen plays (ADR 0347; owner: "an emitter follow a path … I do want that to
// actually work"). The Studio's Engine steps its World every animation frame (`engineRuntime.ts`: `engine.start()`), so
// the test scene player's route movers advance with real `dt` and the runtime's Doppler pass hears the motion. This
// module is the screen's side: a frame loop tied to Play and Stop that reads where each emitter is now
// (`AudioTestScenePlayer.motion`) once per animation frame, skipping frames while the window is hidden, and what the
// plan view and the Inspector's readout show from it: the live place and direction of a moving emitter, its speed, its
// distance and its Doppler ratio. Stopped, there is no motion, so everything shows the authored start again.
//
// Pure apart from `animationFrames` (the browser's frames): no signals.
import type { TestSceneMotionRow, TestSceneVoiceRow } from "../../../plugins/audio/runtime/testScene/player";
import type { Vec3 } from "../../../engine/audio/spatial/testSceneTypes";
import { positionOf, type SceneObject } from "./sceneEdits";

/** Where animation frames come from (the browser's, or a test's). */
export interface FrameSource {
  /** Call `cb` on the next animation frame, with its timestamp in ms; returns a handle for `cancel`. */
  request(cb: (now: number) => void): number;
  cancel(handle: number): void;
  /** Whether the window is hidden now (minimised, another tab): frames then do nothing. */
  hidden(): boolean;
}

/** The browser's animation frames and visibility. */
export const animationFrames: FrameSource = {
  request: (cb) => requestAnimationFrame(cb),
  cancel: (h) => cancelAnimationFrame(h),
  hidden: () => typeof document !== "undefined" && document.visibilityState === "hidden",
};

/**
 * Run `onFrame(dt)` once per animation frame until the returned stop is called; `dt` is the real seconds since the last
 * frame that ran (0 for the first, and for the first after the window was hidden). Frames while hidden don't run.
 */
export function startFrameLoop(onFrame: (dt: number) => void, frames: FrameSource = animationFrames): () => void {
  let last: number | null = null;
  let handle = 0;
  let stopped = false;
  const tick = (now: number) => {
    if (stopped) return;
    if (frames.hidden()) last = null;
    else {
      const dt = last === null ? 0 : Math.max(0, (now - last) / 1000);
      last = now;
      onFrame(dt);
    }
    if (!stopped) handle = frames.request(tick);
  };
  handle = frames.request(tick);
  return () => {
    stopped = true;
    frames.cancel(handle);
  };
}

const sameVec = (a: Vec3 | null, b: Vec3 | null) => a === b || (!!a && !!b && a.x === b.x && a.y === b.y && a.z === b.z);

/** Whether two motion readouts are the same (a frame with nothing moving needn't redraw). */
export function sameMotion(a: readonly TestSceneMotionRow[], b: readonly TestSceneMotionRow[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i]!, y = b[i]!;
    if (x.id !== y.id || x.speed !== y.speed || !sameVec(x.position, y.position) || !sameVec(x.direction, y.direction)) return false;
  }
  return true;
}

/** What the plan draws for an emitter while playing: its live place and travel direction (null: draw it as authored). */
export interface LivePlace {
  readonly position: Vec3;
  /** Unit direction on the ground plane, for a moving emitter that's travelling. */
  readonly direction: { x: number; z: number } | null;
  readonly speed: number;
}

/** Object `o`'s live place from the readout, for a moving emitter while the scene plays; null otherwise. */
export function livePlace(o: SceneObject, motion: readonly TestSceneMotionRow[]): LivePlace | null {
  if (o.kind !== "emitter" || o.obj.kind !== "moving") return null;
  const row = motion.find((m) => m.id === o.obj.id);
  if (!row) return null;
  const d = row.direction && row.speed > 0 ? { x: row.direction.x, z: row.direction.z } : null;
  return { position: row.position, direction: d && Math.hypot(d.x, d.z) > 0 ? d : null, speed: row.speed };
}

/** Where to draw `o` now: its live place while it moves, else where the scene puts it (a moving emitter: its start). */
export const placeNow = (o: SceneObject, motion: readonly TestSceneMotionRow[]): Vec3 | null => livePlace(o, motion)?.position ?? positionOf(o);

/** "12.0 m/s" (or "Stopped" once it arrived). */
export const speedText = (speed: number): string => (speed > 0 ? `${speed.toFixed(1)} m/s` : "Stopped");

/** Metres from `listener` to `p`, as the readout shows it. */
export const liveDistanceText = (p: Vec3, listener: Vec3): string => `${Math.hypot(p.x - listener.x, p.y - listener.y, p.z - listener.z).toFixed(1)} m`;

/**
 * The Doppler ratio folded into the voice's pitch, and the same in cents: "×1.062 · +104 ct" (higher: approaching),
 * "×1.000" when there's no shift, "—" while it isn't playing or the backend doesn't say.
 */
export function dopplerRatioText(row: TestSceneVoiceRow | undefined): string {
  if (!row || !row.playing || row.doppler === null || !(row.doppler > 0)) return "—";
  const cents = 1200 * Math.log2(row.doppler);
  if (Math.abs(cents) < 0.5) return "×1.000";
  return `×${row.doppler.toFixed(3)} · ${cents > 0 ? "+" : "−"}${Math.round(Math.abs(cents))} ct`;
}
