// The Profiler's timeline (ADR 0348 "The Profiler screen"; the prototype's tracks): a ruler with the capture's markers
// and every warning and error, then the tracks `planTracks` chose, in its order: Picture (a take's pictures, the kit's filmstrip;
// none for a capture), Load (voices and CPU against the voice cap), Effects cost (the estimated DSP share per section, one line
// each), Memory (the clip arena and the loaded packages, with package marks; ADR 0351 §6), a Bus track per bus (its
// effective gain, with the lane
// breakdown floating at the cursor), Loudness (short-term against the target), the voice lanes (by bus or by clip, with
// status colours; a click selects a voice and seeks to its start) and the game parameters. Clicking a track seeks;
// pressing and dragging on the ruler scrubs (a pointer drag, so it works by touch too). The
// capture fits the width until zoomed (Ctrl/⌘ + wheel or pinch zooms at the pointer, Shift + wheel or a sideways swipe scrolls, the strip
// under the tracks zooms and scrolls; every plot is drawn over the whole capture and slid and stretched to the view); lines are drawn in a fixed SVG box stretched to the track (`timelineGeometry.ts`).
// The ruler is the run screens' (`RunRuler`: the playhead readout, second labels, the triangle) with the problem marks on
// it; bus tracks that never move are folded into one "+ N unchanged buses" row; the Effects track counts instances by
// level (spec §4.6.3). A view over props: the panel feeds it the store's signals, a story its own.
import { createContext, Fragment, type ComponentChildren, type JSX } from "preact";
import { useContext, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { heatByKey, heatText, type Heat } from "../../components/heatmapModel";
import { RunPlayhead, RunRuler } from "../run/RunRuler";
import { Filmstrip } from "../../components/Filmstrip";
import type { TimeSpan } from "../../components/timeRulerModel";
import { TimelineZoomStrip } from "../../components/TimelineZoomStrip";
import { useElementWidth } from "../../components/useElementWidth";
import { useTimelineView } from "../../components/useTimelineView";
import { recordingView } from "../../components/recordingView";
import { formatDb } from "../../../plugins/audio/editor/dbScale";
import { breakdownText, type BusReadout } from "./cursorReadout";
import { EFFECT_SECTIONS, effectsCostText } from "./effectsCostModel";
import { memoryText } from "./memoryModel";
import { formatBytes } from "../../encoding/estimate";
import type { RulerMark } from "./messagesModel";
import type { ProfilerData } from "./profilerData";
import { BOX_H, BOX_W, clockText, extent, linePath, maxOf, pct, stepPath, valueAt, yOf } from "./timelineGeometry";
import type { PlannedTrack } from "./trackPlan";
import { dimmed, STATUS_TEXT, voiceLanes, voiceSummary, type GroupBy, type VoiceBlock } from "./voiceModel";
import { generatorBadge } from "../playlists/generator/generatorKinds";
import { GeneratorBadge } from "../playlists/generator/GeneratorParts";

export interface ProfilerTimelineProps {
  readonly data: ProfilerData;
  /** The cursor, viewport seconds. */
  readonly cursor: number;
  readonly readouts: readonly BusReadout[];
  readonly selected: string | null;
  readonly problemsOnly: boolean;
  readonly groupBy: GroupBy;
  /** Experimental: colour each voice by how often its sound played in the capture. */
  readonly heatmap?: boolean;
  /** Buses running an effect chain in the project's mix (the Effects track's Bus chip). */
  readonly busChains?: number;
  /** The recording's path when it may also be open on the Take screen: both timelines then show the same seconds. */
  readonly viewKey?: string | null;
  onSeek(t: number): void;
  /** A voice block clicked (seek to its start too). */
  onSelect(key: string): void;
}

/** dB range of a bus track. */
const BUS_MIN_DB = -48;
const BUS_MAX_DB = 6;
/** LUFS range of the loudness track. */
const LUFS_MIN = -60;
const LUFS_MAX = 0;
/** Height of one voice row, px (a 24px block inset 5px, the prototype's 34px lanes). */
const ROW_PX = 34;

/** The seconds the plots show: the timeline's zoom, or (outside it, in a story) the whole capture. */
const ViewContext = createContext<TimeSpan | null>(null);
const useView = (duration: number): TimeSpan => useContext(ViewContext) ?? { start: 0, end: Math.max(0.001, duration) };

/** Where `t` sits across a plot showing `view`, in percent. */
const viewPct = (t: number, view: TimeSpan): number => ((t - view.start) / Math.max(1e-9, view.end - view.start)) * 100;

/** The time under a pointer event on a plot element showing `view`. */
function timeAt(e: MouseEvent, view: TimeSpan): number {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  return r.width > 0 ? view.start + Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * (view.end - view.start) : 0;
}

function Lines(props: { paths: readonly { d: string; cls: string }[]; height: number; children?: ComponentChildren }) {
  return (
    <svg class="pf-lines" viewBox={`0 0 ${BOX_W} ${BOX_H}`} preserveAspectRatio="none" style={{ height: `${props.height}px` }} aria-hidden="true">
      {props.paths.map((p, i) => (p.d ? <path key={i} d={p.d} class={p.cls} vector-effect="non-scaling-stroke" /> : null))}
      {props.children}
    </svg>
  );
}

function refLine(y: number, cls: string): JSX.Element {
  return <line x1={0} x2={BOX_W} y1={y} y2={y} class={cls} vector-effect="non-scaling-stroke" />;
}

interface TrackRowProps {
  readonly track: PlannedTrack;
  readonly value?: string | null;
  readonly duration: number;
  readonly height?: number;
  onSeek(t: number): void;
  /** Drawn over the whole capture, slid and stretched with the zoom (lines, voice blocks, marks at a time). */
  readonly children?: ComponentChildren;
  /** Drawn over the plot as it is, whatever the zoom (legends, labels, the cursor's float, the pictures). */
  readonly overlay?: ComponentChildren;
}

function TrackRow(props: TrackRowProps) {
  const view = useView(props.duration);
  const span = Math.max(1e-9, view.end - view.start);
  return (
    <div class={`pf-track pf-track-${props.track.kind}`} data-track={props.track.id} role="group" aria-label={props.track.label}>
      <div class="pf-track-head">
        <span class="pf-track-label">{props.track.label}</span>
        {props.value && <span class="pf-track-value">{props.value}</span>}
      </div>
      <div class="pf-plot" style={props.height ? { height: `${props.height}px` } : undefined} onClick={(e) => props.onSeek(timeAt(e, view))}>
        {props.height ? (
          <div class="pf-clip">
            <div class="pf-zoom" style={{ left: `${-(view.start / span) * 100}%`, width: `${(Math.max(0.001, props.duration) / span) * 100}%` }}>
              {props.children}
            </div>
          </div>
        ) : (
          props.children
        )}
        {props.overlay}
      </div>
    </div>
  );
}

/** ADR 0348: a take's pictures of the game view, as the kit's filmstrip across the track's width. */
function PictureTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const view = useView(data.duration);
  const toX = (t: number) => (data.duration > 0 ? ((t - view.start) / (view.end - view.start)) * width : 0);
  const n = data.frames.length;
  return (
    <TrackRow
      track={track}
      value={n === 1 ? "1 picture" : `${n} pictures`}
      duration={data.duration}
      onSeek={onSeek}
      height={40}
      overlay={
        <div ref={ref} class="pf-picture">
          {width > 0 && <Filmstrip frames={data.frames} toX={toX} time={cursor} thumbWidth={56} onSeek={onSeek} />}
        </div>
      }
    />
  );
}

function LoadTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const load = data.load!;
  const top = Math.max(1, maxOf(load.cap.values), maxOf(load.voices.values)) * 1.15;
  const cap = valueAt(load.cap, cursor);
  const voices = valueAt(load.voices, cursor);
  const capNow = valueAt(load.cap, data.duration) ?? 0;
  const cpuNow = load.cpu.map((l) => valueAt(l, cursor)).find((v) => v !== null && Number.isFinite(v));
  const value = `${voices ?? 0} voices · max ${cap ?? "?"}${cpuNow != null ? ` · CPU ${Math.round(cpuNow)}‰` : ""}`;
  return (
    <TrackRow
      track={track}
      value={value}
      duration={data.duration}
      onSeek={onSeek}
      height={56}
      overlay={
        <>
          <span class="pf-limit" title="The most voices the engine mixes at once (mixedCap): the project's Mixed voices setting, lowered while the audio thread is overloaded. Past it voices are stolen or refused. A bus's voice limit in the Mixer is separate: None there leaves only this ceiling">mixed voices max {capNow}</span>
          <span class="pf-legend" aria-hidden="true">
            <span class="pf-key pf-key-voices">voices</span>
            {load.cpu.length > 0 && <span class="pf-key pf-key-cpu">CPU</span>}
          </span>
        </>
      }
    >
      <Lines
        height={56}
        paths={[
          ...load.cpu.map((l) => ({ d: linePath(l, data.duration, 0, l.yMax ?? Math.max(1000, maxOf(l.values))), cls: "pf-line pf-cpu" })),
          { d: stepPath(load.cap, data.duration, 0, top), cls: "pf-line pf-cap" },
          { d: linePath(load.voices, data.duration, 0, top), cls: "pf-line pf-voices" },
        ]}
      />
    </TrackRow>
  );
}

/** Spec §4.6.3: effect instances by level at the cursor, as chips, and their total over time. */
function FxTrack({ data, track, cursor, busChains, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; busChains: number; onSeek(t: number): void }) {
  const fx = data.fxInstances!;
  const clips = fx.clips ? (valueAt(fx.clips, cursor) ?? 0) : null;
  const playlists = fx.playlists ? (valueAt(fx.playlists, cursor) ?? 0) : null;
  const total = fx.clips ?? fx.playlists!;
  const top = Math.max(1, maxOf(total.values) + busChains) * 1.15;
  const shifted = { times: total.times, values: Float64Array.from(total.values as ArrayLike<number>, (v, i) => v + busChains + (fx.clips && fx.playlists ? (valueAt(fx.playlists, total.times[i]!) ?? 0) : 0)) };
  return (
    <TrackRow track={track} value="instances by level" duration={data.duration} onSeek={onSeek} height={44} overlay={
      <span class="pf-chips">
        <span class="pf-chip-n" title="Rendered into the audio offline: no instances at runtime">Sample baked · 0</span>
        {clips !== null && <span class="pf-chip-n" title={`Per voice: ${clips} voice${clips === 1 ? "" : "s"} running a clip chain`}>Clip {clips}</span>}
        {playlists !== null && <span class="pf-chip-n" title={`One per playing playlist or sequence track (${playlists} playing)`}>Playlist / track {playlists}</span>}
        <span class="pf-chip-n" title="One per bus chain, always running (the project's mix now)">Bus {busChains}</span>
      </span>
    }>
      <Lines height={44} paths={[{ d: stepPath(shifted, data.duration, 0, top), cls: "pf-line pf-fxi" }]} />
    </TrackRow>
  );
}

function EffectsTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const cost = data.effects!;
  return (
    <TrackRow track={track} value={effectsCostText(cost, cursor)} duration={data.duration} onSeek={onSeek} height={48} overlay={
      <span class="pf-fx-legend" title="Estimated from the CPU meter's work per section, in permille of an audio quantum; the core doesn't report each effect's cost yet">
        {cost.lanes.map((l) => (
          <span key={l.key} class={`pf-fx-key pf-fx-${l.key}`} title={EFFECT_SECTIONS[l.key].holds}>
            {l.label}
          </span>
        ))}
      </span>
    }>
      <Lines height={48} paths={cost.lanes.map((l) => ({ d: linePath(l, data.duration, 0, cost.peak), cls: `pf-line pf-fx pf-fx-${l.key}` }))} />
    </TrackRow>
  );
}

/** ADR 0351 §6: the clip arena and the loaded packages' memory, on one scale, with a mark at each package load and unload. */
function MemoryTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const m = data.memory!;
  const top = Math.max(1, m.peakArena, m.peakPackages) * 1.15;
  return (
    <TrackRow
      track={track}
      value={memoryText(m, cursor, formatBytes)}
      duration={data.duration}
      onSeek={onSeek}
      height={48}
      overlay={
        <span class="pf-ref-label" title={m.unknownPackages.length ? `This capture doesn't say what ${m.unknownPackages.join(", ")} held` : undefined}>
          peak arena {formatBytes(m.peakArena)}
          {m.packages.times.length ? ` · packages ${formatBytes(m.peakPackages)}` : ""}
        </span>
      }
    >
      <Lines
        height={48}
        paths={[
          { d: stepPath(m.packages, data.duration, 0, top), cls: "pf-line pf-mem-packages" },
          { d: linePath(m.arena, data.duration, 0, top), cls: "pf-line pf-mem-arena" },
        ]}
      />
      {m.marks.map((k, i) => (
        <span key={i} class={`pf-mem-mark ${k.kind}`} style={{ left: `${pct(k.time, data.duration)}%` }} role="note" aria-label={`${k.text} at ${clockText(k.time)}`} title={`${k.text} · ${clockText(k.time)}`} />
      ))}
    </TrackRow>
  );
}

function BusTrack({ data, track, slot, readout, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; slot: number; readout: BusReadout | undefined; cursor: number; onSeek(t: number): void }) {
  const line = data.buses.get(slot)!;
  const now = valueAt(line, cursor);
  const view = useView(data.duration);
  const at = viewPct(cursor, view);
  const float = readout && (readout.lanes.length > 0 || readout.muted) && at >= 0 && at <= 100;
  return (
    <TrackRow track={track} value={now === null ? "effective gain" : `${formatDb(now)} · effective gain`} duration={data.duration} onSeek={onSeek} height={40} overlay={
      float && (
        <span class={`pf-float${at > 70 ? " left" : ""}`} style={{ left: `${at}%` }} role="note" aria-label={breakdownText(readout)}>
          <strong>
            {readout.name} {formatDb(readout.db)}
          </strong>
          <span>authored {formatDb(readout.authoredDb).replace(" dB", "")}</span>
          {readout.lanes.map((l) => (
            <span key={l.lane}>
              {l.lane} {formatDb(l.db).replace(" dB", "")} ({l.reason})
            </span>
          ))}
        </span>
      )
    }>
      <Lines height={40} paths={[{ d: stepPath(line, data.duration, BUS_MIN_DB, BUS_MAX_DB), cls: "pf-line pf-bus" }]}>
        {refLine(yOf(0, BUS_MIN_DB, BUS_MAX_DB), "pf-ref pf-zero")}
      </Lines>
    </TrackRow>
  );
}

function LoudnessTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const l = data.loudness!;
  const now = valueAt(l.shortTerm, cursor);
  const value = `${l.name} ${now === null ? "—" : `${now.toFixed(1)} LUFS`}${l.target !== null ? ` · target ${l.target}` : ""}`;
  return (
    <TrackRow track={track} value={value} duration={data.duration} onSeek={onSeek} height={44} overlay={l.target !== null ? <span class="pf-ref-label">target {l.target}</span> : <span />}>
      <Lines height={44} paths={[{ d: linePath(l.shortTerm, data.duration, LUFS_MIN, LUFS_MAX), cls: "pf-line pf-loud" }]}>
        {l.target !== null ? refLine(yOf(l.target, LUFS_MIN, LUFS_MAX), "pf-ref pf-target") : null}
      </Lines>
    </TrackRow>
  );
}

function ParameterTrack({ data, track, name, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; name: string; cursor: number; onSeek(t: number): void }) {
  const line = data.parameters.get(name)!;
  const { min, max } = extent(line.values);
  const now = valueAt(line, cursor);
  return (
    <TrackRow track={track} value={now === null ? "—" : String(Math.round(now * 100) / 100)} duration={data.duration} onSeek={onSeek} height={30}>
      <Lines height={30} paths={[{ d: stepPath(line, data.duration, min, max), cls: "pf-line pf-param" }]} />
    </TrackRow>
  );
}

/** The sound a voice played, for the heatmap's count: its generator kind and clip. */
const soundOf = (b: VoiceBlock): string => `${b.generator ?? ""}:${b.clip}`;

function VoiceButton({ block, duration, row, selected, dim, heat, onSelect }: { block: VoiceBlock; duration: number; row: number; selected: boolean; dim: boolean; heat: Heat | null; onSelect(key: string): void }) {
  const left = pct(block.start, duration);
  const width = Math.max(0, pct(block.end, duration) - left);
  const label = `${block.generator ? `${generatorBadge(block.generator).name} ` : ""}${block.clipName}: ${STATUS_TEXT[block.status]}, ${clockText(block.start)}${block.end > block.start ? ` to ${clockText(block.end)}` : ""}`;
  return (
    <button
      type="button"
      class={`pf-voice${heat ? " heat" : ""}${selected ? " selected" : ""}${dim ? " dim" : ""}${block.end <= block.start ? " instant" : ""}`}
      data-status={block.status}
      data-voice={block.key}
      style={{ left: `${left}%`, width: `${width}%`, top: `${row * ROW_PX + 5}px`, ...(heat ? { "--heat": heat.heat } : {}) }}
      aria-pressed={selected}
      aria-label={label}
      title={`${voiceSummary(block)}${heat ? ` · ${heatText(heat)}` : ""} · ${clockText(block.start)}`}
      onClick={(e) => {
        e.stopPropagation();
        onSelect(block.key);
      }}
    >
      {block.generator && <GeneratorBadge kind={block.generator} />}
      {block.clipName}
    </button>
  );
}

function VoiceLanes(props: { data: ProfilerData; track: PlannedTrack; selected: string | null; problemsOnly: boolean; groupBy: GroupBy; heatmap?: boolean; onSeek(t: number): void; onSelect(key: string): void }) {
  const { data } = props;
  const heats = useMemo(() => (props.heatmap ? heatByKey(data.voices.map(soundOf)) : null), [props.heatmap, data.voices]);
  const lanes = voiceLanes(data.voices, props.groupBy, props.problemsOnly);
  if (lanes.length === 0) {
    return (
      <TrackRow track={props.track} duration={data.duration} onSeek={props.onSeek} value="no problems">
        <p class="pf-lane-empty">No voice had a problem in this capture.</p>
      </TrackRow>
    );
  }
  return (
    <>
      {lanes.map((lane) => (
        <TrackRow key={lane.key} track={{ ...props.track, label: lane.label }} value={lane.problems > 0 ? `${lane.problems} problem${lane.problems === 1 ? "" : "s"}` : null} duration={data.duration} onSeek={props.onSeek} height={lane.rowCount * ROW_PX}>
          {lane.blocks.map((b, i) => (
            <VoiceButton key={b.key} block={b} duration={data.duration} row={lane.rows[i]!} selected={b.key === props.selected} dim={dimmed(b, props.problemsOnly)} heat={heats?.get(soundOf(b)) ?? null} onSelect={props.onSelect} />
          ))}
        </TrackRow>
      ))}
    </>
  );
}

function Ruler({ data, cursor, onSeek, onSelect }: { data: ProfilerData; cursor: number; onSeek(t: number): void; onSelect(key: string): void }) {
  const view = useView(data.duration);
  const markAt = (m: RulerMark) => () => (m.voice ? onSelect(m.voice) : onSeek(m.time));
  return (
    <RunRuler duration={data.duration} view={view} time={cursor} label="Capture time" onSeek={(t) => onSeek(t)}>
      {data.marks.filter((m) => m.time >= view.start && m.time <= view.end).map((m, i) => (
        <button
          key={i}
          type="button"
          class="pf-mark"
          data-kind={m.kind}
          style={{ left: `${viewPct(m.time, view)}%` }}
          title={`${clockText(m.time)} ${m.text}`}
          aria-label={`${m.kind === "info" ? "Marker" : m.kind === "error" ? "Error" : "Warning"} at ${clockText(m.time)}: ${m.text}`}
          onClick={(e) => {
            e.stopPropagation();
            markAt(m)();
          }}
        />
      ))}
    </RunRuler>
  );
}

/** A bus that never moves off one level (a step line within 0.05 dB) is left out until asked for. */
function busMoves(data: ProfilerData, slot: number, readout: BusReadout | undefined): boolean {
  const line = data.buses.get(slot);
  if (!line || line.values.length === 0) return false;
  let lo = Infinity, hi = -Infinity;
  for (let i = 0; i < line.values.length; i++) {
    lo = Math.min(lo, line.values[i]!);
    hi = Math.max(hi, line.values[i]!);
  }
  return hi - lo > 0.05 || (readout?.lanes.length ?? 0) > 0;
}

export function ProfilerTimeline(props: ProfilerTimelineProps) {
  const { data, cursor } = props;
  const [allBuses, setAllBuses] = useState(false);
  const readout = (slot: number) => props.readouts.find((r) => r.slot === slot);
  const busTracks = data.tracks.filter((t): t is Extract<PlannedTrack, { kind: "bus" }> => t.kind === "bus");
  const quiet = busTracks.filter((t) => !busMoves(data, t.slot, readout(t.slot)));
  const hidden = allBuses ? new Set<string>() : new Set(quiet.map((t) => t.id));
  const lastBus = busTracks[busTracks.length - 1]?.id;
  // The view: the whole capture until zoomed. A cursor moved out of it (a voice picked, a seek from elsewhere) pages the view.
  const zoom = useTimelineView(data.duration, props.viewKey ? recordingView(props.viewKey) : undefined);
  useEffect(() => {
    zoom.follow(cursor);
  }, [cursor]);
  const onWheel = (e: WheelEvent) => {
    const lane = (e.currentTarget as HTMLElement).querySelector(".run-ruler")?.getBoundingClientRect();
    if (!lane || lane.width <= 0) return;
    const x = Math.min(Math.max(e.clientX - lane.left, 0), lane.width);
    const at = zoom.view.start + (x / lane.width) * (zoom.view.end - zoom.view.start);
    if (zoom.wheel(e, at, lane.width)) e.preventDefault();
  };
  return (
    <ViewContext.Provider value={zoom.view}>
    <div class="pf-timeline" role="region" aria-label="Capture timeline" onWheel={onWheel}>
      <Ruler data={data} cursor={cursor} onSeek={props.onSeek} onSelect={props.onSelect} />
      <div class="pf-tracks">
        {data.tracks.map((track) => {
          switch (track.kind) {
            case "picture":
              return <PictureTrack key={track.id} data={data} track={track} cursor={cursor} onSeek={props.onSeek} />;
            case "load":
              return <LoadTrack key={track.id} data={data} track={track} cursor={cursor} onSeek={props.onSeek} />;
            case "effects":
              return <EffectsTrack key={track.id} data={data} track={track} cursor={cursor} onSeek={props.onSeek} />;
            case "memory":
              return <MemoryTrack key={track.id} data={data} track={track} cursor={cursor} onSeek={props.onSeek} />;
            case "fx":
              return <FxTrack key={track.id} data={data} track={track} cursor={cursor} busChains={props.busChains ?? 0} onSeek={props.onSeek} />;
            case "bus":
              return (
                <Fragment key={track.id}>
                  {!hidden.has(track.id) && <BusTrack data={data} track={track} slot={track.slot} readout={readout(track.slot)} cursor={cursor} onSeek={props.onSeek} />}
                  {track.id === lastBus && quiet.length > 0 && (
                    <div class="pf-track pf-more-buses">
                      <div class="pf-track-head">
                        <button type="button" class="link" aria-expanded={allBuses} onClick={() => setAllBuses(!allBuses)}>
                          {allBuses ? `Hide ${quiet.length} unchanged bus${quiet.length === 1 ? "" : "es"}` : `+ ${quiet.length} unchanged bus${quiet.length === 1 ? "" : "es"}`}
                        </button>
                      </div>
                      <div class="pf-plot pf-plot-empty" title={quiet.map((t) => t.label.replace("Bus · ", "")).join(", ")} />
                    </div>
                  )}
                </Fragment>
              );
            case "loudness":
              return <LoudnessTrack key={track.id} data={data} track={track} cursor={cursor} onSeek={props.onSeek} />;
            case "voices":
              return <VoiceLanes key={track.id} data={data} track={track} selected={props.selected} problemsOnly={props.problemsOnly} groupBy={props.groupBy} heatmap={props.heatmap} onSeek={props.onSeek} onSelect={props.onSelect} />;
            case "parameter":
              return <ParameterTrack key={track.id} data={data} track={track} name={track.name} cursor={cursor} onSeek={props.onSeek} />;
          }
        })}
        <div class="pf-cursor-layer" aria-hidden="true">
          <RunPlayhead time={cursor} duration={data.duration} view={zoom.view} />
        </div>
      </div>
      <TimelineZoomStrip timeline={zoom} anchor={cursor} />
    </div>
    </ViewContext.Provider>
  );
}
