// ADR 0171 amended by 0172 (M5, task G7b; api-and-models §5.5): the core backend's KEYFRAME source. `capture.ts` hands the
// recorder `() => backend.keyframe(nameId)`, which `CoreBackend.keyframe` delegates to `keyframePayload` here: the main-side
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
// - **events** from the event runtime's rows (the asset is interned into the `events` table, as the sink does), **music** from
//   the music players (segment and pending segment interned into the `events` table, as `musicTransition` does), and the **mix**
//   section: the slot table's version, the monitor flag, the paused meters, the target in force, the active snapshot, the master
//   volume and the hidden-tab mute.
//
// **Allocation.** The voice and bus rows are pooled and rewritten in place (the recorder asks for allocation-free sources); the
// event and music rows come from the runtime's own allocating row builders, small and once a second.
//
// **Chunk boundary.** The recorder chunk (`capture/format.ts`) is lazy and this file is in every game that uses the core, so it
// imports the keyframe types only; the caps below repeat `format.ts`'s `KEYFRAME_MAX_*` (a test holds them equal).
import type { KeyframeBus, KeyframeEvent, KeyframeMetered, KeyframeMusic, KeyframePayload, KeyframeVoice } from "../capture/format";
import { Lane, type Mixer } from "../../../../engine/audio/mixer";
import type { SlotTable } from "../../../../engine/audio/slotTable";
import { events } from "../events/eventRuntime";
import { loudnessHub, type LoudnessHub } from "../mix/loudnessHub";
import { ticksToPosition, spanAtTicks } from "../../../../engine/audio/musicGrid";
import { playingGridOf, ticksAt } from "../music/anchors";
import { musicPlayers, type MusicPlayerState } from "../music/musicSystem";
import { LOUD_OUTPUT_TAP } from "../wire.generated";
import type { ClipInfo } from "./clipRegistry";
import { STOLEN_LISTED_FRAMES, type DebugSource } from "./debug";
import { VoiceFlag, VoiceReason, VoiceState, type VoiceTable } from "./voiceTable";

/** `KEYFRAME_MAX_VOICES`, `_BUSES`, `_METERED`, `_EVENTS`, `_MUSIC` of `capture/format.ts`. */
export const KF_MAX_VOICES = 8_192;
export const KF_MAX_BUSES = 32;
export const KF_MAX_METERED = 9;
export const KF_MAX_EVENTS = 1_024;
export const KF_MAX_MUSIC = 16;

/** The NAMES tables a keyframe interns into (`capture/events.ts`: `clips`, `events` and `snapshots`). */
export type KeyframeNameTable = "clips" | "snapshots" | "events";
export type KeyframeNameId = (table: KeyframeNameTable, name: string) => number;

/** The keyframe voice `state` codes (§5.5). */
export const KfVoiceState = { playing: 0, virtual: 1, stolen: 2, waitingForData: 3, busMuted: 4, locked: 5 } as const;
/** The keyframe bus `flags` bits beyond the four lane gates (§5.5: tombstone, metered). */
export const KF_BUS_TOMBSTONE = 16;
export const KF_BUS_METERED = 32;
/** The keyframe metered `flags` bits (§5.5). */
const KF_M_PAUSED = 1, KF_M_INCOMPLETE = 2, KF_M_TAINTED = 4, KF_M_LOWER_BOUND = 8;
/** The keyframe music `state` codes, in `MusicDebugState`'s order. */
export const KfMusicState = { priming: 0, playing: 1, transitioning: 2, recovering: 3, ending: 4 } as const;

/** What the source reads of the core backend; `CoreBackend` satisfies it. */
export interface KeyframeHost extends Pick<DebugSource, "table" | "clips" | "streams" | "musicOps" | "playheads" | "automation" | "clockMap"> {
  readonly mixer: Pick<Mixer, "audioSettings" | "monitorActive" | "currentSnapshot" | "busNames" | "time" | "_lanes" | "laneGain">;
  /** The session slot table (`BusIndex.slots`). */
  readonly buses: { readonly slots: Pick<SlotTable, "slots" | "version"> };
  readonly masterVolume: number;
  readonly hiddenMuted: boolean;
}

const clamp01 = (v: number): number => (Number.isFinite(v) ? (v < 0 ? 0 : v > 1 ? 1 : v) : 0);
const u16 = (v: number): number => Math.min(0xffff, Math.max(0, Math.round(v)));

function voiceRow(): KeyframeVoice {
  return { id: 0, clip: 0, slot: 0, state: 0, priority: 0, reason: 0, gain: 1, pitch: 4096, audibility: 0, playheadFrames: 0 };
}
function busRow(): KeyframeBus {
  return { slot: 0, gen: 0, flags: 0, lanes: new Array<number>(10).fill(0), duck: 1, automation: 1 };
}

/** The keyframe `state` of a live table slot (`debug.ts`'s `stateName`, as the §5.5 code). */
function stateOf(table: VoiceTable, i: number): number {
  const reason = table.reason[i];
  switch (table.state[i]) {
    case VoiceState.LOCKED:
      return KfVoiceState.locked;
    case VoiceState.WAITING_FOR_DATA:
      return KfVoiceState.waitingForData;
    case VoiceState.VIRTUAL:
      return reason === VoiceReason.BUS_MUTED ? KfVoiceState.busMuted : reason === VoiceReason.WAITING_FOR_DATA ? KfVoiceState.waitingForData : KfVoiceState.virtual;
    case VoiceState.PLAYING:
      return reason === VoiceReason.BUS_MUTED ? KfVoiceState.busMuted : reason === VoiceReason.WAITING_FOR_DATA ? KfVoiceState.waitingForData : KfVoiceState.playing;
    default:
      return KfVoiceState.playing; // STOPPING and ENDING still read as playing
  }
}

/** FNV-1a over an event's parameters (sorted by name), so a change shows between two keyframes. */
function paramsHash(parameters: Readonly<Record<string, number | string>>): number {
  let h = 0x811c9dc5;
  for (const key of Object.keys(parameters).sort()) {
    const text = `${key}=${parameters[key]}`;
    for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 0x01000193);
  }
  return h >>> 0;
}

function musicStateOf(s: MusicPlayerState): number {
  switch (s) {
    case "playing":
    case "pending":
      return KfMusicState.playing;
    case "transitioning":
      return KfMusicState.transitioning;
    case "recovering":
      return KfMusicState.recovering;
    case "stopping":
    case "stopped":
    case "refused":
      return KfMusicState.ending;
    default:
      return KfMusicState.priming;
  }
}

/** One keyframe source: owns the pooled rows. `capture.ts` makes one per ring (through `CoreBackend.keyframe`). */
export class KeyframeSource {
  private readonly voicePool: KeyframeVoice[] = [];
  private readonly busPool: KeyframeBus[] = [];
  private readonly voices: KeyframeVoice[] = [];
  private readonly buses: KeyframeBus[] = [];
  private readonly listed = new Map<number, number>();
  private readonly auto = { gain: 1, pitch: 1, lowpass: 0 };
  private readonly payload: { -readonly [K in keyof KeyframePayload]: KeyframePayload[K] } = {
    voices: this.voices, buses: this.buses, metered: [], events: [], music: [],
    mix: { slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 },
  };

  constructor(private readonly host: KeyframeHost, private readonly hub: Pick<LoudnessHub, "busLoudness"> & { readonly target: string | null } = loudnessHub) {}

  /** The payload at this instant (the object and its rows are reused by the next call). `noName` is the id for none. */
  read(nameId: KeyframeNameId, noName: number): KeyframePayload {
    const p = this.payload;
    this.readVoices(nameId, noName);
    const metered = this.readBuses();
    p.metered = this.readMetered(metered);
    p.events = this.readEvents(nameId);
    p.music = this.readMusic(nameId, noName);
    const m = this.host.mixer;
    const mix = p.mix;
    mix.slotTableVersion = this.host.buses.slots.version >>> 0;
    mix.monitorActive = m.monitorActive ? 1 : 0;
    mix.loudnessPausedMask = 0;
    p.metered.forEach((row, k) => {
      if (k < 8 && (row.flags & KF_M_PAUSED) !== 0) mix.loudnessPausedMask |= 1 << k;
    });
    const targets = m.audioSettings.loudnessTargets ?? [];
    const inForce = this.hub.target;
    mix.targetIndex = Math.max(0, targets.findIndex((t) => t.name === inForce)) & 0xff;
    const snapshot = m.currentSnapshot;
    mix.snapshotName = snapshot === null ? noName : nameId("snapshots", snapshot);
    mix.masterVolume = Math.fround(this.host.masterVolume);
    mix.hiddenMute = this.host.hiddenMuted ? 1 : 0;
    return p;
  }

  private nextVoice(): KeyframeVoice | null {
    const n = this.voices.length;
    if (n >= KF_MAX_VOICES) return null;
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
      row.reason = (row.state === KfVoiceState.virtual && table.reason[i] === VoiceReason.VIRTUAL) || row.state === KfVoiceState.waitingForData ? 1 : 0;
      row.gain = Math.fround((automated ? table.gain[i]! * auto.gain : table.gain[i]!) * table.stemGain[i]!);
      row.pitch = u16(((automated ? table.pitch[i]! * auto.pitch : table.pitch[i]!)) * 4096);
      row.audibility = u16(clamp01(table.audibility[i]!) * 65536);
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
      row.state = KfVoiceState.stolen;
      row.priority = table.stolenPriority[r]!;
      row.reason = 0;
      row.gain = 0;
      row.pitch = 4096;
      row.audibility = 0;
      row.playheadFrames = 0;
    }
  }

  /** Fills `buses` and returns the slots that are metered (in the hub's order). */
  private readBuses(): Set<number> {
    const host = this.host;
    const m = host.mixer;
    const slots = host.buses.slots.slots;
    const out = this.buses;
    out.length = 0;
    const meteredSlots = new Set<number>();
    const root = m.audioSettings.buses[0]?.name;
    for (const b of m.audioSettings.buses) {
      const meter = this.hub.busLoudness(b.name);
      const slot = slots.findIndex((s) => s.state === "live" && s.name === b.name);
      if (meter && slot >= 0 && b.name !== root) meteredSlots.add(slot);
    }
    const add = (slot: number, name: string | null, tombstone: boolean, gen: number): void => {
      if (out.length >= KF_MAX_BUSES) return;
      const row = (this.busPool[out.length] ??= busRow());
      row.slot = slot & 0xff;
      row.gen = gen & 0xffff;
      const lanes = name === null ? undefined : m._lanes(name);
      const L = row.lanes as number[];
      if (!lanes || name === null) {
        L.fill(0);
        row.flags = tombstone ? KF_BUS_TOMBSTONE : 0;
        row.duck = 1;
        row.automation = 1;
      } else {
        const set = (k: number, lane: 0 | 1 | 2 | 3 | 4, to: number): void => {
          L[2 * k] = Math.fround(m.laneGain(name, lane));
          L[2 * k + 1] = Math.fround(to);
        };
        set(0, Lane.authored, lanes.authoredMute ? 0 : lanes.authored.to);
        set(1, Lane.runtime, lanes.runtimeMute ? 0 : lanes.runtime.to);
        set(2, Lane.snapshot, lanes.snapshot.to);
        set(3, Lane.monitor, m.laneGain(name, Lane.monitor));
        set(4, Lane.dip, lanes.dip.to);
        row.flags = (lanes.authoredMute ? 1 : 0) | (lanes.runtimeMute ? 2 : 0) | (lanes.monitorMute ? 4 : 0) | (lanes.monitorSolo ? 8 : 0)
          | (tombstone ? KF_BUS_TOMBSTONE : 0) | (meteredSlots.has(slot) || name === root ? KF_BUS_METERED : 0);
        row.duck = Math.fround(m.laneGain(name, Lane.duck));
        row.automation = Math.fround(m.laneGain(name, Lane.automation));
      }
      out.push(row);
    };
    if (slots.length === 0) {
      m.busNames.forEach((name, i) => add(i, name, false, 0)); // not configured yet: the identity layout
    } else {
      slots.forEach((s, i) => {
        if (s.state === "free") return;
        // A tombstone is a silent root the mixer no longer holds lanes for (or still does, while it fades).
        add(i, s.name, s.state === "tombstone", s.gen);
      });
    }
    return meteredSlots;
  }

  private readMetered(meteredSlots: ReadonlySet<number>): KeyframeMetered[] {
    const host = this.host;
    const slots = host.buses.slots.slots;
    const out: KeyframeMetered[] = [];
    const settings = host.mixer.audioSettings;
    const row = (slot: number, name: string): void => {
      const l = this.hub.busLoudness(name);
      if (!l || out.length >= KF_MAX_METERED) return;
      out.push({
        slot,
        flags: (l.paused ? KF_M_PAUSED : 0) | (l.incomplete ? KF_M_INCOMPLETE : 0) | (l.tainted ? KF_M_TAINTED : 0) | (l.truePeakBound === "lowerBound" ? KF_M_LOWER_BOUND : 0),
        momentary: Math.fround(l.momentary), shortTerm: Math.fround(l.shortTerm), integrated: Math.fround(l.integrated), lra: Math.fround(l.lra),
        maxTruePeak: Math.fround(l.maxTruePeak), maxMomentary: Math.fround(l.maxMomentary), elapsed: Math.fround(l.elapsed),
      });
    };
    const root = settings.buses[0]?.name;
    if (root !== undefined) row(LOUD_OUTPUT_TAP, root);
    for (const b of settings.buses) {
      if (b.name === root) continue;
      const slot = slots.findIndex((s) => s.state === "live" && s.name === b.name);
      if (slot >= 0 && meteredSlots.has(slot)) row(slot, b.name);
    }
    return out;
  }

  private readEvents(nameId: KeyframeNameId): KeyframeEvent[] {
    const out: KeyframeEvent[] = [];
    for (const e of events().debugRows(this.listed)) {
      if (out.length >= KF_MAX_EVENTS) break;
      out.push({ id: e.id >>> 0, asset: nameId("events", e.asset), voices: Math.min(0xffff, e.voices), state: 0, paramsHash: paramsHash(e.parameters) });
    }
    return out;
  }

  private readMusic(nameId: KeyframeNameId, noName: number): KeyframeMusic[] {
    const out: KeyframeMusic[] = [];
    const players = musicPlayers();
    if (players.length === 0) return out;
    return this.musicRows(players, nameId, noName, out);
  }

  private musicRows(players: ReturnType<typeof musicPlayers>, nameId: KeyframeNameId, noName: number, out: KeyframeMusic[]): KeyframeMusic[] {
    const time = this.host.mixer.time; // the heard clock (`Audio.time`'s base)
    for (const p of players) {
      if (out.length >= KF_MAX_MUSIC) break;
      const a = p.anchor;
      const pg = a ? playingGridOf(a) : null;
      let bar = 1, beat = 1, tick = 0, tempo = 0;
      if (a && pg) {
        const ticks = ticksAt(a, time);
        const pos = Number.isFinite(ticks) ? ticksToPosition(pg.grid, ticks) : null;
        if (pos) ({ bar, beat, tick } = pos);
        tempo = pg.grid.bpm[spanAtTicks(pg.grid, Number.isFinite(ticks) ? ticks : 0)]!;
      }
      const t = p.transition;
      const pending = t && t.match && t.state !== "done" && t.state !== "cancelled";
      out.push({
        id: p.instance.group >>> 0,
        segment: p.run ? nameId("events", p.run.node.id) : noName,
        state: musicStateOf(p.state),
        pass: Math.min(255, Math.max(0, a?.pass ?? 1)),
        bar: u16(bar), beat: Math.min(255, Math.max(0, beat)), tick: Math.min(255, Math.max(0, Math.round(tick))), tempo: u16(tempo),
        pendingTo: pending ? nameId("events", t.to.id) : noName,
        pendingTimeSec: pending && Number.isFinite(t.exitAt) ? Math.fround(t.exitAt) : 0,
      });
    }
    return out;
  }
}

/** One source per host, for `CoreBackend.keyframe`. */
export function keyframePayload(source: KeyframeSource, nameId: KeyframeNameId, noName: number): KeyframePayload {
  return source.read(nameId, noName);
}
