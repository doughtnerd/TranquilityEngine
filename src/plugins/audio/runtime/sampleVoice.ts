/**
 * ADR 0342: a clip voice played with its sample plan — the one place `Audio.playOneShot`, `AudioSource` and `AudioZone`
 * apply what the clip resolver's request (`clipRequest`: level, normalisation gain, trimmed start) can't carry, because
 * it acts on the playing voice. The playlist runtime does the same for its voices with its own scheduler and loop
 * adapter (`playlists/instance.ts` `playSample`), from the same `samplePlan` and `samplePass`.
 *
 * - **Trim end.** A pass that doesn't loop stops at the trim's end (`samplePass`), with `SAMPLE_END_FADE`, at the frame
 *   that reaches it (the playlist host's frame, as a playlist voice's trim stop).
 * - **Loop.** A looping request loops the sample's first loop region (`samplePlan(path).loop`), else its trimmed region.
 *   An `always` loop is endless; a `held` one until `releaseSampleVoice` (its exit: `finish` plays the pass out, `jump`
 *   leaves at once, `crossfade` as `finish`); a `parameter` one loops when its global parameter's condition holds at the
 *   play (a clip voice has no instance parameters to follow). A path without sample edits loops as it always did (the
 *   clip's own loop points, ADR 0158 §4). Directions, repeat counts, crossfades, hold points and later loops are the
 *   playlist runtime's loop programs; a clip voice loops the first region forward, endlessly.
 */
import type { AudioVoice, PlayRequest } from "./backend";
import { mediaPlay } from "./media/packages";
import { SAMPLE_END_FADE, samplePass, samplePlan } from "./clipResolver";
import { playlistHost, type HostedRuntime } from "./playlists/host";
import type { LoopBehaviour } from "../../../engine/audio/playlist/types";

interface Stop {
  at: number;
  voice: AudioVoice;
}

/** Trim-end stops, soonest first. */
const stops: Stop[] = [];
/** A looping voice's held loop, so `releaseSampleVoice` can key it off. */
const held = new WeakMap<AudioVoice, { start: number; end: number; behaviour: LoopBehaviour }>();
let hosted = false;

const runtime: HostedRuntime = {
  update(): void {
    if (stops.length === 0) return;
    const t = playlistHost().clock();
    while (stops.length > 0 && stops[0]!.at <= t) {
      const { voice } = stops.shift()!;
      if (voice.playing) voice.stop(SAMPLE_END_FADE);
    }
  },
  onGlobal(): void {},
  resend(): void {},
  // A scene change stops the scene's voices itself; a one-shot's stop still comes due.
  stopAll(): void {},
  release(): void { stops.length = 0; },
  forgetWorld(): void {},
  sweep(): void {},
};

function scheduleStop(at: number, voice: AudioVoice): void {
  if (!hosted) { playlistHost().host(runtime); hosted = true; }
  let i = stops.length;
  while (i > 0 && stops[i - 1]!.at > at) i--;
  stops.splice(i, 0, { at, voice });
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
 * past a trim's end it doesn't play. Returns the voice, or null when nothing played. Throws only what
 * `AudioBackend.play` throws.
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
  const voice = mediaPlay(req);
  if (!voice) return null;
  if (loop) {
    voice.setLoop(loop.start, loop.end, true);
    if (loop.behaviour.active === "held") held.set(voice, loop);
  } else if (!req.loop && pass.early && pass.length !== null) {
    scheduleStop(start + pass.length / Math.max(1e-6, req.pitch ?? 1), voice);
  }
  return voice;
}

/**
 * Key-off for a voice `playSampleVoice` started looping a `held` loop: it stops looping and leaves by the loop's exit
 * (`jump` seeks to the loop's end; `finish` and `crossfade` play the pass out). Does nothing for any other voice, or twice.
 */
export function releaseSampleVoice(voice: AudioVoice): void {
  const loop = held.get(voice);
  if (!loop) return;
  held.delete(voice);
  voice.setLoop(loop.start, loop.end, false);
  if (loop.behaviour.exit === "jump") voice.seek(loop.end);
}
