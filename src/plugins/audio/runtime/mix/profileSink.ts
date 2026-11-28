// ADR 0171 amended by 0172 (M5, contract K0; api-and-models §5.3, §5.6, architecture §3.5): the event taps behind one
// `ProfileSink`. The voice table, selection, the core backend, the playlist runtime, music and the mixer's setters call it;
// the recorder (Rc3's `capture/events.ts`) implements it. With no recorder the sink is `NULL_PROFILE_SINK`, and a tap
// costs a pointer comparison (`sink !== NULL_PROFILE_SINK`) or a call into an empty method; nothing allocates.
//
// K0 declares the kinds and reasons and wires the EPOCH and GAP calls in `coreBackend.ts` and `recovery.ts`; Rc3 adds
// the other taps and the recording implementation.

/** §5.6 voiceStop reasons. */
export type ProfileStopReason = "ended" | "stopped" | "faded" | "worldReleased" | "failed";
/** §5.6 voiceSteal reasons (`voiceTable.ts` `noteStolen`). */
export type ProfileStealReason = "busMaxVoices" | "globalLimit" | "priority";
/** §5.6 voiceVirtual reasons. */
export type ProfileVirtualReason = "capDemoted" | "belowAudibility" | "paused" | "worldInaudible";
/** §5.6 voiceReal reasons. */
export type ProfileRealReason = "promoted" | "capRaised";
/** §5.6 voiceRefused reasons. */
export type ProfileRefusedReason = "busFull" | "poolFull" | "neverFits" | "loadFailed" | "capRefused";
/** §5.6 voiceQueued reasons. */
export type ProfileQueuedReason = "clipLoading" | "streamPriming";

/** §5.3 EPOCH reasons: one per rebuild cause (`RebuildReason` in `recovery.ts`) plus the start and a mode change; a resumed context is a GAP, not an epoch. */
export type ProfileEpochReason = "start" | "trap" | "stall" | "device" | "rate" | "latency" | "mode";
/** §5.3 GAP reasons (architecture §3.5): `paused` means only `audio.background: "pause"`. */
export type ProfileGapReason = "paused" | "rebuild" | "held" | "dropped" | "recordTooLarge";

/** §5.6 loudness controls a script or the panel used. */
export type ProfileLoudnessControl = "reset" | "pause" | "resume" | "target";

/** The event taps (§5.6). Ids are voice ids; a bus is its `busRef` (`gen << 8 | slot`, the slot table's `busRef(slot)`, §6.3). */
export interface ProfileSink {
  voiceStart(id: number, clip: string, busRef: number, flags: number, atFrame: number, gain: number): void;
  voiceStop(id: number, reason: ProfileStopReason): void;
  voiceSteal(victim: number, thief: number, reason: ProfileStealReason): void;
  voiceVirtual(id: number, reason: ProfileVirtualReason): void;
  voiceReal(id: number, reason: ProfileRealReason): void;
  voiceRefused(clip: string, busRef: number, reason: ProfileRefusedReason): void;
  voiceQueued(clip: string, busRef: number, reason: ProfileQueuedReason): void;
  /** A playlist instance started; `cause` (ADR 0435) says what in the game asked for it, when known. */
  eventStart(instance: number, asset: string, cause?: ProfileCause | null): void;
  eventStop(instance: number): void;
  parameter(name: string, value: number, instance: number | null): void;
  snapshot(name: string, seconds: number): void;
  stateChange(parameter: string, label: string): void;
  musicTransition(instance: number, from: string | null, to: string): void;
  /** A mixer setter's `BUS_RAMP` (the bus's `busRef`, lane by name, frames its length, `target` its gain). */
  busRamp(busRef: number, lane: string, frames: number, target: number): void;
  /** Monitor mute and solo, as a slot mask. */
  monitor(mask: number): void;
  loudnessControl(control: ProfileLoudnessControl, bus: string | null): void;
  /** The shedding ladder took (`shed`) or restored a step. */
  ladder(step: number, shed: boolean): void;
  masterChange(volume: number, muted: boolean): void;
  hiddenTab(hidden: boolean): void;
  /** §5.3 EPOCH: a new core (frames restart). */
  epoch(reason: ProfileEpochReason): void;
  /** §5.3 GAP: from now until the next block nothing was recorded (a trap, a stall, a hidden paused tab). */
  gap(reason: ProfileGapReason): void;
  /** §5.3 MARKER: `text` cut to `CAPTURE_MARK_BYTES` by the recorder. */
  marker(text: string): void;
  /** ADR 0348: one playlist decision of instance `pick.instance` (the "Why it played" chain); optional, the recorder's. */
  pick?(pick: ProfilePick): void;
  /** ADR 0348: metered bus `bus` (null: the output) moved against its loudness target to `state`; optional, the recorder's. */
  loudnessWarning?(bus: string | null, state: ProfileLoudnessState): void;
  /**
   * ADR 0351 §9: package `name` (`bytes` its download size) started loading, loaded, failed or was unloaded; optional, the
   * recorder's. `memoryBytes` (loaded and unload): the memory it holds resident (clip arena and decoder bytes), for the
   * Studio Profiler's memory track (ADR 0351 §6).
   */
  audioPackage?(name: string, event: ProfilePackageEvent, bytes: number, memoryBytes?: number): void;
  /** ADR 0352 §6: plugin effect `type`'s instance `instance` faulted for `reason` (its block passed dry); optional, the recorder's. */
  pluginFault?(type: string, reason: ProfilePluginFault, instance: number): void;
}

/** ADR 0352 §6: why a plugin effect faulted (the glue's reasons). */
export type ProfilePluginFault = "trap" | "budget" | "grow" | "nonFinite" | "range";

/** ADR 0351 §9: what happened to a package (`PKG` capture events). */
export type ProfilePackageEvent = "loadStart" | "loaded" | "failed" | "unload";

/** ADR 0348: a loudness target state a warning names (`high` and `low` warn, `ok` clears). */
export type ProfileLoudnessState = "high" | "low" | "ok";

/**
 * ADR 0348: one decision of a playlist instance: at nesting `depth`, the playlist at `playlist` (a path) of `type` chose
 * entry `choice` (-1 none) and why: a Switch's `label`, a Blend's two heaviest entries with their weights, a Queue's pick
 * (the choice itself), a Sequence's clip (the choice).
 */
export interface ProfilePick {
  instance: number;
  depth: number;
  playlist: string;
  type: "clip" | "queue" | "switch" | "blend" | "layer" | "sequence";
  choice: number;
  label: string | null;
  /** A Blend's two heaviest entries, heaviest first: `[entry, weight]`. */
  weights: readonly (readonly [number, number])[] | null;
}

/**
 * ADR 0435: what in the game asked for a playlist instance (the "Why it played" chain's game step): the request, and the
 * GameObject, behaviour hook and defined system it came from, each null when unknown.
 */
export interface ProfileCause {
  /** The request: "Audio.play", "AudioSource", "AudioZone", "Audio.playLine". */
  trigger: string;
  /** The GameObject it is for, as its path of names from the World root ("/Player/Bike"). */
  node: string | null;
  /** The behaviour hook running when it was asked ("BikeAudio.onCollisionEnter"). */
  behaviour: string | null;
  /** The defined system running when it was asked. */
  system: string | null;
}

const noop = (): void => {};

/** The sink while no recorder runs: every tap is an empty method. Compare against it to skip building a tap's arguments. */
export const NULL_PROFILE_SINK: ProfileSink = Object.freeze({
  voiceStart: noop, voiceStop: noop, voiceSteal: noop, voiceVirtual: noop, voiceReal: noop, voiceRefused: noop, voiceQueued: noop,
  eventStart: noop, eventStop: noop, parameter: noop, snapshot: noop, stateChange: noop, musicTransition: noop,
  busRamp: noop, monitor: noop, loudnessControl: noop, ladder: noop, masterChange: noop, hiddenTab: noop,
  epoch: noop, gap: noop, marker: noop,
});
