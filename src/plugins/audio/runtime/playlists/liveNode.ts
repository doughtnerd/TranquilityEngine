/**
 * The live playlist tree's shared shapes and base node (ADR 0343): what every resolver's node (`nodes.ts`,
 * `sequence.ts`) is and what it needs of its instance (`NodeHost`).
 */
import type { Curve } from "../../../../engine/core/curve";
import type { CurveBy } from "../../../../engine/audio/curveBy";
import type { LiveSlice } from "./byCurves";
import type { Effect } from "../../../../engine/audio/effects/types";
import type { VoiceProps } from "../../../../engine/audio/playlist/accumulate";
import type { PickState } from "../../../../engine/audio/playlist/picks";
import type { ChangeHow, CurveInput, LineEntry, LoopBehaviour, PlaylistBody, Quantize, SampleEntry } from "../../../../engine/audio/playlist/types";
import type { GeneratorBody } from "../../../../engine/audio/generators/types";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import type { AudioMarkerEvent, AudioVoice, Attenuation, SubmixLevel } from "../backend";
import type { Binding, ParamRef } from "../automation";
import type { TimeCurve } from "./curves";
import type { MusicalClock, MusicalSource } from "./musical";
import type { SampleFacts } from "./sampleFacts";
import type { FadeShape } from "../../../../engine/audio/playlist/types";
import { fadePieces } from "../../../../engine/audio/playlist/fadeShapes";
import type { QuantLane } from "./quantizedLanes";

/**
 * ADR 0350: one fade of `voice`'s fade ramp from `from` to `to` over `seconds` in `shape`, starting at heard `at` (null:
 * as soon as possible, or `asap` when a shape needs several stamped pieces). The core's laws are one record; other
 * shapes are `fadePieces`' stamped linear pieces. `stopAtEnd` stops the voice when it ends.
 */
export function shapedFade(voice: AudioVoice, shape: FadeShape, seconds: number, from: number, to: number, at: number | null, asap: () => number, stopAtEnd = false): void {
  const pieces = fadePieces(shape, seconds, from, to);
  if (pieces.length === 1) {
    const p = pieces[0]!;
    voice.fadeShaped({ to, seconds: p.seconds, law: p.law, ...(stopAtEnd ? { stopAtEnd } : {}), ...(at !== null ? { at } : {}) });
    return;
  }
  const t0 = at ?? asap();
  pieces.forEach((p, k) => voice.fadeShaped({ to: p.to, seconds: p.seconds, law: p.law, at: t0 + p.at, ...(stopAtEnd && k === pieces.length - 1 ? { stopAtEnd } : {}) }));
}

// --- shared shapes ---------------------------------------------------------------------------------------------------

/**
 * A Switch change waiting for its musical boundary (or a transition bridging to it), for `Audio.debug().music` and
 * `handle.music.transition`. `rule` is the matched rule's index in the Switch's list, -1 for its `onChange`.
 */
export interface PendingSwitchChange {
  /** The label left and the one changed to (null: plays nothing). */
  from: string | null;
  to: string | null;
  /** Heard time the change lands (for a transition, where the new entry enters once it is bridging). */
  at: number;
  how: ChangeHow;
  rule: number;
  /** Specificity: 1 both labels exact, 2 `from` exact, 3 `to` exact, 4 wildcards or the default rule. */
  tier: 1 | 2 | 3 | 4;
  /** The Switch's playlist path (the container that supplied the rule). */
  where: string;
  /** The transition plays and the new entry waits for its Exit marker. */
  bridging: boolean;
}

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
  /** Seconds of fade-in for the voices started (a crossfade's incoming side). */
  fadeIn: number;
  /** ADR 0350: the fade-in's shape; absent: equalPower. */
  fadeInShape?: FadeShape;
  /** ADR 0350: the beat-quantised automation lanes above (`quantizedLanes.ts`). */
  quantized?: readonly QuantLane[];
  spatial: SpatialPlan | null;
  /** The nearest playlist path above, for messages. */
  where: string;
  /**
   * ADR 0345 levels: the submix of the nearest level above that runs its effects on one (the instance's own, a nested
   * playlist's, a track's or a clip's) and the bus it takes voices on; the voices below on that bus mix into it. Absent or
   * null: none (or the voices below are on another bus).
   */
  submix?: CtxSubmix | null;
  /**
   * ADR 0360 §4: the `gen:<param>` curves of the entries above (an entry's voice curves reach the generator it plays,
   * directly or wrapped in an embedded Clip). Only a generator voice reads them; absent: none.
   */
  genCurves?: readonly GenCurve[];
}

/** ADR 0360 §4: one `gen:<param>` curve or lane, still named by parameter (the generator's kind resolves it). */
export interface GenCurve {
  /** The generator catalogue's parameter name. */
  readonly param: string;
  readonly input: CurveInput;
  /** In the parameter's own units (Hz, ms, dB, …). */
  readonly curve: Curve;
  /** A time-keyed lane read this many seconds ahead of the voice's time (a sequence clip's clip or sequence time). */
  readonly offset?: number;
  /** ADR 0353: a parameter-keyed curve moving only on this boundary (not followed yet for generators; one warning). */
  readonly quantize?: Quantize;
}

/** ADR 0360 §5: one generator voice to play: its source, and how a sequence clip ends it. */
export interface GeneratorPlay {
  /** A `*.generator.json` path or an embedded generator. */
  readonly generator: string | GeneratorBody;
  /**
   * Seconds after its start at which an oscillator, synth or silence keys itself off (a sequence clip's remaining
   * length: the core's `length`, sample-exact); absent: the generator's own `length`.
   */
  readonly keyOffAfter?: number;
}

/** ADR 0345 levels: a level's submix as the context carries it down. */
export interface CtxSubmix {
  readonly level: SubmixLevel;
  /** The bus (resolved name) its voices play on. */
  readonly bus: string;
  /** The instance's own submix (its voices are routed by their group; no ROUTE needed). */
  readonly root: boolean;
}

/** What the nodes need of their instance. */
export interface NodeHost {
  readonly stopped: boolean;
  /** ADR 0348: the instance's id (its group) for the capture's pick records; absent or 0: none. */
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
   * ADR 0362 §5: the instance's slice of lane `main` following second input `by` (`byCurves.ts`), mapped by `pre` (named
   * `key`) as the lane's owner maps its curve.
   */
  byCurve(main: Curve, by: CurveBy, key?: string, pre?: (c: Curve) => Curve): LiveSlice;
  /**
   * Plays one sample entry below `ctx`. `loop` (a sequence clip's own loop, or null for none) replaces the loop the entry
   * would get from its sample and settings; omitted, the entry's.
   */
  playSample(entry: SampleEntry, ctx: Ctx, loop?: LoopRun | null): PVoice | null;
  /**
   * ADR 0354 §5, 0355 §3: the sample a line entry plays now (its key from the entry, the play's `line` option or its
   * dialogue event; its file through the current language's chain), as a sample entry with the line entry's use
   * settings. Null when nothing plays (the host keeps why for the handle's reason). Absent: line entries play nothing.
   */
  lineSample?(entry: LineEntry, ctx: Ctx): SampleEntry | null;
  /**
   * ADR 0360 §5: plays one generator voice below `ctx` (its `gen:` curves are `ctx.genCurves`): the patch resolved now,
   * drawing from the World's generator in pick order. Null when nothing plays (a missing asset, a backend without
   * generators). Absent: generators play nothing.
   */
  playGenerator?(play: GeneratorPlay, ctx: Ctx): PVoice | null;
  /** ADR 0360 §5: a playing generator voice's parameters (by catalogue index) change, gliding over `seconds` (hot reload). */
  setGeneratorParams?(v: PVoice, params: ReadonlyMap<number, number>, seconds: number): void;
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
  /**
   * `EventOptions.offset` while the instance's start resolves its tree (0 otherwise, and absent on hosts without it):
   * seconds the instance starts as if already played. Samples started then begin that far in; a sequence takes it as
   * its playhead's start and sets it to 0 while it builds, so what it starts isn't offset twice.
   */
  startOffset?: number;
  /**
   * ADR 0345: the effects list (by identity: the root playlist's) the instance runs on its submix, so `bodyCtx` doesn't
   * map it onto the voices too; absent or null when the instance has no submix.
   */
  readonly submixedEffects?: readonly Effect[] | null;
  /** The mixer bus a level's `output` (undefined: inherited, Master) resolves to; absent: the name as given. */
  resolveBus?(bus: string | undefined): string;
  /**
   * ADR 0345 levels: a submix for one level's enabled `effects` (`key` names the level in the instance), feeding `parent`
   * and taking voices on `bus`; null when there's nothing to run, no submixes on this backend, no instance group, or the
   * pool is full (then the level's effects map onto its voices). Absent: never.
   */
  levelSubmix?(key: string, effects: readonly Effect[], bus: string, parent: SubmixLevel | null, where: string): SubmixLevel | null;
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

  /** The outgoing side of a crossfade: every voice below fades out in `shape` (ADR 0350) over `seconds` from `at`, then stops. */
  leave(seconds: number, at: number | null, shape: FadeShape = "equalPower"): void {
    if (this.stopped) return;
    this.stopped = true;
    for (const v of this.voices) {
      if (v.leaving) continue;
      v.leaving = true;
      shapedFade(v.voice, shape, seconds, 1, 0, at, () => this.host.startOf(null), true);
    }
    for (const c of this.children) c.leave(seconds, at, shape);
  }

  /**
   * ADR 0350 (post-exit): a Switch handed over at heard `at` and this entry's tail rings on: its loops are let go by
   * their exit settings (release exits a loop into the audio after it) and its voices play on to their natural end.
   * It no longer counts as the Switch's playing entry; `stop` still ends it.
   */
  ringOut(at: number | null): void {
    this.ringing = true;
    for (const v of this.voices) {
      if (!v.loop?.looping || v.leaving) continue;
      // An always-active sample loop can't be let go (only a stop ends it): it is cut at the hand-over, as before.
      if (v.loop.behaviour.active === "always") {
        v.leaving = true;
        v.voice.fadeShaped({ to: 0, seconds: 0.005, law: "linear", stopAtEnd: true, ...(at !== null ? { at } : {}) });
      } else this.host.endLoop(v);
    }
    for (const c of this.children) c.ringOut(at);
  }

  /** ADR 0350: handed over and ringing out its tail (`ringOut`). */
  ringing = false;

  /** ADR 0350: whether what plays here has an Exit marker (its music then has a post-exit tail). */
  hasExitMarker(): boolean {
    for (const c of this.children) if (!c.stopped && c.hasExitMarker()) return true;
    return false;
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
   * The musical clock of what plays here now (ADR 0343: "the musical clock of the playing entry"): by default the first
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

  /** A voice below still waits for its clip's data (it hasn't reached the core, so it can't start where it was stamped). */
  waitingForData(): boolean {
    for (const v of this.voices) if (!v.leaving && v.voice.reason === "waitingForData") return true;
    for (const c of this.children) if (!c.stopped && c.waitingForData()) return true;
    return false;
  }

  /** The Switch change waiting below (the newest playing child's first), null when none. */
  pendingChange(): PendingSwitchChange | null {
    if (this.stopped) return null;
    for (let k = this.children.length - 1; k >= 0; k--) {
      const c = this.children[k]!;
      if (c.stopped) continue;
      const p = c.pendingChange();
      if (p) return p;
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
