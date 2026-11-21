// The rows above the audio backend seam (ADR 0249): `Audio.debug()` and the capture's KEYFRAME get their event and music
// sections here, once, from the page-wide registries (the event runtime's instances, the music players), whichever backend
// plays. A backend reports only what it owns: voices, buses, meters and the mix section, how many of its voices each event
// instance has, and its music backend's own view (`MusicBackend.debugView`: the ring pool, the live groups, its group
// counters). Neither backend imports `events/` or `music/` for rows.
//
// - **Debug** (`debugRows`): `events` (the runtime's rows, keeping an instance while the backend still lists one of its
//   voices, E3.9) and `eventTotals`; on a backend with music, `music` (one row per player: segment, position, the pending
//   change and its rule, groups, stems, counters) and `musicTotals` (the music backend's view plus main's session sums,
//   ADR 0220). Fresh objects per call; debug only.
// - **Keyframe** (`KeyframeRows`): the backend's keyframe with the `events` and `music` sections added (§5.5). Every row is
//   pooled and rewritten in place, as the recorder asks of its sources (FU5); what still allocates is the strings an event's
//   parameter values hash through.
//
// The capture's row layout (caps, state codes, quantising) is `capture/keyframeLayout.ts` (ADR 0230); this module imports
// the keyframe types only from the lazy `capture/format.ts` chunk.
import type { AudioBackend, AudioCaptureSource, AudioDebugInfo, MusicBackend, MusicBackendDebug, MusicDebugRow, MusicDebugState, MusicDebugTotals } from "./backend";
import type { KeyframeEvent, KeyframeMusic, KeyframePayload } from "./capture/format";
import { KEYFRAME_MAX_EVENTS, KEYFRAME_MAX_MUSIC, KeyframeMusicState, keyframeU16 } from "./capture/keyframeLayout";
import { events, type EventDebugRow } from "./events/eventRuntime";
import { ticksAt } from "./music/anchors";
import { segmentGrid } from "./music/segmentGrids";
import { musicCounterTotals, musicPlayers, type MusicPlayer, type MusicPlayerState } from "./music/musicSystem";
import { spanAtTicks, ticksToPosition, type SegmentGrid } from "../../../engine/audio/musicGrid";

/** What the composer adds to a backend's `AudioDebugInfo` for `Audio.debug()`. */
export interface AudioDebugRows {
  events: EventDebugRow[];
  eventTotals: { lateStarts: number };
  /** Present on a backend with music (`AudioBackend.music`). */
  music?: MusicDebugRow[];
  musicTotals?: MusicDebugTotals;
}

/** What the debug rows read of a backend: its heard time and its music's own view and Ê. */
export interface DebugRowsBackend {
  readonly time: number;
  readonly music?: Pick<MusicBackend, "debugView" | "primeEmaMs">;
}

/** The event and music rows for `Audio.debug()`, from `info` (the backend's `debug()`) and the backend's music. Allocates. */
export function debugRows(info: Pick<AudioDebugInfo, "voices">, backend: DebugRowsBackend): AudioDebugRows {
  // E3.9: each event's voices the backend still lists, so an instance's row goes with its last voice.
  const listed = new Map<number, number>();
  for (const v of info.voices) if (v.event != null && v.state !== "stolen") listed.set(v.event, (listed.get(v.event) ?? 0) + 1);
  const rows = events();
  const out: AudioDebugRows = { events: rows.debugRows(listed), eventTotals: { lateStarts: rows.lateStartTotal } };
  const music = backend.music;
  if (music) {
    const view = music.debugView();
    out.music = musicPlayers().map((p) => musicDebugRow(p, backend.time, view, music));
    out.musicTotals = musicTotals(view);
  }
  return out;
}

/** The capture's keyframe source over one backend's: adds the event and music sections into pooled rows. */
export class KeyframeRows {
  private readonly eventsPool: KeyframeEvent[] = [];
  private readonly musicPool: KeyframeMusic[] = [];
  private readonly eventsOut: KeyframeEvent[] = [];
  private readonly musicOut: KeyframeMusic[] = [];
  /** The event runtime's pooled debug rows, refilled per keyframe. */
  private readonly debugOut: EventDebugRow[] = [];
  /** The parameter names `paramsHash` sorts in place. */
  private readonly keys: string[] = [];
  private readonly pos = { bar: 1, beat: 1, tick: 0, tempo: 0, beatsPerBar: 0 };
  private readonly payload: { -readonly [K in keyof KeyframePayload]: KeyframePayload[K] } = {
    voices: [], buses: [], metered: [], events: this.eventsOut, music: this.musicOut,
    mix: { slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 },
  };

  constructor(private readonly source: AudioCaptureSource, private readonly backend: Pick<AudioBackend, "time">) {}

  /** The payload at this instant (the object and its rows are reused by the next call). `noName` is the id for none. */
  read(nameId: (table: "clips" | "snapshots" | "events", name: string) => number, noName: number): KeyframePayload {
    const k = this.source.keyframe(nameId, noName);
    const p = this.payload;
    p.voices = k.voices;
    p.buses = k.buses;
    p.metered = k.metered;
    p.mix = k.mix;
    this.readEvents(k.eventVoices, nameId);
    this.readMusic(nameId, noName);
    return p;
  }

  private readEvents(listed: ReadonlyMap<number, number>, nameId: (table: "events", name: string) => number): void {
    const out = this.eventsOut;
    out.length = 0;
    // Pooled: the event runtime refills `debugOut` with its own reused row objects (nothing built per keyframe).
    const rows = events().debugRows(listed, this.debugOut);
    for (let i = 0; i < rows.length; i++) {
      const e = rows[i]!;
      if (out.length >= KEYFRAME_MAX_EVENTS) break;
      const row = (this.eventsPool[out.length] ??= { id: 0, asset: 0, voices: 0, state: 0, paramsHash: 0 });
      row.id = e.id >>> 0;
      row.asset = nameId("events", e.asset);
      row.voices = Math.min(0xffff, e.voices);
      row.state = 0;
      row.paramsHash = paramsHash(e.parameters, this.keys);
      out.push(row);
    }
  }

  private readMusic(nameId: (table: "events", name: string) => number, noName: number): void {
    const out = this.musicOut;
    out.length = 0;
    const players = musicPlayers();
    const time = this.backend.time; // the heard clock
    const pos = this.pos;
    for (let i = 0; i < players.length; i++) {
      const p = players[i]!;
      if (out.length >= KEYFRAME_MAX_MUSIC) break;
      positionOf(p, time, pos);
      const t = p.transition;
      const pending = t && t.match && t.state !== "done" && t.state !== "cancelled";
      const row = (this.musicPool[out.length] ??= { id: 0, segment: 0, state: 0, pass: 0, bar: 0, beat: 0, tick: 0, tempo: 0, pendingTo: 0, pendingTimeSec: 0 });
      row.id = p.instance.group >>> 0;
      row.segment = p.run ? nameId("events", p.run.node.id) : noName;
      row.state = KeyframeMusicState[musicState(p.state)];
      row.pass = Math.min(255, Math.max(0, p.anchor?.pass ?? 1));
      row.bar = keyframeU16(pos.bar);
      row.beat = Math.min(255, Math.max(0, pos.beat));
      row.tick = Math.min(255, Math.max(0, Math.round(pos.tick)));
      row.tempo = keyframeU16(pos.tempo);
      row.pendingTo = pending ? nameId("events", t.to.id) : noName;
      row.pendingTimeSec = pending && Number.isFinite(t.exitAt) ? Math.fround(t.exitAt) : 0;
      out.push(row);
    }
  }
}

// --- Shared ----------------------------------------------------------------------------------------------------------

/** The player's lifecycle as a row's state (§1.6): a pending change still plays, so it reads `playing`. */
function musicState(s: MusicPlayerState): MusicDebugState {
  switch (s) {
    case "playing":
    case "pending":
      return "playing";
    case "transitioning":
      return "transitioning";
    case "recovering":
      return "recovering";
    case "stopping":
    case "stopped":
    case "refused":
      return "ending";
    default:
      return "priming"; // starting, waiting, committed
  }
}

/** The player's position at heard `time` into `out` (1:1, tick 0, no tempo before an anchored grid). Allocates nothing. */
function positionOf(p: MusicPlayer, time: number, out: { bar: number; beat: number; tick: number; tempo: number; beatsPerBar: number }): void {
  out.bar = 1;
  out.beat = 1;
  out.tick = 0;
  out.tempo = 0;
  out.beatsPerBar = 0;
  const a = p.anchor;
  const grid = a ? segmentGrid(a.node) : null;
  if (!a || !grid) return;
  const ticks = ticksAt(a, time);
  const pos = Number.isFinite(ticks) ? ticksToPosition(grid, ticks) : null;
  if (pos) {
    out.bar = pos.bar;
    out.beat = pos.beat;
    out.tick = pos.tick;
  }
  const i = spanAtTicks(grid, Number.isFinite(ticks) ? ticks : 0);
  out.tempo = grid.bpm[i]!;
  out.beatsPerBar = grid.beatsPerBar[i]!;
}

/** FNV-1a over an event's parameters (sorted by name), so a change shows between two keyframes. */
function paramsHash(parameters: Readonly<Record<string, number | string>>, keys: string[]): number {
  let h = 0x811c9dc5;
  keys.length = 0;
  for (const key in parameters) if (Object.prototype.hasOwnProperty.call(parameters, key)) keys.push(key);
  keys.sort();
  for (let n = 0; n < keys.length; n++) {
    const key = keys[n]!;
    const text = `${key}=${parameters[key]}`;
    for (let k = 0; k < text.length; k++) h = Math.imul(h ^ text.charCodeAt(k), 0x01000193);
  }
  return h >>> 0;
}

function positionText(grid: SegmentGrid, ticks: number): string {
  const pos = Number.isFinite(ticks) ? ticksToPosition(grid, ticks) : null;
  return pos ? `${pos.bar}:${pos.beat}` : "";
}

/** One `MusicDebugRow` of a player at heard `now`. Copies the counters, so a row is a snapshot. */
function musicDebugRow(p: MusicPlayer, now: number, view: MusicBackendDebug, music: Pick<MusicBackend, "primeEmaMs">): MusicDebugRow {
  const c = p.counters;
  const a = p.anchor;
  const pos = { bar: 1, beat: 1, tick: 0, tempo: 0, beatsPerBar: 0 };
  positionOf(p, now, pos);
  const grid = a ? segmentGrid(a.node) : null;
  const t = p.transition;
  const m = t?.match;
  const groupIds = new Set<number>();
  if (p.run && p.run.group) groupIds.add(p.run.group);
  if (p.next && p.next.group) groupIds.add(p.next.group);
  let ring = 0;
  return {
    id: p.instance.group,
    asset: p.instance.path,
    state: musicState(p.state),
    segment: p.run?.node.id ?? null,
    pass: a?.pass ?? 1,
    bar: pos.bar, beat: pos.beat, tick: pos.tick, tempo: pos.tempo, beatsPerBar: pos.beatsPerBar,
    time: now,
    // Past T - L (`running`, `bridging`) the change is still on its way until it lands, as `handle.music.transition` says.
    pending: t && m && t.state !== "done" && t.state !== "cancelled"
      ? { to: t.to.id, time: grid && Number.isFinite(t.exitAt) ? positionText(grid, ticksAt(a!, t.exitAt)) : "", rule: m.rule, ruleKey: m.ruleKey, tier: m.tier, parent: m.parent, exit: m.exit, enter: m.enter }
      : null,
    groups: view.groups.filter((g) => groupIds.has(g.id)).map((g) => ({ id: g.id, state: g.state, primed: g.primed, of: g.of })),
    // The pool index of a stem's ring isn't kept by main (the core allocates it); streamed stems number in order.
    stems: (p.run?.stems ?? []).map((s) => ({ name: s.track, primed: s.primed, streamed: s.streamed, ring: s.streamed ? ring++ : null })),
    primeLastMs: c.primeLastMs,
    primeEmaMs: music.primeEmaMs,
    leadMs: c.leadMs,
    replans: { ...c.replans },
    refusals: { ...c.refusals },
    lateGroups: c.lateGroups,
    groupsHeld: c.groupsHeld,
    groupTimeouts: c.groupTimeouts,
    lastSlipFrames: c.lastSlipFrames,
    recoveries: { ...c.recoveries },
    missedBeats: c.missedBeats,
    stingers: { ...c.stingers },
  };
}

/** `musicTotals`: the music backend's own figures, then main's counters summed over the session (ADR 0220). */
function musicTotals(view: MusicBackendDebug): MusicDebugTotals {
  const { groups: _groups, ...own } = view;
  return { ...own, ...musicCounterTotals() };
}
