// Everything the Profiler screen draws, read from one open capture (ADR 0334 "The Profiler screen" on the existing
// reader, Worker, track kit (0261) and loudness client): the STATUS feed through the track kit (voices and the voice cap,
// the cursor's step and jump columns, the CPU tracks' columns through the editor's `cpuTracks`), the bus gain samples
// through `BusSampler`, the loudness series and the marks against the target through `LoudnessSource`, and the typed
// voice, parameter, snapshot and music events after a record cursor (ADR 0227). `refresh()` reads what the source gained
// since the last one (a live capture grows) and answers a new `ProfilerData`; the models (`voiceModel`, `messagesModel`,
// `trackPlan`, `cursorKeys`) shape it. No DOM.
import { CURSOR_COLUMNS, type CursorTargets } from "../../../plugins/audio/editor/mix/cursorModel";
import { VOICE_COLUMNS, voiceSeries } from "../../../plugins/audio/editor/mix/cpuTrack";
import type { LineSeries } from "../../../plugins/audio/editor/mix/drawTimeline";
import { LoudnessSource, canAskLoudness } from "../../../plugins/audio/editor/mix/loudnessSource";
import type { ProfileSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { BusSampler, busGainLines } from "../../../plugins/audio/editor/mix/tracks/buses";
import { cpuTracks } from "../../../plugins/audio/editor/mix/tracks/cpu";
import { TrackKit } from "../../../plugins/audio/editor/mix/tracks/kit";
import type { TrackModule } from "../../../plugins/audio/editor/mix/tracks/types";
import { gainToDb } from "../../../plugins/audio/editor/dbScale";
import {
  CAPTURE_OUTPUT_SLOT, captureNames, type CaptureEventAt, type CaptureEventType, type CaptureLoudnessMark, type CaptureLoudnessTarget, type CaptureNames,
} from "../../../plugins/audio/runtime/capture/reader";
import { effectsCost, type EffectsCost } from "./effectsCostModel";
import { buildMessages, rulerMarks, type LoudnessWarning, type ProfilerMessage, type ProfilerNote, type RulerMark } from "./messagesModel";
import { profilerTargets } from "./cursorKeys";
import { planTracks, type CaptureContents, type PlannedTrack } from "./trackPlan";
import type { TakeFrame } from "../../../engine/audio/take/types";
import { VOICE_EVENT_TYPES, buildVoices, type InitialVoice, type VoiceBlock } from "./voiceModel";

/** A line on the viewport axis (seconds), values in the track's own units. */
export interface Series {
  readonly times: ArrayLike<number>;
  readonly values: ArrayLike<number>;
}

export interface LoadData {
  /** Voices mixed. */
  readonly voices: Series;
  /** The core's voice cap (`mixedCap`, the adaptive cap). */
  readonly cap: Series;
  /** The CPU load line(s), permille (the editor's CPU track, one series per level), or empty before it is measured. */
  readonly cpu: readonly LineSeries[];
}

export interface LoudnessData {
  readonly slot: number;
  readonly name: string;
  /** Short-term loudness, LUFS (gaps left out). */
  readonly shortTerm: Series;
  /** The target's integrated level, or null without a target. */
  readonly target: number | null;
}

export interface ProfilerData {
  readonly duration: number;
  readonly contents: CaptureContents;
  readonly tracks: readonly PlannedTrack[];
  readonly load: LoadData | null;
  /** DSP cost by section (where effects run), estimated from the CPU meter (`effectsCostModel.ts`); null before it is fitted. */
  readonly effects: EffectsCost | null;
  /** Each bus's effective gain, dB, by slot. */
  readonly buses: ReadonlyMap<number, Series>;
  readonly loudness: LoudnessData | null;
  readonly voices: readonly VoiceBlock[];
  /** Each changed game parameter's values, by name (a step line). */
  readonly parameters: ReadonlyMap<string, Series>;
  readonly messages: readonly ProfilerMessage[];
  readonly marks: readonly RulerMark[];
  readonly targets: CursorTargets;
  /** The loudness target in force (from the capture's META), or null. */
  readonly target: CaptureLoudnessTarget | null;
  /**
   * ADR 0334: a take's pictures of the game view (the Picture track), in time order; empty for a capture. Their times
   * are take seconds, which count from the recording's start as viewport time does.
   */
  readonly frames: readonly TakeFrame[];
}

/** The events the screen reads beside the voices. */
const OTHER_EVENT_TYPES: readonly CaptureEventType[] = ["parameter", "snapshot", "musicTransition"];

/** The capture's META `target` as a loudness target (the recorder writes the `audio.loudnessTargets` entry in force), or null. */
export function metaTarget(target: unknown): CaptureLoudnessTarget | null {
  if (target === null || typeof target !== "object") return null;
  const t = target as Record<string, unknown>;
  if (typeof t.integrated !== "number" || !Number.isFinite(t.integrated)) return null;
  const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
  return { ...(typeof t.name === "string" ? { name: t.name } : {}), integrated: t.integrated, tolerance: num(t.tolerance, 2), truePeak: num(t.truePeak, -1) };
}

/** A step line from changes: one point per change (the view holds each value until the next). */
function parameterSeries(events: readonly CaptureEventAt[], names: CaptureNames, origin: number): Map<string, Series> {
  const by = new Map<string, { t: number[]; v: number[] }>();
  for (const { seconds, event: e } of events) {
    if (e.type !== "parameter" || e.instance !== null) continue; // game (global) parameters only
    const name = names.parameter(e.name, seconds);
    const s = by.get(name) ?? (by.set(name, { t: [], v: [] }).get(name) as { t: number[]; v: number[] });
    s.t.push(seconds - origin);
    s.v.push(e.value);
  }
  return new Map([...by].map(([k, s]) => [k, { times: Float64Array.from(s.t), values: Float64Array.from(s.v) }]));
}

/** Music transitions and snapshots as notes. */
function notesOf(events: readonly CaptureEventAt[], names: CaptureNames, origin: number): ProfilerNote[] {
  const out: ProfilerNote[] = [];
  for (const { seconds, event: e } of events) {
    const time = seconds - origin;
    if (e.type === "musicTransition") out.push({ time, text: e.from === null ? `Music starts ${names.event(e.to, seconds)}` : `Music ${names.event(e.from, seconds)} → ${names.event(e.to, seconds)}` });
    else if (e.type === "snapshot") out.push({ time, text: e.name === null ? "Snapshot cleared" : `Snapshot ${names.snapshot(e.name, seconds)}` });
  }
  return out;
}

export interface ProfilerDataOptions {
  /** The loudness target to check against; default: the capture's META target. */
  readonly target?: CaptureLoudnessTarget | null;
}

/** The reads of one open capture; `refresh()` after it grew. */
export class ProfilerDataReader {
  private readonly kit: TrackKit;
  private readonly cpu: TrackModule | undefined;
  private readonly sections: TrackModule | undefined;
  private readonly sampler: BusSampler;
  private readonly loud: LoudnessSource | null;
  private readonly target: CaptureLoudnessTarget | null;
  private events: CaptureEventAt[] = [];
  private next = 0;
  private initial: InitialVoice[] | null = null;
  /** A take's pictures, read once (a file never grows; a live view has none). */
  private frames: readonly TakeFrame[] | null = null;
  private running: Promise<ProfilerData> | null = null;

  constructor(private readonly source: ProfileSource, opts: ProfilerDataOptions = {}) {
    this.kit = TrackKit.of(source);
    this.kit.status([...VOICE_COLUMNS, ...CURSOR_COLUMNS]);
    const cpu = cpuTracks({ source });
    this.cpu = cpu.find((m) => m.track.id === "cpu.load");
    this.sections = cpu.find((m) => m.track.id === "cpu.sections");
    this.sampler = new BusSampler(source);
    this.loud = canAskLoudness(source) ? new LoudnessSource(source) : null;
    this.target = opts.target !== undefined ? opts.target : metaTarget(source.summary.meta.target);
  }

  /** Reads what the source gained and answers the data (calls while one runs share it). */
  refresh(): Promise<ProfilerData> {
    this.running ??= this.read().finally(() => (this.running = null));
    return this.running;
  }

  private async read(): Promise<ProfilerData> {
    const src = this.source;
    const feed = this.kit.status();
    await Promise.all([this.kit.refresh(), this.cpu?.refresh(), this.sections?.refresh(), this.sampler.refresh()]);
    if (this.initial === null && feed.length > 0) {
      const s = await src.seek(src.startSeconds + feed.times[0]!);
      this.initial = (s.keyframe?.voices ?? []).filter((v) => v.state !== "stolen").map((v) => ({ voice: v.id, clip: v.clip, slot: v.slot, gain: v.gain }));
    }
    if (this.frames === null) this.frames = src.live || !src.frames ? [] : await src.frames();
    const page = await src.events(this.next, [...VOICE_EVENT_TYPES, ...OTHER_EVENT_TYPES]);
    this.next = page.next;
    this.events.push(...page.events);
    const names = captureNames(src.summary);
    const origin = src.startSeconds;
    const duration = src.duration;

    // loudness: the output's short-term (else the first metered bus) and the marks against the target
    let loudness: LoudnessData | null = null;
    let warnings: LoudnessWarning[] = [];
    if (this.loud) {
      try {
        const info = await this.loud.info();
        const metered = info.buses.filter((b) => b.samples > 0);
        const pick = metered.find((b) => b.slot === CAPTURE_OUTPUT_SLOT) ?? metered[0];
        if (pick) {
          const s = await this.loud.series(pick.slot);
          const t: number[] = [];
          const v: number[] = [];
          for (let i = 0; i < s.columns.time.length; i++) {
            const x = s.columns.shortTerm[i]!;
            if (!Number.isFinite(x)) continue;
            t.push(s.columns.time[i]!);
            v.push(x);
          }
          loudness = { slot: pick.slot, name: names.bus(pick.slot), shortTerm: { times: Float64Array.from(t), values: Float64Array.from(v) }, target: this.target?.integrated ?? null };
        }
        const marks: CaptureLoudnessMark[] = this.target && metered.length ? await this.loud.marks(this.target) : [];
        warnings = marks.map((m) => ({ busName: names.bus(m.bus, origin + m.from), kind: m.kind, metric: m.metric, from: m.from, to: m.to }));
      } catch {
        loudness = null; // a capture the Worker can't meter: no loudness track
      }
    }

    const voiceEvents = this.events.filter((e) => (VOICE_EVENT_TYPES as readonly string[]).includes(e.event.type));
    const voices = buildVoices(voiceEvents, names, { start: origin, duration, initial: this.initial ?? [] });
    const parameters = parameterSeries(this.events, names, origin);
    const buses = new Map<number, { times: Float64Array; values: Float64Array }>();
    for (const line of busGainLines(this.sampler.samples)) buses.set(line.slot, { times: line.times, values: Float64Array.from(line.values, (g) => Math.max(-96, gainToDb(g))) });

    const vs = feed.length ? voiceSeries(feed.columns()) : null;
    const cpuLines = this.cpu?.data()?.lines ?? [];
    const load: LoadData | null = vs ? { voices: { times: vs.times, values: vs.mixed }, cap: { times: vs.times, values: vs.cap }, cpu: cpuLines } : null;
    const effects = effectsCost(this.sections?.data()?.lines);

    const contents: CaptureContents = {
      frames: this.frames.length > 0,
      status: feed.length > 0 && !src.summary.mainSideOnly,
      cpu: cpuLines.length > 0,
      effects: effects !== null,
      buses: [...buses.keys()].sort((a, b) => a - b).map((slot) => ({ slot, name: names.bus(slot) })),
      loudness: loudness !== null && loudness.shortTerm.times.length > 0,
      voices: voices.length > 0,
      parameters: [...parameters.keys()],
    };
    const markers = src.markers.map((m) => ({ time: m.seconds - origin, text: m.text }));
    const messages = buildMessages({ voices, loudness: warnings, markers, notes: notesOf(this.events, names, origin), truncated: src.truncated });
    const marks = rulerMarks(messages);
    const cursorCols = feed.length ? feed.columns() : emptyCursorColumns();
    return {
      duration, contents, tracks: planTracks(contents), load, effects, buses, loudness, voices, parameters, messages, marks,
      targets: profilerTargets(cursorCols, src.markers, origin, marks), target: this.target, frames: this.frames,
    };
  }
}

function emptyCursorColumns(): Record<string, Float64Array> {
  const out: Record<string, Float64Array> = { seconds: new Float64Array(0) };
  for (const c of CURSOR_COLUMNS) out[c] = new Float64Array(0);
  return out;
}
