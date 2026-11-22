/**
 * The live playlist tree's shared shapes and base node (ADR 0329): what every resolver's node (`nodes.ts`,
 * `sequence.ts`) is and what it needs of its instance (`NodeHost`).
 */
import type { Curve } from "../../../../engine/core/curve";
import type { VoiceProps } from "../../../../engine/audio/playlist/accumulate";
import type { PickState } from "../../../../engine/audio/playlist/picks";
import type { LoopBehaviour, PlaylistBody, SampleEntry } from "../../../../engine/audio/playlist/types";
import type { ParameterDef } from "../../../../engine/audio/eventFormat";
import type { AudioMarkerEvent, AudioVoice, Attenuation } from "../backend";
import type { Binding, ParamRef } from "../events/automation";
import type { TimeCurve } from "./curves";
import type { MusicalClock, MusicalSource } from "./musical";
import type { SampleFacts } from "./sampleFacts";

// --- shared shapes ---------------------------------------------------------------------------------------------------

/** A gain factor a node changes while its voices play (a Blend weight, an envelope, the instance's fade). */
export interface DynGain { gain: number }

/** A playing voice's loop: its region (seconds in the file; `end` 0 the file's end), behaviour and whether it loops now. */
export interface LoopRun {
  start: number;
  end: number;
  behaviour: LoopBehaviour;
  looping: boolean;
}

/** One voice a playlist instance plays. */
export interface PVoice {
  readonly voice: AudioVoice;
  readonly path: string;
  /** The volume and pitch bound or set now (static × dynamic). */
  readonly base: { volume: number; pitch: number };
  readonly staticVolume: number;
  readonly staticPitch: number;
  readonly bindings: readonly Binding[];
  readonly dyn: readonly DynGain[];
  readonly timeCurves: readonly TimeCurve[];
  /** Heard time it starts at, when known. */
  readonly start: number | null;
  /** One pass at its pitch, seconds, when known. */
  readonly length: number | null;
  loop: LoopRun | null;
  /** Fading out (a crossfade, a steal, a stop): no longer counts as playing for the instance. */
  leaving: boolean;
  appliedGain: number;
  appliedPitch: number;
  appliedLowpass: number | null;
  /** Played with a position (it follows the handle's `position`). */
  readonly positioned: boolean;
}

/** Where a voice plays from, resolved from the playlist's `spatial` block. */
export interface SpatialPlan {
  attenuation: Attenuation;
  occlusion: boolean;
  doppler: number;
}

/** What a node passes down to the entries below it. */
export interface Ctx {
  /** Heard start time; null: as soon as possible. */
  at: number | null;
  props: VoiceProps;
  /** Output bus name; undefined: Master. */
  bus: string | undefined;
  bindings: readonly Binding[];
  timeCurves: readonly TimeCurve[];
  dyn: readonly DynGain[];
  /** The linked playlists above, the root first (cycle protection). */
  chain: readonly string[];
  depth: number;
  /** Seconds of equal-power fade-in for the voices started (a crossfade's incoming side). */
  fadeIn: number;
  spatial: SpatialPlan | null;
  /** The nearest playlist path above, for messages. */
  where: string;
}

/** What the nodes need of their instance. */
export interface NodeHost {
  readonly stopped: boolean;
  /** ADR 0334: the instance's id (its group) for the capture's pick records; absent or 0: none. */
  readonly group?: number;
  readonly untilStopped: boolean;
  readonly musical: MusicalClock;
  /** A number in [0, 1) from the World's seeded generator. */
  random(): number;
  /** The persistent pick state of the Queue at `key` (per playlist, per World). */
  pickState(key: string): PickState;
  /** The heard clock now. */
  clock(): number;
  /** `at`, else the earliest exact start, else now. */
  startOf(at: number | null): number;
  /** A parameter's value and definition (local, else global); null when there is none. */
  param(name: string): { value: number; def: ParameterDef } | null;
  paramRef(name: string): ParamRef | null;
  curveId(curve: Curve): number | null;
  /**
   * Plays one sample entry below `ctx`. `loop` (a sequence clip's own loop, or null for none) replaces the loop the entry
   * would get from its sample and settings; omitted, the entry's.
   */
  playSample(entry: SampleEntry, ctx: Ctx, loop?: LoopRun | null): PVoice | null;
  /** A marker passes at heard `e.time`: the handle's `onMarker` listeners hear it once the heard clock reaches it. */
  emitMarker(e: AudioMarkerEvent): void;
  /** Report the Cue, Exit and Hit markers of `facts` as voice `v` (playing from file seconds `from`) passes them. */
  trackMarkers(v: PVoice, facts: SampleFacts, from: number): void;
  /** The voice's loop ends by its exit settings (release). */
  endLoop(v: PVoice): void;
  /** A parameter-bound loop turns on or off. */
  setLoopActive(v: PVoice, active: boolean): void;
  schedule(at: number, run: () => void): void;
  noteLateStart(): void;
  spatialOf(body: PlaylistBody, parent: SpatialPlan | null): SpatialPlan | null;
  /** Whether the instance has been released (held loops are inactive). */
  readonly released: boolean;
}

// --- the base node ---------------------------------------------------------------------------------------------------

export abstract class LiveNode {
  protected readonly children: LiveNode[] = [];
  protected readonly voices: PVoice[] = [];
  stopped = false;

  constructor(protected readonly host: NodeHost, protected readonly ctx: Ctx, protected readonly key: string) {}

  /** Stop every voice below, fading over `fade` seconds. */
  stop(fade: number): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const v of this.voices) {
      if (v.leaving) continue;
      v.leaving = true;
      v.voice.stop(fade);
    }
    for (const c of this.children) c.stop(fade);
  }

  /** The outgoing side of a crossfade: every voice below fades out (equal power) over `seconds` from `at`, then stops. */
  leave(seconds: number, at: number | null): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const v of this.voices) {
      if (v.leaving) continue;
      v.leaving = true;
      v.voice.fadeShaped({ to: 0, seconds, law: "equalPowerOut", stopAtEnd: true, ...(at !== null ? { at } : {}) });
    }
    for (const c of this.children) c.leave(seconds, at);
  }

  /** Key-off: held loops end by their exit settings. */
  release(): void {
    for (const v of this.voices) if (v.loop?.looping && v.loop.behaviour.active === "held" && !v.leaving) this.host.endLoop(v);
    for (const c of this.children) c.release();
  }

  onParameter(name: string): void {
    for (const c of this.children) c.onParameter(name);
  }

  /** Once per frame (heard `now`). */
  update(now: number, dt: number): void {
    for (const c of this.children) c.update(now, dt);
  }

  /** Anything below still plays or will (a pending pick counts). */
  get sounding(): boolean {
    for (const v of this.voices) if (!v.leaving && v.voice.playing) return true;
    for (const c of this.children) if (c.sounding) return true;
    return false;
  }

  /**
   * The musical clock of what plays here now (ADR 0329: "the musical clock of the playing entry"): by default the first
   * child still playing that has one; a Clip and a Sequence answer for themselves; a Switch for its current entry.
   */
  musicalSource(): MusicalSource | null {
    for (let k = this.children.length - 1; k >= 0; k--) {
      const c = this.children[k]!;
      if (c.stopped) continue;
      const s = c.musicalSource();
      if (s) return s;
    }
    return null;
  }

  /** Any voice below loops now. */
  get looping(): boolean {
    for (const v of this.voices) if (!v.leaving && v.voice.playing && v.loop?.looping) return true;
    for (const c of this.children) if (c.looping) return true;
    return false;
  }

  /** When everything below ends (heard time), or null when unknown or never (a loop, a continuous Queue). */
  end(): number | null {
    let end = -Infinity;
    for (const v of this.voices) {
      if (v.leaving) continue;
      if (v.loop?.looping || v.start === null || v.length === null) return null;
      end = Math.max(end, v.start + v.length);
    }
    for (const c of this.children) {
      if (c.stopped) continue;
      const e = c.end();
      if (e === null) return null;
      end = Math.max(end, e);
    }
    return Number.isFinite(end) ? end : this.host.startOf(this.ctx.at);
  }

  /** The longest one-shot pass below (ms), null when unknown. */
  longestMs(): number | null {
    let ms: number | null = null;
    for (const v of this.voices) if (!v.leaving && v.length !== null && !v.loop?.looping) ms = Math.max(ms ?? 0, v.length * 1000);
    for (const c of this.children) {
      const m = c.longestMs();
      if (m !== null) ms = Math.max(ms ?? 0, m);
    }
    return ms;
  }
}

/** Plays nothing (an empty or unresolvable playlist). */
export class EmptyNode extends LiveNode {}
