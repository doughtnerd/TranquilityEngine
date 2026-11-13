// The status mirror (ADR 0157; api-and-models §3 "Status mirror", §4.3; architecture §1, §3.2, §3.8, §4.1, §4.2):
// every STATUS block the core posts is applied here in the host's `onmessage` (`CoreLink.onStatus`), never waiting
// for a frame, so `playing`, `reason`, playheads, peaks and counters stay fresh with frames stopped. Voice sections
// go into the voice table (ended, demoted, starved, playheads); clip and stream events queue for their owners (the
// clip registry, A1.3a; streams, M1b); peaks and counters take the newest; `minSlackFrames` the minimum since the
// last frame; `framePair` feeds the clock map (A1.4). All storage is preallocated: applying a block allocates nothing.
//
// (`readStatus`, which `CoreLink` runs before calling listeners, still builds a `StatusBlock` per block; that object
// is the link's, not the mirror's.)
import { MAX_BUSES } from "../../../../engine/audio/settings";
import { LOUD_METERS, MAX_BEDS, MAX_DUCK_RULES, MAX_LOUD_ENERGIES, MAX_MUSIC_RINGS, MAX_ZONE_SLOTS, type StatusBlock } from "../wire.generated";
import type { CoreLink } from "./context";
import type { VoiceTable } from "./voiceTable";
import { CpuMeter } from "../mix/cpuMeter";

/** @internal Clip and stream events held between frames before the oldest are dropped (and counted). */
export const MIRROR_EVENT_CAPACITY = 1024;

/** @internal ADR 0166 (§4.4, Z4): where `drainGroupStarts` sends the queued group-start reports (musicOps, P1, once per frame). */
export interface MirrorGroupStartSink {
  /** `flags`: bit0 late, bit1 held and resumed, bit2 abandoned; `startFrame` is the group's start frame (hi and lo joined). */
  groupStart(groupId: number, flags: number, slipFrames: number, startFrame: number): void;
}

/** @internal Where `drainClipEvents` / `drainStreamEvents` send queued events (one long-lived object per owner). */
export interface MirrorEventSink {
  event(id: number, code: number): void;
}

/** @internal The main-thread mirror of the core's STATUS (api §3). */
export class StatusMirror {
  /** STATUS blocks applied. */
  blocks = 0;
  /**
   * True while the page is hidden (A3.4b sets it): `apply` then frees ended slots itself (`table.freeEnded()`),
   * since no frame will (architecture §3.8).
   */
  freeEndedInMessage = false;

  // --- Newest header values (§4.3) ---
  currentFrame = 0;
  dateMs = 0;
  pingSeq = 0;
  pingFrameLo = 0;
  underruns = 0;
  lateCommands = 0;
  workUnits = 0;
  workUnitsMax = 0;
  mixedVoices = 0;
  liveVoices = 0;
  flags = 0;
  mixedCap = 0;
  loadPermille = 0;
  traps = 0;
  underrunFrames = 0;
  arenaUsedKB = 0;
  arenaLargestFreeKB = 0;
  maxLatenessFrames = 0;
  hrtfVoices = 0;
  hrtfLoadFailure = 0;
  /** The first non-zero `abiVersion` seen (only the first block carries it). */
  abiVersion = 0;
  /** The newest block's `minSlackFrames`. */
  minSlackFrames = 0;
  /** The minimum `minSlackFrames` since the last `beginFrame` (`Infinity` if no block arrived since). */
  minSlackSinceFrame = Number.POSITIVE_INFINITY;
  /** §3 `framePair`: the newest block's `currentFrame` and `dateMs`, for the clock map. */
  frameAudio = 0;
  frameDateMs = 0;

  // --- ADR 0162 (K4; §4.3, C7): the M3 header fields, newest block ---
  bedVoices = 0;
  fxVoices = 0;
  ambisonicVoices = 0;
  zonesActive = 0;
  zonesRinging = 0;
  bedsRefused = 0;
  /** D5: the load-shedding ladder's steps in force, bed plus zone (STATUS `m3Shed`; ADR 0170: they come back). */
  m3Shed = 0;
  /** ADR 0170: steps the ladder gave back (each fall of `m3Shed` within one core), cumulative. */
  m3Recoveries = 0;
  /** ADR 0170: `currentFrame` of the newest block whose `underruns` rose (-Infinity: none yet). */
  underrunFrame = Number.NEGATIVE_INFINITY;
  zoneUsedKB = 0;
  workBed = 0;
  workZones = 0;

  // --- ADR 0162 (K4; §4.3, C7): the `beds` and `zones` sections, newest block (index = item; `bedCount` / `zoneCount` valid) ---
  /** Per active bed slot: host bus, voices encoded, work units last quantum. The bed planner and `Audio.debug()` read them. */
  readonly bedBus = new Uint16Array(MAX_BEDS);
  readonly bedVoiceCount = new Uint16Array(MAX_BEDS);
  readonly bedWork = new Uint32Array(MAX_BEDS);
  bedCount = 0;
  /** Per zone slot: kernel id, `ZoneState`, quanta since a send fed it, wet peak. The zone manager reads them. */
  readonly zoneKernel = new Uint32Array(MAX_ZONE_SLOTS);
  readonly zoneState = new Uint8Array(MAX_ZONE_SLOTS);
  readonly zoneQuantaSinceInput = new Uint16Array(MAX_ZONE_SLOTS);
  readonly zoneWetPeak = new Float32Array(MAX_ZONE_SLOTS);
  zoneCount = 0;

  // --- ADR 0166 (Z4; §4.4, H4): the M4 header fields (newest block; the cumulative ones are the core's running totals) ---
  musicRingsOpen = 0;
  streamStartsLate = 0;
  groupsLate = 0;
  groupsHeld = 0;
  groupsAbandoned = 0;
  curvePoolFull = 0;
  maxSlipFrames = 0;
  splitQuanta = 0;
  voiceSplits = 0;

  // --- ADR 0166 (§4.4): the `musicRings` level, newest block: every open music ring, so a lost report repairs itself ---
  /** Per open ring: its stream id and `epochFlags` (bits 0-29 epoch, 30 primed, 31 bound); `musicRingCount` valid. */
  readonly musicRingStream = new Uint32Array(MAX_MUSIC_RINGS);
  readonly musicRingEpochFlags = new Uint32Array(MAX_MUSIC_RINGS);
  musicRingCount = 0;

  // --- ADR 0171 (Wa2; §4.3): the M5 header fields, newest block. Cumulative values are f64 and restart at 0 with the shell (an epoch change) ---
  /** Shell: sum of `Date.now()` deltas around `process()`, ms, since the driver started. */
  busyMsTotal = 0;
  /** Shell: quanta processed since the driver started. */
  quantaTotal = 0;
  /** Core: cumulative work units by part (voices, buses, spatial, music, loudness). */
  wuVoices = 0;
  wuBuses = 0;
  wuSpatial = 0;
  wuMusic = 0;
  wuLoudness = 0;
  /** Shell: the smallest non-zero `Date.now` delta seen; 0 = none yet. */
  clockStepMs = 0;
  /** Core: the loudness sub-block length in frames, `round(sampleRate / 10)`. */
  loudSubBlockFrames = 0;
  /** Shell: wall-clock steps clamped (saturating). */
  clockSteps = 0;
  /** Core: the ladder's loudness step in force, 0 or 1. */
  loudShed = 0;
  /** Core, cumulative saturating: bus records that arrived after their frame. */
  busRecordsEarly = 0;
  /** Core, cumulative saturating: sidechain reads that were late. */
  sidechainLate = 0;

  // --- ADR 0171 (Wa2; §4.3): the `loudBuses`, `loudEnergies` and `busDuck` sections, newest block (index = item; counts valid) ---
  /** Per meter (the output tap is slot `LOUD_OUTPUT_TAP`): slot, flags (bits 0-5 new-block count), first sequence, true peak, gated quanta. */
  readonly loudSlot = new Uint16Array(LOUD_METERS);
  readonly loudFlags = new Uint16Array(LOUD_METERS);
  readonly loudFirstSeq = new Uint32Array(LOUD_METERS);
  readonly loudTruePeak = new Float32Array(LOUD_METERS);
  readonly loudGatedQuanta = new Uint32Array(LOUD_METERS);
  loudBusCount = 0;
  /** The newest block's sub-block energies, bus-major in `loudBuses` order (the loudness hub reads them from the block itself). */
  readonly loudEnergies = new Float32Array(MAX_LOUD_ENERGIES);
  loudEnergyCount = 0;
  /** Per ducked bus: slot and the duck lane's gain. */
  readonly duckSlot = new Uint16Array(MAX_DUCK_RULES);
  readonly duckGain = new Float32Array(MAX_DUCK_RULES);
  duckCount = 0;

  // --- Peaks (§4.3 `peaks`, newest block; index = bus) ---
  readonly peakL = new Float32Array(MAX_BUSES);
  readonly peakR = new Float32Array(MAX_BUSES);
  /** How many buses the newest block reported peaks for. */
  peakCount = 0;

  // --- Event queues (ring buffers, preallocated) ---
  /** Clip and stream events dropped because their queue was full. */
  droppedEvents = 0;
  private readonly clipIds = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private readonly clipCodes = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private clipHead = 0;
  private clipCount = 0;
  private readonly streamIds = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private readonly streamCodes = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private streamHead = 0;
  private streamCount = 0;
  /** ADR 0162 (K4): `zoneEvents` (slot, `ZoneEvent` code), queued for the zone manager like clip events. */
  private readonly zoneEventSlots = new Uint8Array(MIRROR_EVENT_CAPACITY);
  private readonly zoneEventCodes = new Uint8Array(MIRROR_EVENT_CAPACITY);
  private zoneEventHead = 0;
  private zoneEventCount = 0;
  /** ADR 0166: `groupStarts` (one item per group start), queued for musicOps like zone events. */
  private readonly gsId = new Uint16Array(MIRROR_EVENT_CAPACITY);
  private readonly gsFlags = new Uint16Array(MIRROR_EVENT_CAPACITY);
  private readonly gsSlip = new Uint32Array(MIRROR_EVENT_CAPACITY);
  private readonly gsFrame = new Float64Array(MIRROR_EVENT_CAPACITY);
  private gsHead = 0;
  private gsCount = 0;

  private readonly listener = (status: StatusBlock): void => this.apply(status);

  /** Cp2 (architecture §4.3, R18): the CPU figure over the STATUS blocks applied here; `loadPermille` below is its value. */
  readonly cpu: CpuMeter;

  constructor(readonly table: VoiceTable, sampleRate: number = 48000) {
    this.cpu = new CpuMeter(sampleRate);
  }

  /** Applies every STATUS the link receives, in its `onmessage`. Returns the unsubscribe. */
  attach(link: Pick<CoreLink, "onStatus">): () => void {
    return link.onStatus(this.listener);
  }

  /** Forgets the peaks (a bus remap: the indices they were reported for no longer mean the same buses). */
  resetPeaks(): void {
    this.peakL.fill(0);
    this.peakR.fill(0);
    this.peakCount = 0;
  }

  /**
   * Api §3 / §4.3: one STATUS block into the mirror. Voice sections, in order: `ended` (`table.markEnded`), `demoted`
   * (`markDemoted`), `starved` (`markStarved`), `playheads` (`setPlayhead`); stale ids are ignored by the table.
   * `clipEvents` and `streamEvents` queue; `peaks` replace `peakL/peakR` for `peaks.length` buses (the rest keep
   * their values, `peakCount` says how many are current); header values take the newest; `minSlackSinceFrame` takes
   * the minimum; `framePair` the newest. Then, if `freeEndedInMessage`, `table.freeEnded()`. Allocates nothing.
   */
  apply(status: StatusBlock): void {
    const table = this.table;
    this.blocks++;
    // Voice sections, in §4.3's order. Indexed loops: no iterator objects.
    const ended = status.ended;
    for (let k = 0; k < ended.length; k++) table.markEnded(ended[k]!);
    const demoted = status.demoted;
    for (let k = 0; k < demoted.length; k++) table.markDemoted(demoted[k]!);
    const starved = status.starved;
    for (let k = 0; k < starved.length; k++) table.markStarved(starved[k]!);
    const playheads = status.playheads;
    for (let k = 0; k < playheads.length; k++) table.setPlayhead(playheads[k]!.id, playheads[k]!.clipFrame);
    const clipEvents = status.clipEvents;
    for (let k = 0; k < clipEvents.length; k++) this.pushClip(clipEvents[k]!.clipId, clipEvents[k]!.code);
    const streamEvents = status.streamEvents;
    for (let k = 0; k < streamEvents.length; k++) this.pushStream(streamEvents[k]!.id, streamEvents[k]!.code);
    const peaks = status.peaks;
    const n = peaks.length < MAX_BUSES ? peaks.length : MAX_BUSES;
    for (let b = 0; b < n; b++) {
      this.peakL[b] = peaks[b]!.l;
      this.peakR[b] = peaks[b]!.r;
    }
    this.peakCount = n;
    // ADR 0162 (K4): the M3 sections.
    const beds = status.beds;
    const nb = beds.length < MAX_BEDS ? beds.length : MAX_BEDS;
    for (let k = 0; k < nb; k++) {
      this.bedBus[k] = beds[k]!.bus;
      this.bedVoiceCount[k] = beds[k]!.voices;
      this.bedWork[k] = beds[k]!.work;
    }
    this.bedCount = nb;
    const zones = status.zones;
    const nz = zones.length < MAX_ZONE_SLOTS ? zones.length : MAX_ZONE_SLOTS;
    for (let k = 0; k < nz; k++) {
      this.zoneKernel[k] = zones[k]!.kernelId;
      this.zoneState[k] = zones[k]!.state;
      this.zoneQuantaSinceInput[k] = zones[k]!.quantaSinceInput;
      this.zoneWetPeak[k] = zones[k]!.wetPeak;
    }
    this.zoneCount = nz;
    const zoneEvents = status.zoneEvents;
    for (let k = 0; k < zoneEvents.length; k++) this.pushZoneEvent(zoneEvents[k]!.slot, zoneEvents[k]!.code);
    // ADR 0166 (Z4): the M4 header fields, the `musicRings` level and the `groupStarts` queue.
    this.musicRingsOpen = status.musicRingsOpen;
    this.streamStartsLate = status.streamStartsLate;
    this.groupsLate = status.groupsLate;
    this.groupsHeld = status.groupsHeld;
    this.groupsAbandoned = status.groupsAbandoned;
    this.curvePoolFull = status.curvePoolFull;
    this.maxSlipFrames = status.maxSlipFrames;
    this.splitQuanta = status.splitQuanta;
    this.voiceSplits = status.voiceSplits;
    const rings = status.musicRings;
    const nr = rings.length < MAX_MUSIC_RINGS ? rings.length : MAX_MUSIC_RINGS;
    for (let k = 0; k < nr; k++) {
      this.musicRingStream[k] = rings[k]!.streamId;
      this.musicRingEpochFlags[k] = rings[k]!.epochFlags;
    }
    this.musicRingCount = nr;
    const starts = status.groupStarts;
    for (let k = 0; k < starts.length; k++) this.pushGroupStart(starts[k]!.groupId, starts[k]!.flags, starts[k]!.slipFrames, starts[k]!.startFrameHi * 4294967296 + starts[k]!.startFrameLo);
    // ADR 0171 (Wa2): the M5 header fields and the three sections, into preallocated arrays.
    this.busyMsTotal = status.busyMsTotal;
    this.quantaTotal = status.quantaTotal;
    this.wuVoices = status.wuVoices;
    this.wuBuses = status.wuBuses;
    this.wuSpatial = status.wuSpatial;
    this.wuMusic = status.wuMusic;
    this.wuLoudness = status.wuLoudness;
    this.clockStepMs = status.clockStepMs;
    this.loudSubBlockFrames = status.loudSubBlockFrames;
    this.clockSteps = status.clockSteps;
    this.loudShed = status.loudShed;
    this.busRecordsEarly = status.busRecordsEarly;
    this.sidechainLate = status.sidechainLate;
    const loudBuses = status.loudBuses;
    const nl = loudBuses.length < LOUD_METERS ? loudBuses.length : LOUD_METERS;
    for (let k = 0; k < nl; k++) {
      const item = loudBuses[k]!;
      this.loudSlot[k] = item.slot;
      this.loudFlags[k] = item.flags;
      this.loudFirstSeq[k] = item.firstSeq;
      this.loudTruePeak[k] = item.truePeak;
      this.loudGatedQuanta[k] = item.gatedQuanta;
    }
    this.loudBusCount = nl;
    const energies = status.loudEnergies;
    const ne = energies.length < MAX_LOUD_ENERGIES ? energies.length : MAX_LOUD_ENERGIES;
    for (let k = 0; k < ne; k++) this.loudEnergies[k] = energies[k]!;
    this.loudEnergyCount = ne;
    const busDuck = status.busDuck;
    const nd = busDuck.length < MAX_DUCK_RULES ? busDuck.length : MAX_DUCK_RULES;
    for (let k = 0; k < nd; k++) {
      this.duckSlot[k] = busDuck[k]!.slot;
      this.duckGain[k] = busDuck[k]!.gain;
    }
    this.duckCount = nd;
    // Header: the newest block wins.
    this.currentFrame = status.currentFrame;
    this.dateMs = status.dateMs;
    this.pingSeq = status.pingSeq;
    this.pingFrameLo = status.pingFrameLo;
    if (status.underruns > this.underruns) this.underrunFrame = status.currentFrame;
    this.underruns = status.underruns;
    this.lateCommands = status.lateCommands;
    this.workUnits = status.workUnits;
    this.workUnitsMax = status.workUnitsMax;
    this.mixedVoices = status.mixedVoices;
    this.liveVoices = status.liveVoices;
    this.flags = status.flags;
    this.mixedCap = status.mixedCap;
    // Cp2 (architecture §4.3): the wire's `loadPermille` is reserved 0; the figure is main's, 0 until the first window fills (`cpu.loadPermille` says null).
    this.cpu.feed(status);
    this.loadPermille = this.cpu.loadPermille ?? 0;
    this.traps = status.traps;
    this.underrunFrames = status.underrunFrames;
    this.arenaUsedKB = status.arenaUsedKB;
    this.arenaLargestFreeKB = status.arenaLargestFreeKB;
    this.maxLatenessFrames = status.maxLatenessFrames;
    this.hrtfVoices = status.hrtfVoices;
    this.hrtfLoadFailure = status.hrtfLoadFailure;
    this.bedVoices = status.bedVoices;
    this.fxVoices = status.fxVoices;
    this.ambisonicVoices = status.ambisonicVoices;
    // A new core's first block (it carries `abiVersion`) starts its own ladder: a fall there isn't a recovery.
    if (status.m3Shed < this.m3Shed && status.abiVersion === 0) this.m3Recoveries += this.m3Shed - status.m3Shed;
    this.m3Shed = status.m3Shed;
    this.zonesActive = status.zonesActive;
    this.zonesRinging = status.zonesRinging;
    this.bedsRefused = status.bedsRefused;
    this.zoneUsedKB = status.zoneUsedKB;
    this.workBed = status.workBed;
    this.workZones = status.workZones;
    if (this.abiVersion === 0 && status.abiVersion !== 0) this.abiVersion = status.abiVersion;
    this.minSlackFrames = status.minSlackFrames;
    if (status.minSlackFrames < this.minSlackSinceFrame) this.minSlackSinceFrame = status.minSlackFrames;
    this.frameAudio = status.currentFrame;
    this.frameDateMs = status.dateMs;
    if (this.freeEndedInMessage) table.freeEnded();
  }

  /**
   * The per-frame system's start: returns `minSlackSinceFrame` and resets it to `Infinity`, so each frame sees the
   * minimum since the previous one (§3).
   */
  beginFrame(): number {
    const min = this.minSlackSinceFrame;
    this.minSlackSinceFrame = Number.POSITIVE_INFINITY;
    return min;
  }

  /** Sends every queued clip event, oldest first, to `sink` and empties the queue (A1.3a's registry, per frame). */
  drainClipEvents(sink: MirrorEventSink): number {
    const n = this.clipCount;
    let head = this.clipHead;
    // Emptied first (past the drained range), so an event pushed from inside the sink waits for the next drain.
    this.clipCount = 0;
    this.clipHead = (head + n) % MIRROR_EVENT_CAPACITY;
    for (let k = 0; k < n; k++) {
      sink.event(this.clipIds[head]!, this.clipCodes[head]!);
      head = (head + 1) % MIRROR_EVENT_CAPACITY;
    }
    return n;
  }

  /** Sends every queued stream event, oldest first, to `sink` and empties the queue (M1b). */
  drainStreamEvents(sink: MirrorEventSink): number {
    const n = this.streamCount;
    let head = this.streamHead;
    this.streamCount = 0;
    this.streamHead = (head + n) % MIRROR_EVENT_CAPACITY;
    for (let k = 0; k < n; k++) {
      sink.event(this.streamIds[head]!, this.streamCodes[head]!);
      head = (head + 1) % MIRROR_EVENT_CAPACITY;
    }
    return n;
  }

  /** ADR 0162 (K4): sends every queued zone event (`slot`, `ZoneEvent` code), oldest first, to `sink` and empties the queue (the zone manager, per frame). */
  drainZoneEvents(sink: MirrorEventSink): number {
    const n = this.zoneEventCount;
    let head = this.zoneEventHead;
    this.zoneEventCount = 0;
    this.zoneEventHead = (head + n) % MIRROR_EVENT_CAPACITY;
    for (let k = 0; k < n; k++) {
      sink.event(this.zoneEventSlots[head]!, this.zoneEventCodes[head]!);
      head = (head + 1) % MIRROR_EVENT_CAPACITY;
    }
    return n;
  }

  /** ADR 0166: sends every queued group-start report, oldest first, to `sink` and empties the queue (musicOps, per frame). */
  drainGroupStarts(sink: MirrorGroupStartSink): number {
    const n = this.gsCount;
    let head = this.gsHead;
    this.gsCount = 0;
    this.gsHead = (head + n) % MIRROR_EVENT_CAPACITY;
    for (let k = 0; k < n; k++) {
      sink.groupStart(this.gsId[head]!, this.gsFlags[head]!, this.gsSlip[head]!, this.gsFrame[head]!);
      head = (head + 1) % MIRROR_EVENT_CAPACITY;
    }
    return n;
  }

  /** Queued group-start reports. */
  get pendingGroupStarts(): number {
    return this.gsCount;
  }

  /** Queues a group-start report; a full queue drops its oldest (counted in `droppedEvents`). */
  private pushGroupStart(id: number, flags: number, slip: number, frame: number): void {
    if (this.gsCount === MIRROR_EVENT_CAPACITY) {
      this.gsHead = (this.gsHead + 1) % MIRROR_EVENT_CAPACITY;
      this.gsCount--;
      this.droppedEvents++;
    }
    const at = (this.gsHead + this.gsCount) % MIRROR_EVENT_CAPACITY;
    this.gsId[at] = id;
    this.gsFlags[at] = flags;
    this.gsSlip[at] = slip;
    this.gsFrame[at] = frame;
    this.gsCount++;
  }

  /** Queues a zone event; a full queue drops its oldest (counted in `droppedEvents`). */
  private pushZoneEvent(slot: number, code: number): void {
    if (this.zoneEventCount === MIRROR_EVENT_CAPACITY) {
      this.zoneEventHead = (this.zoneEventHead + 1) % MIRROR_EVENT_CAPACITY;
      this.zoneEventCount--;
      this.droppedEvents++;
    }
    const at = (this.zoneEventHead + this.zoneEventCount) % MIRROR_EVENT_CAPACITY;
    this.zoneEventSlots[at] = slot;
    this.zoneEventCodes[at] = code;
    this.zoneEventCount++;
  }

  /** Queued zone events. */
  get pendingZoneEvents(): number {
    return this.zoneEventCount;
  }

  /** Queues a clip event; a full queue drops its oldest (counted in `droppedEvents`). */
  private pushClip(id: number, code: number): void {
    if (this.clipCount === MIRROR_EVENT_CAPACITY) {
      this.clipHead = (this.clipHead + 1) % MIRROR_EVENT_CAPACITY;
      this.clipCount--;
      this.droppedEvents++;
    }
    const at = (this.clipHead + this.clipCount) % MIRROR_EVENT_CAPACITY;
    this.clipIds[at] = id;
    this.clipCodes[at] = code;
    this.clipCount++;
  }

  /** Queues a stream event; a full queue drops its oldest (counted in `droppedEvents`). */
  private pushStream(id: number, code: number): void {
    if (this.streamCount === MIRROR_EVENT_CAPACITY) {
      this.streamHead = (this.streamHead + 1) % MIRROR_EVENT_CAPACITY;
      this.streamCount--;
      this.droppedEvents++;
    }
    const at = (this.streamHead + this.streamCount) % MIRROR_EVENT_CAPACITY;
    this.streamIds[at] = id;
    this.streamCodes[at] = code;
    this.streamCount++;
  }

  /** Queued clip events. */
  get pendingClipEvents(): number {
    return this.clipCount;
  }

  /** Queued stream events. */
  get pendingStreamEvents(): number {
    return this.streamCount;
  }
}

/**
 * @internal Tests: a STATUS block with every header field 0, every section empty, then `fields` laid over it. Builds
 * the object the link would hand to `StatusMirror.apply`.
 */
export function makeStatusBlock(fields: Partial<StatusBlock> = {}): StatusBlock {
  return {
    currentFrame: 0,
    dateMs: 0,
    pingSeq: 0,
    pingFrameLo: 0,
    underruns: 0,
    lateCommands: 0,
    workUnits: 0,
    workUnitsMax: 0,
    mixedVoices: 0,
    liveVoices: 0,
    flags: 0,
    mixedCap: 0,
    loadPermille: 0,
    traps: 0,
    minSlackFrames: 0,
    underrunFrames: 0,
    arenaUsedKB: 0,
    arenaLargestFreeKB: 0,
    abiVersion: 0,
    maxLatenessFrames: 0,
    hrtfVoices: 0,
    hrtfLoadFailure: 0,
    bedVoices: 0,
    fxVoices: 0,
    ambisonicVoices: 0,
    zonesActive: 0,
    zonesRinging: 0,
    bedsRefused: 0,
    m3Shed: 0,
    zoneUsedKB: 0,
    workBed: 0,
    workZones: 0,
    musicRingsOpen: 0,
    streamStartsLate: 0,
    groupsLate: 0,
    groupsHeld: 0,
    groupsAbandoned: 0,
    curvePoolFull: 0,
    maxSlipFrames: 0,
    splitQuanta: 0,
    voiceSplits: 0,
    reserved: 0,
    busyMsTotal: 0,
    quantaTotal: 0,
    wuVoices: 0,
    wuBuses: 0,
    wuSpatial: 0,
    wuMusic: 0,
    wuLoudness: 0,
    clockStepMs: 0,
    loudSubBlockFrames: 0,
    clockSteps: 0,
    loudShed: 0,
    busRecordsEarly: 0,
    sidechainLate: 0,
    reserved2: 0,
    ended: [],
    demoted: [],
    starved: [],
    playheads: [],
    clipEvents: [],
    streamEvents: [],
    peaks: [],
    beds: [],
    zones: [],
    zoneEvents: [],
    musicRings: [],
    groupStarts: [],
    loudBuses: [],
    loudEnergies: [],
    busDuck: [],
    ...fields,
  };
}
