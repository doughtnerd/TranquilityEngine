// ADR 0348: the take's hook points. The runtime's entry points above the backend seam (`Audio.play` and `playOneShot`,
// the handles' stop, release and trigger (and, ADR 0386, pause, resume and fade), buses, snapshots, master volume, `AudioSource`, and the audio frame's pose read)
// call `takeTap.sink` when it is set; while no take records it is null and a hook costs one comparison. Parameters reach
// the take through the profile taps instead (`capture.ts` `CaptureTee`: every effective change passes there once).
//
// This module is tiny and always loaded; the recorder behind the sink (`takeRecorder.ts`) is a lazy chunk.
import type { Vec3Like } from "../../../../engine/core/math";
import type { TakeMixOp } from "../../../../engine/audio/take/records";
import type { TakePlayOptions, TakeSayOptions, TakeSayPick, TakeSayState } from "../../../../engine/audio/take/types";

/** What a say record holds beyond its time and instance (ADR 0355 §6). */
export interface TakeSayInit {
  event: string;
  /** The resolved value of every argument. */
  args: Record<string, string>;
  options: TakeSayOptions;
  state: TakeSayState;
  picked: TakeSayPick | null;
  /** The World generator's state just before it decided; null when unseeded or queued. */
  random: number | null;
  emitter: TakeEmitter | null;
}

/** Where a play sounds from: an entity (an `AudioSource`'s node) or a script-placed instance. `key` identifies it across plays. */
export interface TakeEmitter {
  readonly key: object;
  /** For display (META `take.emitters`): the node's name, or the path a script placed. */
  readonly name: string;
  /** World position now; null when it has none (ended, or never placed). */
  position(): Vec3Like | null;
}

/** What a take's picture is taken of: the canvas the World renders into (`TakeFrameGrabber`, in the recorder's chunk). */
export interface TakePictureSource {
  readonly width: number;
  readonly height: number;
}

/** The listener's pose at one audio frame (the audio system's `ListenerFrame` fields the take reads). */
export interface TakeListenerPose {
  readonly posX: number;
  readonly posY: number;
  readonly posZ: number;
  readonly fwdX: number;
  readonly fwdY: number;
  readonly fwdZ: number;
}

/** What the hooks call. `instance` is the runtime's object for the play (an event or playlist instance, or a one-shot's voice). */
export interface TakeRequestSink {
  play(instance: object, path: string, emitter: TakeEmitter | null, options: TakePlayOptions): void;
  stop(instance: object, fade: number): void;
  release(instance: object): void;
  /** ADR 0386: a handle's `pause()`, `resume()` and `fade(to, seconds)`, as the game asked them. */
  pause(instance: object): void;
  resume(instance: object): void;
  fade(instance: object, to: number, seconds: number): void;
  trigger(instance: object, name: string): void;
  mix(op: TakeMixOp, target: string, value: number, seconds: number): void;
  /** ADR 0354 §10: `Audio.line(key)` played in `language` (null: nothing heard). `instance` is the line's handle. */
  line(instance: object, key: string, language: string | null, emitter: TakeEmitter | null, options: TakePlayOptions): void;
  /** ADR 0354 §10, 0357 §2: the audio or subtitle language changed. */
  language(audio: string, subtitles: string | null): void;
  /** ADR 0355 §6: `Audio.say` as asked. `instance` is the say's handle. */
  say(instance: object, say: TakeSayInit): void;
  /** ADR 0355 §6: a queued say started (with its pick) or was dropped. */
  sayState(instance: object, state: "playing" | "dropped", picked: TakeSayPick | null, random: number | null): void;
  /**
   * Once per audio frame, before the backend's frame (`audioFrame.ts`): poses at 30 Hz, changes only, the take keyframe
   * each second, and a picture of `picture` (the World's canvas; null headless) about once a second when the take has them.
   */
  frame(listener: TakeListenerPose | null, picture?: TakePictureSource | null): void;
}

/** The sink while a take records; null otherwise. */
export const takeTap: { sink: TakeRequestSink | null } = { sink: null };

/** The play options a take keeps (a subset of the event and one-shot options), from whatever object a caller passed. */
export function takePlayOptions(o: { volume?: unknown; pitch?: unknown; bus?: unknown; priority?: unknown; parameters?: unknown } | null | undefined): TakePlayOptions {
  const out: TakePlayOptions = {};
  if (!o) return out;
  const num = (x: unknown): number | undefined => (typeof x === "number" && Number.isFinite(x) ? x : undefined);
  const volume = num(o.volume);
  const pitch = num(o.pitch);
  const priority = num(o.priority);
  if (volume !== undefined) out.volume = volume;
  if (pitch !== undefined) out.pitch = pitch;
  if (priority !== undefined) out.priority = priority;
  if (typeof o.bus === "string" && o.bus !== "") out.bus = o.bus;
  if (typeof o.parameters === "object" && o.parameters !== null) {
    const p: Record<string, number> = {};
    for (const [k, v] of Object.entries(o.parameters as Record<string, unknown>)) if (typeof v === "number" && Number.isFinite(v)) p[k] = v;
    if (Object.keys(p).length > 0) out.parameters = p;
  }
  return out;
}
