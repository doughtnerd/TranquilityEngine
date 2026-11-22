// The rows above the audio backend seam (ADR 0249): `Audio.debug()` and the capture's KEYFRAME get their event section
// here, once, from the playlist runtime's instances, whichever backend plays. A backend reports only what it owns: voices,
// buses, meters and the mix section, how many of its voices each instance has, and its music backend's own view
// (`MusicBackend.debugView`: the ring pool, the live groups, its group counters). Neither backend imports `playlists/` for
// rows.
//
// - **Debug** (`debugRows`): `events` (the playlist runtime's rows, keeping an instance while the backend still lists one of
//   its voices, E3.9), `eventTotals` and `playlistTotals`; `music`, one row per playing playlist instance with a tempo
//   (`playlists/musicRows.ts`: ADR 0166's music players, which first had these rows, were retired by ADR 0329), and on a
//   backend with music `musicTotals` (the music backend's own view and the playlists' stinger outcomes). Fresh objects
//   per call; debug only.
// - **Keyframe** (`KeyframeRows`): the backend's keyframe with the `events` section added (§5.5) and an empty `music`
//   section. Every row is pooled and rewritten in place, as the recorder asks of its sources (FU5); what still allocates is
//   the strings an instance's parameter values hash through.
//
// The capture's row layout (caps, state codes, quantising) is `capture/keyframeLayout.ts` (ADR 0230); this module imports
// the keyframe types only from the lazy `capture/format.ts` chunk.
import type { AudioBackend, AudioCaptureSource, AudioDebugInfo, MusicBackend, MusicBackendDebug, MusicDebugRow, MusicDebugTotals } from "./backend";
import type { KeyframeEvent, KeyframeMusic, KeyframePayload } from "./capture/format";
import { KEYFRAME_MAX_EVENTS } from "./capture/keyframeLayout";
import { playlistsIfStarted, type EventDebugRow, type PlaylistTotals } from "./playlists/playlistSystem";

const NO_ROWS: readonly EventDebugRow[] = Object.freeze([]);

/** What the composer adds to a backend's `AudioDebugInfo` for `Audio.debug()`. */
export interface AudioDebugRows {
  /** The playlist runtime's instances (ADR 0329: `asset` is the playlist path). */
  events: EventDebugRow[];
  eventTotals: { lateStarts: number };
  /** ADR 0329: the playlist runtime's refused triggers (by reason, and the latest), steals and late starts; present once a playlist was played. */
  playlistTotals?: PlaylistTotals;
  /**
   * The playlist instances with a musical clock (a tempo), as ADR 0166's music rows; present on a backend with music
   * (`AudioBackend.music`) or when a row exists.
   */
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
  const pl = playlistsIfStarted();
  const out: AudioDebugRows = { events: pl ? pl.debugRows(listed) : [], eventTotals: { lateStarts: 0 } };
  if (pl) {
    out.playlistTotals = pl.totals();
    out.eventTotals.lateStarts = out.playlistTotals.lateStarts;
  }
  const rows = pl ? pl.musicRows() : [];
  const music = backend.music;
  if (music || rows.length > 0) out.music = rows;
  if (music) out.musicTotals = musicTotals(music.debugView(), pl?.stingerOutcomes());
  return out;
}

/** The capture's keyframe source over one backend's: adds the event section (and an empty music one) into pooled rows. */
export class KeyframeRows {
  private readonly eventsPool: KeyframeEvent[] = [];
  private readonly eventsOut: KeyframeEvent[] = [];
  private readonly musicOut: KeyframeMusic[] = [];
  /** The playlist runtime's pooled debug rows, refilled per keyframe. */
  private readonly playlistOut: EventDebugRow[] = [];
  /** The parameter names `paramsHash` sorts in place. */
  private readonly keys: string[] = [];
  private readonly payload: { -readonly [K in keyof KeyframePayload]: KeyframePayload[K] } = {
    voices: [], buses: [], metered: [], events: this.eventsOut, music: this.musicOut,
    mix: { slotTableVersion: 0, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 },
  };

  constructor(private readonly source: AudioCaptureSource, _backend: Pick<AudioBackend, "time">) {}

  /** The payload at this instant (the object and its rows are reused by the next call). `noName` is the id for none. */
  read(nameId: (table: "clips" | "snapshots" | "events", name: string) => number, noName: number): KeyframePayload {
    const k = this.source.keyframe(nameId, noName);
    const p = this.payload;
    p.voices = k.voices;
    p.buses = k.buses;
    p.metered = k.metered;
    p.mix = k.mix;
    this.readEvents(k.eventVoices, nameId);
    return p;
  }

  private readEvents(listed: ReadonlyMap<number, number>, nameId: (table: "events", name: string) => number): void {
    const out = this.eventsOut;
    out.length = 0;
    // Pooled: the playlist runtime refills `playlistOut` with its own reused row objects (nothing built per keyframe).
    const rows = playlistsIfStarted()?.debugRows(listed, this.playlistOut) ?? NO_ROWS;
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
}

// --- Shared ----------------------------------------------------------------------------------------------------------

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

/**
 * `musicTotals`: the music backend's own figures, and the playlists' stinger outcomes over the session (ADR 0220's sums;
 * re-plans, refusals and recoveries were the music players' and stay empty since they went, ADR 0329).
 */
function musicTotals(view: MusicBackendDebug, stingers: MusicDebugTotals["stingers"] | undefined): MusicDebugTotals {
  const { groups: _groups, ...own } = view;
  return { ...own, replans: {}, refusals: {}, recoveries: {}, stingers: stingers ?? { played: 0, late: 0, skipped: 0, dropped: 0 } };
}
