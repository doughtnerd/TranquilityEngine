/**
 * Loudness readings as game code and the editor see them (ADR 0171 record change 13, 0172; design
 * `docs/design/0171-audio-mix/api-and-models.md` §1.1). Pure types and inert values: no plugin import, so the
 * engine's mixer can hand every bus a `BusLoudness` before (or without) the audio plugin's loudness hub.
 *
 * The hub (`runtime/mix/loudnessHub.ts`, task Ld4) registers itself on the mixer as a `LoudnessSource`
 * (`mixer.setLoudnessSource`) and writes each bus's object in place per STATUS; `Bus.loudness` is a stable view
 * over whatever the source holds, so a script may keep the object across frames and across the hub's arrival.
 */

export type LoudnessResetWhat = "integrated" | "maxPeak" | "all";
export type LoudnessTargetState = "waiting" | "ok" | "high" | "low" | "suspended";

export interface LoudnessTargetReading {
  /** An entry of `audio.loudnessTargets`. */
  readonly name: string;
  /** LUFS goal. */
  readonly integrated: number;
  /** LU, +/-. */
  readonly tolerance: number;
  /** dBTP ceiling. */
  readonly truePeak: number;
  /** integrated - goal, LU; -Infinity until integrated has a value. */
  readonly deviation: number;
  readonly state: LoudnessTargetState;
  /** maxTruePeak > truePeak. */
  readonly peakOver: boolean;
}

export interface BusLoudness {
  // readings: LUFS, LU, dBTP; -Infinity while gated, empty or unmetered; never NaN
  /** Last 0.4 s (4 sub-blocks). */
  readonly momentary: number;
  /** Last 3 s (30 sub-blocks). */
  readonly shortTerm: number;
  /** Gated, since the last reset. */
  readonly integrated: number;
  /** LU; -Infinity until two short-term blocks pass the gates. */
  readonly lra: number;
  /** dBTP: max(true peak, sample peak). */
  readonly maxTruePeak: number;
  /** lowerBound: true peak was gated off in quanta below the ceiling's gate. */
  readonly truePeakBound: "exact" | "lowerBound";
  readonly maxMomentary: number;
  /** Seconds of metered audio since the last reset, paused, shed and gap time excluded. */
  readonly elapsed: number;
  // state
  /** False: not chosen in the project (or the Babylon fallback); readings -Infinity. */
  readonly metered: boolean;
  /** By pause() or by the shedding ladder. */
  readonly paused: boolean;
  readonly pausedBy: "script" | "ladder" | null;
  /** Sub-blocks lost (a stall over 3.2 s), a shed span or a rebuild gap since the last reset. */
  readonly incomplete: boolean;
  /** A monitor control or Compare affected this meter since the last reset. */
  readonly tainted: boolean;
  /** Null when the project has no targets. */
  readonly target: LoudnessTargetReading | null;
  // controls
  /** Default "all". */
  reset(what?: LoudnessResetWhat): void;
  pause(): void;
  resume(): void;
}

/**
 * What the mixer reads `Bus.loudness` from. The loudness hub (Ld4) implements it and registers with
 * `mixer.setLoudnessSource(hub)`; it returns the bus's live object (written in place, allocated once), or null for a
 * bus it doesn't meter, which then reads as `EMPTY_BUS_LOUDNESS`.
 */
export interface LoudnessSource {
  busLoudness(bus: string): BusLoudness | null;
}

const noop = (): void => {};

/**
 * The inert reading (§1.1): an unmetered bus, a missing bus (`Audio.bus("nope").loudness`) and every bus before a
 * source registers. `metered` false, every reading -Infinity, `elapsed` 0, every flag false, `target` null, and every
 * control a no-op, never a throw.
 */
export const EMPTY_BUS_LOUDNESS: BusLoudness = Object.freeze({
  momentary: Number.NEGATIVE_INFINITY,
  shortTerm: Number.NEGATIVE_INFINITY,
  integrated: Number.NEGATIVE_INFINITY,
  lra: Number.NEGATIVE_INFINITY,
  maxTruePeak: Number.NEGATIVE_INFINITY,
  truePeakBound: "exact",
  maxMomentary: Number.NEGATIVE_INFINITY,
  elapsed: 0,
  metered: false,
  paused: false,
  pausedBy: null,
  incomplete: false,
  tainted: false,
  target: null,
  reset: noop,
  pause: noop,
  resume: noop,
});

/**
 * A stable `BusLoudness` that forwards every read and control to `current()` (the source's object for the bus, or
 * null for the inert reading). The mixer allocates one per bus at `configure`, so `Bus.loudness` is the same object
 * every frame and keeps working when the hub registers later. Reads allocate nothing.
 */
export class LoudnessView implements BusLoudness {
  constructor(private readonly current: () => BusLoudness | null) {}
  private get s(): BusLoudness { return this.current() ?? EMPTY_BUS_LOUDNESS; }
  get momentary(): number { return this.s.momentary; }
  get shortTerm(): number { return this.s.shortTerm; }
  get integrated(): number { return this.s.integrated; }
  get lra(): number { return this.s.lra; }
  get maxTruePeak(): number { return this.s.maxTruePeak; }
  get truePeakBound(): "exact" | "lowerBound" { return this.s.truePeakBound; }
  get maxMomentary(): number { return this.s.maxMomentary; }
  get elapsed(): number { return this.s.elapsed; }
  get metered(): boolean { return this.s.metered; }
  get paused(): boolean { return this.s.paused; }
  get pausedBy(): "script" | "ladder" | null { return this.s.pausedBy; }
  get incomplete(): boolean { return this.s.incomplete; }
  get tainted(): boolean { return this.s.tainted; }
  get target(): LoudnessTargetReading | null { return this.s.target; }
  reset(what: LoudnessResetWhat = "all"): void { this.s.reset(what); }
  pause(): void { this.s.pause(); }
  resume(): void { this.s.resume(); }
}
