// The core session's lifecycle (ADR 0178): one module that runs the core backend's rare phases (a bus reconfigure, a
// hard rebuild's begin, new context, end and replay, a failed recovery, dispose) over named participants in a declared
// order, instead of each phase calling five to ten modules by hand.
//
// - **Participants.** A module joins with a name from `PHASE_ORDER` and implements only the phases it cares about
//   (`SessionParticipant`, every member optional). `join` refuses a participant that implements a phase whose order
//   doesn't list its name, so a new phase method can't run in an undeclared place; `unimplemented` reports the other
//   direction (a name an order lists that never joined, or joined without that phase), which the core backend's
//   contract test (`session.contract.test.ts`) asserts is empty.
// - **The order is data.** Each phase runs its participants in `PHASE_ORDER[phase]`'s order whatever order they joined
//   in. The replay header's order is ADR 0157's §7 replay order as ADR 0162 (S10) and ADR 0171 (§4.2) extended it;
//   the per-voice order is what follows each replayed PLAY. The comments on each list say what depends on it.
// - **State.** The session owns `recovering` (between a rebuild's begin and its end or failure) and `disposed`; the
//   recovery phases do nothing once disposed, and `dispose` runs once. The flags change before the phase's
//   participants run, so a participant (or a closure it reaches) reads the new state.
// - **Cost.** Each phase's participant list is built at `join`; running a phase allocates nothing (the per-voice replay
//   runs once per replayed voice with one reused `ReplayVoice`).
import type { Mixer } from "../../../../engine/audio/mixer";
import type { ReplayBuilder } from "./replay";

/** One replayed voice as the per-voice replay phase sees it: one object the replayer reuses for every voice (never keep it). */
export interface ReplayVoice {
  /** The voice's id and slot. */
  id: number;
  i: number;
  /** PLAYING (mixed) on the new core; a virtual voice gets no per-voice fx. */
  mixed: boolean;
  /** The REPLAY's frame (the new context's) and the context's rate, Hz. */
  frame: number;
  rate: number;
}

/** The phases. Each is optional for a participant. */
export interface SessionPhases {
  /** A new bus tree from the settings (`AudioBackend.configureBuses`, the host's bus remap). */
  reconfigure(mixer: Mixer): void;
  /** Inside a reconfigure, as the slot table is reset (before BUS_CONFIG goes out): per-bus caches forget their indices. */
  busesReset(): void;
  /** A hard rebuild began (`onRebuildStart`): the old core is gone. `recovering` is already true. */
  beginRecovery(): void;
  /** The rebuild made a new context at `rate` whose frames start at 0 (`onContextReplaced`, A3.4c). */
  contextReplaced(rate: number): void;
  /** The new core answered (`onRebuilt`). `recovering` is already false. The replayer's restore runs last. */
  endRecovery(): void;
  /** The header REPLAY's records, every one asap (§7). */
  replayHeader(b: ReplayBuilder): void;
  /** A replayed voice's records after its PLAY. */
  replayVoice(b: ReplayBuilder, v: Readonly<ReplayVoice>): void;
  /** The rebuild's stream hand-off, once per rebuild after the header (live stream voices and music members by id). */
  reopenStreams(ids: readonly number[]): void;
  /** Recovery gave up: the host is Failed and silent for the session. `recovering` is already false. */
  recoveryFailed(): void;
  /** The backend is disposed (once). `disposed` is already true. */
  dispose(): void;
}

export type SessionPhase = keyof SessionPhases;
export type SessionParticipant = Partial<SessionPhases>;

/**
 * Who runs in each phase, in order. A name may appear in several phases; a phase lists only the participants that
 * implement it.
 */
export const PHASE_ORDER = {
  // Queued live adds go before the new tree (6548b14); BUS_CONFIG and the bus lanes (busIndex, which runs `busesReset`
  // inside); then the loudness hub and LOUD_CONFIG for the new slots, after BUS_CONFIG.
  reconfigure: ["deferredAdds", "buses", "loudness"],
  busesReset: ["voices", "lanes"],
  // F-12's stale stems go; the worklet channel to the dead node goes; the replayer notes the trap frame; an open
  // structural dip settles at its end state (R12).
  beginRecovery: ["voices", "worklet", "replayer", "dip"],
  // The replayer carries playheads and the trap frame as `Audio.time` seconds with the OLD clock, so it runs before
  // the clock map rebases; the worklet channel is dropped before the zones ask for their kernels again (C9).
  contextReplaced: ["replayer", "clock", "hrir", "worklet", "zones", "mirror"],
  // Peaks and the loudness EPOCH reset; the worklet channel is dropped unless `contextReplaced` already did; then the
  // replayer's restore (the header REPLAY, the clips again), last.
  endRecovery: ["mirror", "loudness", "worklet", "replayer"],
  // ADR 0157 §7 as extended by ADR 0162 (S10, K4) and ADR 0171 (§4.2, Mx2, Dp1, Ld2): RESET 0, BUS_CONFIG (slot order,
  // tombstones as silent roots), BED_CONFIG, BUS_DUCK and BUS_PRESENCE, LOUD_CONFIG, the bus lanes (BUS_RAMP), MASTER,
  // LISTENER (snapped), ZONE_CONFIG, then the automation mirror (curves, parameters, bus bindings). Each appends nothing
  // while its feature is inert, so an earlier milestone's replay is byte-identical.
  replayHeader: ["reset", "buses", "beds", "presence", "loudness", "lanes", "master", "listener", "zones", "automation"],
  // After each replayed PLAY: its AUTOMATE and SET_LOOP, its SET_VOICE_FX (mixed voices), then the voice table's own
  // state (FADE to its fade gain, its stamped ramps, SET_PAUSED).
  replayVoice: ["automation", "voiceFx", "voiceState"],
  // Stream voices reopen (FU2: one stamp for all), then music groups reopen as groups (ADR 0166 P9, C16).
  reopenStreams: ["voices", "musicOps"],
  // No live add waits for a slot (no recycle comes); every voice ends "failed" and the queue empties; nothing waits for
  // a replay; nothing staged is sent.
  recoveryFailed: ["deferredAdds", "voices", "replayer", "writer"],
  // Queued adds and plays go, the replay's waiting voices go, the listeners and the mixer's hooks are removed, the page's
  // loudness hub is released (if still ours), the music, stream and zone parts close, the link gets its default decoder
  // back, and nothing staged is sent.
  dispose: ["deferredAdds", "voices", "replayer", "cleanups", "loudness", "musicOps", "streams", "zones", "link", "writer"],
} as const satisfies { readonly [P in SessionPhase]: readonly string[] };

/** Every participant name some phase lists. */
export type ParticipantName = (typeof PHASE_ORDER)[SessionPhase][number];

const PHASES = Object.keys(PHASE_ORDER) as SessionPhase[];

export class CoreSession {
  private readonly joined = new Map<ParticipantName, SessionParticipant>();
  /** Per phase, the joined participants that implement it, in the phase's order. */
  private readonly runs = Object.fromEntries(PHASES.map((p) => [p, [] as SessionParticipant[]])) as { [P in SessionPhase]: SessionParticipant[] };
  private isRecovering = false;
  private isDisposed = false;

  /** True between a rebuild's begin and its end (or its failure). */
  get recovering(): boolean {
    return this.isRecovering;
  }

  /** True once `dispose` ran. */
  get disposed(): boolean {
    return this.isDisposed;
  }

  /**
   * Adds participant `name`. Throws when the name joined already, or when it implements a phase whose order doesn't list
   * it (declare the place in `PHASE_ORDER` first).
   */
  join(name: ParticipantName, participant: SessionParticipant): void {
    if (this.joined.has(name)) throw new Error(`audio: session participant "${name}" joined twice`);
    for (const phase of PHASES) {
      if (typeof participant[phase] !== "function") continue;
      if (!(PHASE_ORDER[phase] as readonly string[]).includes(name)) {
        throw new Error(`audio: session participant "${name}" implements ${phase}, but PHASE_ORDER.${phase} doesn't list it`);
      }
    }
    this.joined.set(name, participant);
    for (const phase of PHASES) {
      if (typeof participant[phase] !== "function") continue;
      const run = this.runs[phase];
      run.length = 0;
      for (const n of PHASE_ORDER[phase] as readonly ParticipantName[]) {
        const p = this.joined.get(n);
        if (p && typeof p[phase] === "function") run.push(p);
      }
    }
  }

  /** The names that run in `phase`, in order (joined ones only). */
  participants(phase: SessionPhase): ParticipantName[] {
    return (PHASE_ORDER[phase] as readonly ParticipantName[]).filter((n) => typeof this.joined.get(n)?.[phase] === "function");
  }

  /** Each `phase: name` an order lists whose participant never joined or joined without that phase. */
  unimplemented(): string[] {
    const out: string[] = [];
    for (const phase of PHASES) {
      for (const n of PHASE_ORDER[phase] as readonly ParticipantName[]) if (typeof this.joined.get(n)?.[phase] !== "function") out.push(`${phase}: ${n}`);
    }
    return out;
  }

  reconfigure(mixer: Mixer): void {
    for (const p of this.runs.reconfigure) p.reconfigure!(mixer);
  }

  busesReset(): void {
    for (const p of this.runs.busesReset) p.busesReset!();
  }

  beginRecovery(): void {
    if (this.isDisposed) return;
    this.isRecovering = true;
    for (const p of this.runs.beginRecovery) p.beginRecovery!();
  }

  contextReplaced(rate: number): void {
    if (this.isDisposed) return;
    for (const p of this.runs.contextReplaced) p.contextReplaced!(rate);
  }

  endRecovery(): void {
    if (this.isDisposed) return;
    this.isRecovering = false;
    for (const p of this.runs.endRecovery) p.endRecovery!();
  }

  replayHeader(b: ReplayBuilder): void {
    for (const p of this.runs.replayHeader) p.replayHeader!(b);
  }

  replayVoice(b: ReplayBuilder, v: Readonly<ReplayVoice>): void {
    const run = this.runs.replayVoice;
    for (let k = 0; k < run.length; k++) run[k]!.replayVoice!(b, v);
  }

  reopenStreams(ids: readonly number[]): void {
    for (const p of this.runs.reopenStreams) p.reopenStreams!(ids);
  }

  recoveryFailed(): void {
    if (this.isDisposed) return;
    this.isRecovering = false;
    for (const p of this.runs.recoveryFailed) p.recoveryFailed!();
  }

  dispose(): void {
    if (this.isDisposed) return;
    this.isDisposed = true;
    for (const p of this.runs.dispose) p.dispose!();
  }
}
