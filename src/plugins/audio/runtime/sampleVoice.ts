/**
 * ADR 0342: a clip voice played with its sample plan — the one place `Audio.playOneShot`, `AudioSource` and `AudioZone`
 * apply what the clip resolver's request (`clipRequest`: level, normalisation gain, trimmed start) can't carry, because
 * it acts on the playing voice. The playlist runtime does the same for its voices with its own scheduler and loop
 * adapter (`playlists/instance.ts` `playSample`), from the same `samplePlan` and `samplePass`.
 *
 * - **Trim end.** A pass that doesn't loop stops at the trim's end (`samplePass`), with `SAMPLE_END_FADE`, at the frame
 *   its playback position reaches it (the playlist host's frame, as a playlist voice's trim stop). The position is
 *   followed from the play through the voice's own pitch, pause and resume, seek and loop changes (the returned voice
 *   passes those on and keeps the position), so a paused voice isn't cut and a pitch change moves the stop. A Doppler
 *   factor (the spatial pass's, small and both ways) isn't counted.
 * - **Loop.** A looping request loops the sample's first loop region (`samplePlan(path).loop`), else its trimmed region.
 *   An `always` loop is endless; a `held` one until `releaseSampleVoice` (its exit: `finish` plays the pass out, `jump`
 *   leaves at once, `crossfade` as `finish`), and then it stops at the trim's end as a pass that doesn't loop; a
 *   `parameter` one loops when its global parameter's condition holds at the play (a clip voice has no instance
 *   parameters to follow). A path without sample edits loops as it always did (the clip's own loop points, ADR 0158 §4).
 *   Directions, repeat counts, crossfades, hold points and later loops are the playlist runtime's loop programs; a clip
 *   voice loops the first region forward, endlessly.
 */
import type { AudioVoice, PlayRequest } from "./backend";
import { mediaPlay } from "./media/packages";
import { SAMPLE_END_FADE, samplePass, samplePlan } from "./clipResolver";
import { playlistHost, type HostedRuntime } from "./playlists/host";
import type { LoopBehaviour } from "../../../engine/audio/playlist/types";

/** The core's pitch range (`core/voices.ts`): a rate outside it plays at the bound. */
const MIN_PITCH = 0.0625;
const MAX_PITCH = 16;

/**
 * A voice that stops at its trim's end, and where it is in the file: `pos` (file seconds) at heard time `at`, advancing at
 * `rate` until `holdFrom` (a pause's heard time; Infinity while running), wrapping in `loop` while it loops.
 */
interface Track {
  readonly voice: AudioVoice;
  /** File seconds where the trim ends. */
  readonly end: number;
  pos: number;
  at: number;
  rate: number;
  holdFrom: number;
  loop: { start: number; end: number } | null;
}

/** The voices that stop at their trim's end. */
const tracks = new Set<Track>();
/** A looping voice's held loop, so `releaseSampleVoice` can key it off (keyed by the voice `playSampleVoice` returned). */
const held = new WeakMap<AudioVoice, { start: number; end: number; behaviour: LoopBehaviour }>();
let hosted = false;

const now = (): number => playlistHost().clock();

/** File position `p` wrapped into `loop` as a looping voice wraps it (a region with no length, or none: as it is). */
function wrap(p: number, l: Track["loop"]): number {
  if (!l || !(l.end > l.start) || p < l.end) return p;
  return l.start + ((p - l.start) % (l.end - l.start));
}

/** Where `k` is in the file at heard time `t`. */
function positionAt(k: Track, t: number): number {
  return wrap(k.pos + Math.max(0, Math.min(t, k.holdFrom) - k.at) * k.rate, k.loop);
}

/** Moves `k`'s anchor to heard time `t` (a voice that hasn't started yet keeps its start). */
function reanchor(k: Track, t: number): void {
  k.pos = positionAt(k, t);
  k.at = Math.max(k.at, t);
}

/** A stamped time (`pause(at)`, `resume(at)`): `at` when it is ahead, else now. */
const stamped = (at: number | undefined, t: number): number => (at !== undefined && Number.isFinite(at) && at > t ? at : t);

const runtime: HostedRuntime = {
  update(): void {
    if (tracks.size === 0) return;
    const t = now();
    for (const k of tracks) {
      if (!k.voice.playing) {
        tracks.delete(k);
        continue;
      }
      if (k.loop || positionAt(k, t) < k.end) continue;
      tracks.delete(k);
      k.voice.stop(SAMPLE_END_FADE);
    }
  },
  onGlobal(): void {},
  resend(): void {},
  // A scene change stops the scene's voices itself; a one-shot's stop still comes due.
  stopAll(): void {},
  release(): void { tracks.clear(); },
  forgetWorld(): void {},
  sweep(): void {},
};

/**
 * `voice` as the caller holds it: every member is the voice's, and its pitch, pause, resume, seek and loop calls also
 * move `k`'s position, so the trim stop comes when the playback reaches the trim's end.
 */
function followed(voice: AudioVoice, k: Track): AudioVoice {
  if (!hosted) { playlistHost().host(runtime); hosted = true; }
  tracks.add(k);
  const own: Partial<AudioVoice> = {
    setPitch(rate: number): void {
      if (Number.isFinite(rate)) {
        reanchor(k, now());
        k.rate = Math.min(MAX_PITCH, Math.max(MIN_PITCH, rate));
      }
      voice.setPitch(rate);
    },
    pause(at?: number): void {
      k.holdFrom = Math.min(k.holdFrom, stamped(at, now()));
      voice.pause(at);
    },
    resume(at?: number): void {
      const t = stamped(at, now());
      if (k.holdFrom !== Infinity) {
        k.pos = positionAt(k, Math.min(t, k.holdFrom));
        k.at = Math.max(t, k.at);
        k.holdFrom = Infinity;
      }
      voice.resume(at);
    },
    seek(seconds: number): void {
      if (Number.isFinite(seconds)) {
        reanchor(k, now());
        k.pos = wrap(Math.max(0, seconds), k.loop);
      }
      voice.seek(seconds);
    },
    setLoop(start: number, end: number, looping: boolean): void {
      reanchor(k, now());
      k.loop = looping ? { start, end } : null;
      voice.setLoop(start, end, looping);
    },
  };
  const bound = new Map<PropertyKey, unknown>();
  return new Proxy(voice, {
    get(target, key) {
      if (Object.prototype.hasOwnProperty.call(own, key)) return own[key as keyof AudioVoice];
      const v: unknown = Reflect.get(target, key, target);
      if (typeof v !== "function") return v;
      let b = bound.get(key);
      if (b === undefined) bound.set(key, (b = (v as (...a: unknown[]) => unknown).bind(target)));
      return b;
    },
  });
}

/** Whether a `parameter` loop's global parameter holds its condition now (an unknown parameter: no). */
function parameterHolds(b: LoopBehaviour["binding"]): boolean {
  if (!b) return false;
  const p = playlistHost().globalParameter(b.parameter);
  return !!p && (b.op === ">" ? p.value > b.value : p.value < b.value);
}

/**
 * Plays `req` (`clipRequest(path, …)` with the caller's fields) with `path`'s sample plan: the trim's end, and the
 * sample's loop when `req.loop`. `skip` starts that many seconds into the trimmed sound (`Audio.playOneShot`'s `offset`);
 * past a trim's end it doesn't play. Returns the voice (the caller drives it through this object, so the trim stop
 * follows its pitch, pauses and seeks), or null when nothing played. Throws only what `AudioBackend.play` throws.
 */
export function playSampleVoice(path: string, req: PlayRequest, skip = 0): AudioVoice | null {
  const plan = samplePlan(path);
  const pass = samplePass(path, plan.trim, skip);
  // Past a trim that ends before the file: nothing to play (past the file's own end the backend ends it at once).
  if (skip > 0 && !req.loop && pass.early && pass.length !== null && pass.length <= 0) return null;
  if (pass.offset > 0) req.offset = pass.offset;
  else delete req.offset;
  let loop: { start: number; end: number; behaviour: LoopBehaviour } | null = null;
  if (req.loop) {
    if (plan.loop && (plan.loop.behaviour.active !== "parameter" || parameterHolds(plan.loop.behaviour.binding))) loop = plan.loop;
    else if (plan.trim && !plan.loop) loop = { start: plan.trim[0], end: plan.trim[1], behaviour: { active: "always", exit: "finish", exitFadeMs: 0, reentry: "ignore" } };
    // A parameter loop that doesn't hold plays the trimmed pass once.
    if (plan.loop && !loop) req.loop = false;
  }
  const start = req.at ?? playlistHost().horizon() ?? playlistHost().clock();
  // ADR 0351 §7: through the package registry (the strict rule; an unload stops the voice).
  const played = mediaPlay(req);
  if (!played) return null;
  let voice = played;
  // The trim's end, where the file goes on past it: a pass that doesn't loop stops there, and so does a held loop once
  // released (an `always` loop never lets go, so it needs no stop).
  const trimEnd = pass.early && plan.trim ? plan.trim[1] : null;
  const stops = trimEnd !== null && (loop ? loop.behaviour.active === "held" : !req.loop);
  if (stops) {
    const rate = req.pitch !== undefined && Number.isFinite(req.pitch) && req.pitch > 0 ? Math.min(MAX_PITCH, Math.max(MIN_PITCH, req.pitch)) : 1;
    voice = followed(played, { voice: played, end: trimEnd, pos: pass.offset, at: start, rate, holdFrom: Infinity, loop: null });
  }
  if (loop) {
    voice.setLoop(loop.start, loop.end, true);
    if (loop.behaviour.active === "held") held.set(voice, loop);
  }
  return voice;
}

/**
 * Key-off for a voice `playSampleVoice` started looping a `held` loop: it stops looping and leaves by the loop's exit
 * (`jump` seeks to the loop's end; `finish` and `crossfade` play the pass out), then stops at the trim's end as a pass
 * that doesn't loop. Does nothing for any other voice, or twice.
 */
export function releaseSampleVoice(voice: AudioVoice): void {
  const loop = held.get(voice);
  if (!loop) return;
  held.delete(voice);
  voice.setLoop(loop.start, loop.end, false);
  if (loop.behaviour.exit === "jump") voice.seek(loop.end);
}
