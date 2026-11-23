// ADR 0171 amended by 0172 (M5, task G7b; api-and-models §5.5): the core backend's KEYFRAME source. `capture.ts` hands the
// recorder `() => backend.keyframe(nameId)`, which `CoreBackend.keyframe` reads from the `KeyframeSource` here: the main-side
// state at one instant, read from main's own tables.
//
// - **voices** from the voice table (the live slots, then the steals the debug view still lists): id, clip (interned through
//   `nameId`), bus slot, state, priority, gain (the table's with the event automation and the stem level as `Audio.debug()`
//   multiplies them), pitch (u4.12), audibility (u0.16) and the playhead in the clip's own frames. `reason` is the part of
//   §5.6's code the table keeps: 1 for a cap demotion (`VoiceReason.VIRTUAL`) and for a voice waiting on its clip, else 0 (the
//   table doesn't keep why a voice went below audibility or why it was stolen; the events carry those).
// - **buses** from the session slot table (live slots and tombstones) and the mixer's lanes: each of the five main-written
//   lanes' value and target, the duck lane's value and the automation lane's, the mutes and solo, and the tombstone and
//   metered flags. Values come from `Mixer.laneGain`, targets from the lane's `Ramp.to` (the lane writer's own inputs).
// - **metered** buses from the loudness hub: the final output (slot `LOUD_OUTPUT_TAP`) first, then the buses chosen in the
//   project, at most 9 rows.
// - **eventVoices**: each event instance's live voices (the table's group ids), and the **mix** section: the slot table's
//   version, the monitor flag, the paused meters, the target in force, the active snapshot, the master volume and the
//   hidden-tab mute. ADR 0249: the event and music rows are composed above the seam (`audioRows.ts`), for every backend.
//
// **Allocation (FU5).** Every row (voice, bus, metered) is pooled and rewritten in place, the output arrays, the slot flags
// and the per-event voice counts are reused, and there are no per-keyframe Sets, closures or `?? []` fallbacks: the recorder
// asks for allocation-free sources.
//
// **Chunk boundary.** The recorder chunk (`capture/format.ts`) is lazy and this file is in every game that uses the core, so it
// imports the keyframe types only from there; the row layout (caps, codes, flag bits, quantising) is `capture/keyframeLayout.ts`
// (ADR 0230), which the reader decodes with too.
import type { KeyframeBus, KeyframeMetered, KeyframeVoice } from "../capture/format";
import type { BackendKeyframe } from "../backend";
import {
  KEYFRAME_BUS_LANES, KEYFRAME_MAX_BUSES, KEYFRAME_MAX_METERED, KEYFRAME_MAX_VOICES, KEYFRAME_PITCH_ONE,
  KeyframeBusFlag, KeyframeMeteredFlag, KeyframeVoiceState, keyframeAudibility, keyframePitch,
} from "../capture/keyframeLayout";
import type { Mixer } from "../../../../engine/audio/mixer";
import { writeKeyframeBusLanes } from "../mix/keyframeBus";
import type { SlotTable } from "../../../../engine/audio/slotTable";
import { loudnessHub, type LoudnessHub } from "../mix/loudnessHub";
import { LOUD_OUTPUT_TAP } from "../wire.generated";
import type { ClipInfo } from "./clipRegistry";
import { STOLEN_LISTED_FRAMES, type DebugSource } from "./debug";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";
import { reportedGain, reportedPitch } from "./voices";

/** The NAMES tables a keyframe interns into (`capture/events.ts`: `clips`, `events` and `snapshots`). */
export type KeyframeNameTable = "clips" | "snapshots" | "events";
export type KeyframeNameId = (table: KeyframeNameTable, name: string) => number;

/** What the source reads of the core backend; `CoreBackend` satisfies it. */
export interface KeyframeHost extends Pick<DebugSource, "table" | "clips" | "streams" | "musicOps" | "playheads" | "automation" | "clockMap"> {
  readonly mixer: Pick<Mixer, "audioSettings" | "monitorActive" | "currentSnapshot" | "busNames" | "time" | "_lanes" | "laneGain">;
  /** The session slot table (`BusIndex.slots`). */
  readonly buses: { readonly slots: Pick<SlotTable, "slots" | "version"> };
  readonly masterVolume: number;
  readonly hiddenMuted: boolean;
}

function voiceRow(): KeyframeVoice {
  return { id: 0, clip: 0, slot: 0, state: 0, priority: 0, reason: 0, gain: 1, pitch: KEYFRAME_PITCH_ONE, audibility: 0, playheadFrames: 0 };
}
function busRow(): KeyframeBus {
  return { slot: 0, gen: 0, flags: 0, lanes: new Array<number>(KEYFRAME_BUS_LANES).fill(0), duck: 1, automation: 1 };
}

function meteredRow(): KeyframeMetered {
  return { slot: 0, flags: 0, momentary: 0, shortTerm: 0, integrated: 0, lra: 0, maxTruePeak: 0, maxMomentary: 0, elapsed: 0 };
}
/** The shared empty list for an absent `loudnessTargets` (never `?? []`). */
const NO_TARGETS: readonly { readonly name: string }[] = Object.freeze([]);

/** The keyframe `state` of a live table slot (`debug.ts`'s `stateName`, as the §5.5 code). */
function stateOf(table: VoiceTable, i: number): number {
  const reason = table.reason[i];
  switch (table.state[i]) {
    case VoiceState.LOCKED:
      return KeyframeVoiceState.locked;
    case VoiceState.WAITING_FOR_DATA:
      return KeyframeVoiceState.waitingForData;
    case VoiceState.VIRTUAL:
      return reason === VoiceReason.BUS_MUTED ? KeyframeVoiceState.busMuted : reason === VoiceReason.WAITING_FOR_DATA ? KeyframeVoiceState.waitingForData : KeyframeVoiceState.virtual;
    case VoiceState.PLAYING:
      return reason === VoiceReason.BUS_MUTED ? KeyframeVoiceState.busMuted : reason === VoiceReason.WAITING_FOR_DATA ? KeyframeVoiceState.waitingForData : KeyframeVoiceState.playing;
    default:
      return KeyframeVoiceState.playing; // STOPPING and ENDING still read as playing
  }
}

/** One keyframe source: owns the pooled rows. `capture.ts` makes one per ring (through `CoreBackend.keyframe`). */
export class KeyframeSource {
  private readonly voicePool: KeyframeVoice[] = [];
  private readonly busPool: KeyframeBus[] = [];
  private readonly voices: KeyframeVoice[] = [];
  private readonly buses: KeyframeBus[] = [];
  private readonly meteredPool: KeyframeMetered[] = [];
  private readonly meteredOut: KeyframeMetered[] = [];
  /** Slot flags of the metered buses (grown with the slot table). */
  private meteredFlags = new Uint8Array(KEYFRAME_MAX_BUSES);
  /** Each event instance's live voices (`BackendKeyframe.eventVoices`), refilled per keyframe. */
  private readonly listed = new Map<number, number>();
  private readonly auto = { gain: 1, pitch: 1, lowpass: 0, highpass: 0, pan: 0 };
  private readonly payload: { -readonly [K in keyof BackendKeyframe]: BackendKeyframe[K] } = {
    voices: this.voices, buses: this.buses, metered: this.meteredOut, eventVoices: this.listed,
    mix: { slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 },
  };

  constructor(private readonly host: KeyframeHost, private readonly hub: Pick<LoudnessHub, "busLoudness"> & { readonly target: string | null } = loudnessHub) {}

  /** The payload at this instant (the object and its rows are reused by the next call). `noName` is the id for none. */
  read(nameId: KeyframeNameId, noName: number): BackendKeyframe {
    const p = this.payload;
    this.readVoices(nameId, noName);
    this.readBuses();
    this.readMetered();
    const m = this.host.mixer;
    const mix = p.mix;
    mix.slotTableVersion = this.host.buses.slots.version >>> 0;
    mix.monitorActive = m.monitorActive ? 1 : 0;
    mix.loudnessPausedMask = 0;
    const metered = this.meteredOut;
    for (let k = 0; k < metered.length && k < 8; k++) {
      if ((metered[k]!.flags & KeyframeMeteredFlag.paused) !== 0) mix.loudnessPausedMask |= 1 << k;
    }
    const targets = m.audioSettings.loudnessTargets ?? NO_TARGETS;
    const inForce = this.hub.target;
    let found = 0;
    for (let k = 0; k < targets.length; k++) {
      if (targets[k]!.name === inForce) { found = k; break; }
    }
    mix.targetIndex = found & 0xff;
    const snapshot = m.currentSnapshot;
    mix.snapshotName = snapshot === null ? noName : nameId("snapshots", snapshot);
    mix.masterVolume = Math.fround(this.host.masterVolume);
    mix.hiddenMute = this.host.hiddenMuted ? 1 : 0;
    return p;
  }

  private nextVoice(): KeyframeVoice | null {
    const n = this.voices.length;
    if (n >= KEYFRAME_MAX_VOICES) return null;
    const row = (this.voicePool[n] ??= voiceRow());
    this.voices.push(row);
    return row;
  }

  private readVoices(nameId: KeyframeNameId, noName: number): void {
    const host = this.host;
    const table = host.table;
    this.voices.length = 0;
    this.listed.clear();
    const auto = this.auto;
    const rateNow = host.clockMap?.framesNow;
    for (let i = 0; i < table.capacity; i++) {
      if (table.state[i] === VoiceState.FREE) continue;
      const flags = table.flags[i]!;
      const stream = (flags & VoiceFlag.STREAM) !== 0 && host.streams;
      const clip: ClipInfo | null = stream ? (host.streams!.clipInfo(table.clip[i]!) ?? host.musicOps?.clipInfo?.(table.clip[i]!) ?? null) : host.clips.info(table.clip[i]!);
      const group = table.group[i]!;
      if (group !== 0) this.listed.set(group, (this.listed.get(group) ?? 0) + 1);
      const row = this.nextVoice();
      if (!row) continue; // past the cap: the rest are counted by the ring's GAP, not written
      const automated = host.automation?.voiceAutomation?.(i, auto) === true;
      row.id = ((table.gen[i]! << 16) | i) >>> 0;
      row.clip = clip?.path ? nameId("clips", clip.path) : noName;
      row.slot = table.bus[i]! & 0xff;
      row.state = stateOf(table, i);
      row.priority = table.priority[i]!;
      row.reason = (row.state === KeyframeVoiceState.virtual && table.reason[i] === VoiceReason.VIRTUAL) || row.state === KeyframeVoiceState.waitingForData ? 1 : 0;
      row.gain = Math.fround(reportedGain(table, i, automated ? auto.gain : 1));
      row.pitch = keyframePitch(reportedPitch(table, i, automated ? auto.pitch : 1));
      row.audibility = keyframeAudibility(table.audibility[i]!);
      let playhead = 0;
      if ((flags & VoiceFlag.WANTS_PLAYHEAD) !== 0) playhead = table.playhead[i]!;
      else if (group !== 0 && host.playheads && rateNow) {
        const s = table.state[i];
        if (s === VoiceState.PLAYING || s === VoiceState.VIRTUAL || s === VoiceState.STOPPING || s === VoiceState.ENDING) {
          let pos = host.playheads.wrappedNow(i, rateNow.call(host.clockMap));
          const frames = clip?.frames ?? 0;
          if (frames > 0 && pos > frames) pos = frames;
          playhead = Math.max(0, Math.floor(pos));
        }
      }
      row.playheadFrames = playhead >>> 0;
    }
    // The steals `Audio.debug()` still lists (about the last second): state stolen, no gain.
    for (let k = 0; k < table.stolenSize; k++) {
      const r = (table.stolenHead - 1 - k + 2 * table.stolenIds.length) % table.stolenIds.length;
      if (table.frame - table.stolenFrame[r]! > STOLEN_LISTED_FRAMES) break;
      const row = this.nextVoice();
      if (!row) break;
      const path = host.clips.info(table.stolenClip[r]!)?.path;
      row.id = table.stolenIds[r]!;
      row.clip = path ? nameId("clips", path) : noName;
      row.slot = table.stolenBus[r]! & 0xff;
      row.state = KeyframeVoiceState.stolen;
      row.priority = table.stolenPriority[r]!;
      row.reason = 0;
      row.gain = 0;
      row.pitch = KEYFRAME_PITCH_ONE;
      row.audibility = 0;
      row.playheadFrames = 0;
    }
  }

  /** The live slot named `name`, or -1 (a loop: `findIndex` would allocate its closure). */
  private liveSlot(name: string): number {
    const slots = this.host.buses.slots.slots;
    for (let i = 0; i < slots.length; i++) {
      const s = slots[i]!;
      if (s.state === "live" && s.name === name) return i;
    }
    return -1;
  }

  private addBus(slot: number, name: string | null, tombstone: boolean, gen: number, root: string | undefined): void {
    const out = this.buses;
    if (out.length >= KEYFRAME_MAX_BUSES) return;
    const m = this.host.mixer;
    const row = (this.busPool[out.length] ??= busRow());
    row.slot = slot & 0xff;
    row.gen = gen & 0xffff;
    // The lanes as the Babylon fallback reads them too (`mix/keyframeBus.ts`, ADR 0179).
    const gates = name === null ? -1 : writeKeyframeBusLanes(row, m, name);
    if (gates < 0) {
      (row.lanes as number[]).fill(0);
      row.flags = tombstone ? KeyframeBusFlag.tombstone : 0;
      row.duck = 1;
      row.automation = 1;
    } else {
      row.flags = gates | (tombstone ? KeyframeBusFlag.tombstone : 0) | (this.isMetered(slot) || name === root ? KeyframeBusFlag.metered : 0);
    }
    out.push(row);
  }

  private isMetered(slot: number): boolean {
    return slot < this.meteredFlags.length && this.meteredFlags[slot] !== 0;
  }

  /** Fills `buses` and marks the slots that are metered in `meteredFlags`. */
  private readBuses(): void {
    const host = this.host;
    const m = host.mixer;
    const slots = host.buses.slots.slots;
    this.buses.length = 0;
    if (this.meteredFlags.length < slots.length) this.meteredFlags = new Uint8Array(slots.length * 2); // grows with the table, never per keyframe
    else this.meteredFlags.fill(0);
    const settings = m.audioSettings.buses;
    const root = settings[0]?.name;
    for (let i = 0; i < settings.length; i++) {
      const name = settings[i]!.name;
      const meter = this.hub.busLoudness(name);
      if (!meter || name === root) continue;
      const slot = this.liveSlot(name);
      if (slot >= 0) this.meteredFlags[slot] = 1;
    }
    if (slots.length === 0) {
      const names = m.busNames;
      for (let i = 0; i < names.length; i++) this.addBus(i, names[i]!, false, 0, root); // not configured yet: the identity layout
    } else {
      for (let i = 0; i < slots.length; i++) {
        const s = slots[i]!;
        if (s.state === "free") continue;
        // A tombstone is a silent root the mixer no longer holds lanes for (or still does, while it fades).
        this.addBus(i, s.name, s.state === "tombstone", s.gen, root);
      }
    }
  }

  private meteredRow(slot: number, name: string): void {
    const out = this.meteredOut;
    const l = this.hub.busLoudness(name);
    if (!l || out.length >= KEYFRAME_MAX_METERED) return;
    const row = (this.meteredPool[out.length] ??= meteredRow());
    row.slot = slot;
    row.flags = (l.paused ? KeyframeMeteredFlag.paused : 0) | (l.incomplete ? KeyframeMeteredFlag.incomplete : 0) | (l.tainted ? KeyframeMeteredFlag.tainted : 0)
      | (l.truePeakBound === "lowerBound" ? KeyframeMeteredFlag.lowerBound : 0);
    row.momentary = Math.fround(l.momentary);
    row.shortTerm = Math.fround(l.shortTerm);
    row.integrated = Math.fround(l.integrated);
    row.lra = Math.fround(l.lra);
    row.maxTruePeak = Math.fround(l.maxTruePeak);
    row.maxMomentary = Math.fround(l.maxMomentary);
    row.elapsed = Math.fround(l.elapsed);
    out.push(row);
  }

  private readMetered(): void {
    this.meteredOut.length = 0;
    const settings = this.host.mixer.audioSettings.buses;
    const root = settings[0]?.name;
    if (root !== undefined) this.meteredRow(LOUD_OUTPUT_TAP, root);
    for (let i = 0; i < settings.length; i++) {
      const name = settings[i]!.name;
      if (name === root) continue;
      const slot = this.liveSlot(name);
      if (slot >= 0 && this.isMetered(slot)) this.meteredRow(slot, name);
    }
  }
}
