// ADR 0158 §4: a clip's loop points, wherever they come from. Contract C1 of the M2 build plan
// (docs/plans/2026-11-audio-events-m2-waves.md): the signatures are final; E4.2 fills the bodies and E4.5 makes plain
// looping clips use them.
//
// Precedence: a clip's sidecar (`loopStart`/`loopEnd` seconds in `<clip>.meta.json`, ADR 0040) wins over the file's own
// points (WAV `smpl`, Ogg/Opus `LOOPSTART`/`LOOPLENGTH`). Until E4.5, only an event's `loopRegion`/`sustain` asks for
// them; a plain looping `AudioSource` keeps looping the whole clip.
//
// The sidecar is read at call time through `Assets.importSettings` (sync, cached, follows sidecar edits). The file's
// points are pushed in by `setFileLoopPoints`: by the clip registry from the decoder's `ClipInfo` (core path) or by
// the Babylon path from `readLoopPoints` (loopPointsReader.ts). A clip whose file has no points is reported as null,
// so waiters resolve either way.

import { Assets, fetchAssetBytes } from "../../../engine/scene/Assets";
import { fileSampleRate, readLoopPoints } from "./loopPointsReader";
import { onAudioSessionReleased } from "./audioSession";
import { normalizeAssetPath } from "../../../engine/scene/assetPath";

/** A loop region in seconds; `end` is exclusive. */
export interface LoopPoints {
  readonly start: number;
  readonly end: number;
}

/** What the files said, by clip path: absent = not decoded/read yet, null = decoded and has no loop points. */
const fileByPath = new Map<string, LoopPoints | null>();
const waiters = new Map<string, Set<(points: LoopPoints | null) => void>>();

/** `known` is false while the answer still waits on the decoder; `points` is then null. */
function resolve(path: string): { known: boolean; points: LoopPoints | null } {
  const side = Assets.importSettings(path);
  if (side.loopStart !== null && side.loopEnd !== null) return { known: true, points: { start: side.loopStart, end: side.loopEnd } };
  const file = fileByPath.get(path);
  if (file === undefined) return { known: false, points: null };
  // A lone sidecar key overrides just its own end of the file's region.
  const start = side.loopStart ?? file?.start ?? (side.loopEnd !== null ? 0 : null);
  const end = side.loopEnd ?? file?.end ?? null;
  if (start === null || end === null || !(end > start)) return { known: true, points: null };
  return { known: true, points: { start, end } };
}

/** The clip's loop points (sidecar over file), or null when it has none or they aren't known yet. */
export function loopPointsFor(path: string): LoopPoints | null {
  return resolve(normalizeAssetPath(path)).points;
}

/** Records the points the decoder (core path) or the TypeScript reader (Babylon path) found in the file at `path`. */
export function setFileLoopPoints(path: string, points: LoopPoints | null): void {
  const key = normalizeAssetPath(path);
  fileByPath.set(key, points);
  const set = waiters.get(key);
  if (!set || set.size === 0) return;
  const { known, points: resolved } = resolve(key);
  if (!known) return;
  waiters.delete(key);
  for (const cb of [...set]) {
    try {
      cb(resolved);
    } catch (err) {
      console.warn("[myco] audio: a loop-points callback threw:", err);
    }
  }
}

/**
 * Calls `cb` once when `path`'s loop points become known (at once if they already are); points arrive asynchronously
 * from the decoder, so they are usually unknown at PLAY. Returns an unsubscribe function.
 */
export function onLoopPoints(path: string, cb: (points: LoopPoints | null) => void): () => void {
  const key = normalizeAssetPath(path);
  const now = resolve(key);
  if (now.known) {
    cb(now.points);
    return () => {};
  }
  let set = waiters.get(key);
  if (!set) waiters.set(key, (set = new Set()));
  set.add(cb);
  return () => {
    const s = waiters.get(key);
    if (!s) return;
    s.delete(cb);
    if (s.size === 0) waiters.delete(key);
  };
}

/** A released session (ADR 0218) forgets what the files said: the next project's files may differ under the same paths. Waiters stay subscribed. */
onAudioSessionReleased(() => {
  fileByPath.clear();
  scans.clear();
});

/**
 * Converts frames from a decode (`ClipInfo.loopStartFrame/loopEndFrame`) or from `readLoopPoints` to seconds and
 * records them (null when the file has none or the sample rate is unusable).
 */
export function setFileLoopFrames(path: string, frames: { start: number; end: number } | null, sampleRate: number): void {
  if (!frames || !(sampleRate > 0) || !(frames.end > frames.start)) return setFileLoopPoints(path, null);
  setFileLoopPoints(path, { start: frames.start / sampleRate, end: frames.end / sampleRate });
}

/** Records the loop points stored in `bytes`, a clip's encoded file (the Babylon path's fetch). Never throws. */
function scanFileLoopPoints(path: string, bytes: Uint8Array): void {
  let frames: { start: number; end: number } | null = null;
  let rate: number | null = null;
  try {
    frames = readLoopPoints(bytes);
    rate = frames ? fileSampleRate(bytes) : null;
  } catch {
    frames = null;
  }
  setFileLoopFrames(normalizeAssetPath(path), frames, rate ?? 0);
}

const scans = new Map<string, Promise<void>>();

/**
 * Fetches `url` (`Assets.url(path)`) and records its file's loop points; once per path (a repeat returns the first
 * call's promise). A fetch failure records "none" so waiters resolve. For backends that never hold the bytes
 * themselves (the Babylon fallback hands the URL to the engine).
 */
export function loadFileLoopPoints(path: string, url: string): Promise<void> {
  const key = normalizeAssetPath(path);
  let p = scans.get(key);
  if (!p) {
    p = fetchAssetBytes(url).then(
      (bytes) => scanFileLoopPoints(key, bytes),
      () => setFileLoopPoints(key, null),
    );
    scans.set(key, p);
  }
  return p;
}
