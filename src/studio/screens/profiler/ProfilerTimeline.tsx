// The Profiler's timeline (ADR 0348 "The Profiler screen"; the prototype's tracks): a ruler with the capture's markers
// and every warning and error, then the tracks `planTracks` chose, in its order: Picture (a take's pictures, the kit's filmstrip;
// none for a capture), Load (voices and CPU against the voice cap), Effects cost (the estimated DSP share per section, one line
// each), Memory (the clip arena and the loaded packages, with package marks; ADR 0351 §6), a Bus track per bus (its
// effective gain, with the lane
// breakdown floating at the cursor), Loudness (short-term against the target), the voice lanes (by bus or by clip, with
// status colours; a click selects a voice and seeks to its start) and the game parameters. Clicking a track seeks. The
// whole capture fits the width; lines are drawn in a fixed SVG box stretched to the track (`timelineGeometry.ts`).
// A view over props: the panel feeds it the store's signals, a story its own.
import type { ComponentChildren, JSX } from "preact";
import { useRef } from "preact/hooks";
import { Filmstrip } from "../../components/Filmstrip";
import { useElementWidth } from "../../components/useElementWidth";
import { formatDb } from "../../../plugins/audio/editor/dbScale";
import { breakdownText, type BusReadout } from "./cursorReadout";
import { EFFECT_SECTIONS, effectsCostText } from "./effectsCostModel";
import { memoryText } from "./memoryModel";
import { formatBytes } from "../../encoding/estimate";
import type { RulerMark } from "./messagesModel";
import type { ProfilerData } from "./profilerData";
import { BOX_H, BOX_W, clockText, extent, linePath, maxOf, pct, rulerTicks, stepPath, valueAt, yOf } from "./timelineGeometry";
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
/** Height of one voice row, px. */
const ROW_PX = 16;

/** The time under a pointer event on a plot element. */
function timeAt(e: MouseEvent, duration: number): number {
  const el = e.currentTarget as HTMLElement;
  const r = el.getBoundingClientRect();
  return r.width > 0 ? Math.min(Math.max((e.clientX - r.left) / r.width, 0), 1) * duration : 0;
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
  readonly children?: ComponentChildren;
}

function TrackRow(props: TrackRowProps) {
  return (
    <div class={`pf-track pf-track-${props.track.kind}`} data-track={props.track.id} role="group" aria-label={props.track.label}>
      <div class="pf-track-head">
        <span class="pf-track-label">{props.track.label}</span>
        {props.value && <span class="pf-track-value">{props.value}</span>}
      </div>
      <div class="pf-plot" style={props.height ? { height: `${props.height}px` } : undefined} onClick={(e) => props.onSeek(timeAt(e, props.duration))}>
        {props.children}
      </div>
    </div>
  );
}

/** ADR 0348: a take's pictures of the game view, as the kit's filmstrip across the track's width. */
function PictureTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const ref = useRef<HTMLDivElement>(null);
  const width = useElementWidth(ref);
  const toX = (t: number) => (data.duration > 0 ? (Math.min(Math.max(t, 0), data.duration) / data.duration) * width : 0);
  const n = data.frames.length;
  return (
    <TrackRow track={track} value={n === 1 ? "1 picture" : `${n} pictures`} duration={data.duration} onSeek={onSeek} height={40}>
      <div ref={ref} class="pf-picture">
        {width > 0 && <Filmstrip frames={data.frames} toX={toX} time={cursor} thumbWidth={56} onSeek={onSeek} />}
      </div>
    </TrackRow>
  );
}

function LoadTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const load = data.load!;
  const top = Math.max(1, maxOf(load.cap.values), maxOf(load.voices.values)) * 1.15;
  const cap = valueAt(load.cap, cursor);
  const voices = valueAt(load.voices, cursor);
  const capNow = valueAt(load.cap, data.duration) ?? 0;
  const cpuNow = load.cpu.map((l) => valueAt(l, cursor)).find((v) => v !== null && Number.isFinite(v));
  const value = `${voices ?? 0} voices · cap ${cap ?? "?"}${cpuNow != null ? ` · CPU ${Math.round(cpuNow)}‰` : ""}`;
  return (
    <TrackRow track={track} value={value} duration={data.duration} onSeek={onSeek} height={56}>
      <Lines
        height={56}
        paths={[
          ...load.cpu.map((l) => ({ d: linePath(l, data.duration, 0, l.yMax ?? Math.max(1000, maxOf(l.values))), cls: "pf-line pf-cpu" })),
          { d: stepPath(load.cap, data.duration, 0, top), cls: "pf-line pf-cap" },
          { d: linePath(load.voices, data.duration, 0, top), cls: "pf-line pf-voices" },
        ]}
      />
      <span class="pf-ref-label">voice cap {capNow}</span>
    </TrackRow>
  );
}

function EffectsTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const cost = data.effects!;
  return (
    <TrackRow track={track} value={effectsCostText(cost, cursor)} duration={data.duration} onSeek={onSeek} height={48}>
      <Lines height={48} paths={cost.lanes.map((l) => ({ d: linePath(l, data.duration, 0, cost.peak), cls: `pf-line pf-fx pf-fx-${l.key}` }))} />
      <span class="pf-fx-legend" title="Estimated from the CPU meter's work per section, in permille of an audio quantum; the core doesn't report each effect's cost yet">
        {cost.lanes.map((l) => (
          <span key={l.key} class={`pf-fx-key pf-fx-${l.key}`} title={EFFECT_SECTIONS[l.key].holds}>
            {l.label}
          </span>
        ))}
      </span>
    </TrackRow>
  );
}

/** ADR 0351 §6: the clip arena and the loaded packages' memory, on one scale, with a mark at each package load and unload. */
function MemoryTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const m = data.memory!;
  const top = Math.max(1, m.peakArena, m.peakPackages) * 1.15;
  return (
    <TrackRow track={track} value={memoryText(m, cursor, formatBytes)} duration={data.duration} onSeek={onSeek} height={48}>
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
      <span class="pf-ref-label" title={m.unknownPackages.length ? `This capture doesn't say what ${m.unknownPackages.join(", ")} held` : undefined}>
        peak arena {formatBytes(m.peakArena)}
        {m.packages.times.length ? ` · packages ${formatBytes(m.peakPackages)}` : ""}
      </span>
    </TrackRow>
  );
}

function BusTrack({ data, track, slot, readout, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; slot: number; readout: BusReadout | undefined; cursor: number; onSeek(t: number): void }) {
  const line = data.buses.get(slot)!;
  const now = valueAt(line, cursor);
  return (
    <TrackRow track={track} value={now === null ? null : formatDb(now)} duration={data.duration} onSeek={onSeek} height={40}>
      <Lines height={40} paths={[{ d: stepPath(line, data.duration, BUS_MIN_DB, BUS_MAX_DB), cls: "pf-line pf-bus" }]}>
        {refLine(yOf(0, BUS_MIN_DB, BUS_MAX_DB), "pf-ref pf-zero")}
      </Lines>
      {readout && (
        <span class={`pf-float${pct(cursor, data.duration) > 60 ? " left" : ""}`} style={{ left: `${pct(cursor, data.duration)}%` }} role="note">
          {breakdownText(readout)}
        </span>
      )}
    </TrackRow>
  );
}

function LoudnessTrack({ data, track, cursor, onSeek }: { data: ProfilerData; track: PlannedTrack; cursor: number; onSeek(t: number): void }) {
  const l = data.loudness!;
  const now = valueAt(l.shortTerm, cursor);
  const value = `${l.name} ${now === null ? "—" : `${now.toFixed(1)} LUFS`}${l.target !== null ? ` · target ${l.target}` : ""}`;
  return (
    <TrackRow track={track} value={value} duration={data.duration} onSeek={onSeek} height={44}>
      <Lines height={44} paths={[{ d: linePath(l.shortTerm, data.duration, LUFS_MIN, LUFS_MAX), cls: "pf-line pf-loud" }]}>
        {l.target !== null ? refLine(yOf(l.target, LUFS_MIN, LUFS_MAX), "pf-ref pf-target") : null}
      </Lines>
      {l.target !== null ? <span class="pf-ref-label">target {l.target}</span> : <span />}
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

function VoiceButton({ block, duration, row, selected, dim, onSelect }: { block: VoiceBlock; duration: number; row: number; selected: boolean; dim: boolean; onSelect(key: string): void }) {
  const left = pct(block.start, duration);
  const width = Math.max(0, pct(block.end, duration) - left);
  const label = `${block.generator ? `${generatorBadge(block.generator).name} ` : ""}${block.clipName}: ${STATUS_TEXT[block.status]}, ${clockText(block.start)}${block.end > block.start ? ` to ${clockText(block.end)}` : ""}`;
  return (
    <button
      type="button"
      class={`pf-voice${selected ? " selected" : ""}${dim ? " dim" : ""}${block.end <= block.start ? " instant" : ""}`}
      data-status={block.status}
      data-voice={block.key}
      style={{ left: `${left}%`, width: `${width}%`, top: `${row * ROW_PX + 2}px` }}
      aria-pressed={selected}
      aria-label={label}
      title={`${voiceSummary(block)} · ${clockText(block.start)}`}
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

function VoiceLanes(props: { data: ProfilerData; track: PlannedTrack; selected: string | null; problemsOnly: boolean; groupBy: GroupBy; onSeek(t: number): void; onSelect(key: string): void }) {
  const { data } = props;
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
        <TrackRow key={lane.key} track={{ ...props.track, label: lane.label }} value={lane.problems > 0 ? `${lane.problems} problem${lane.problems === 1 ? "" : "s"}` : null} duration={data.duration} onSeek={props.onSeek} height={lane.rowCount * ROW_PX + 4}>
          {lane.blocks.map((b, i) => (
            <VoiceButton key={b.key} block={b} duration={data.duration} row={lane.rows[i]!} selected={b.key === props.selected} dim={dimmed(b, props.problemsOnly)} onSelect={props.onSelect} />
          ))}
        </TrackRow>
      ))}
    </>
  );
}

function Ruler({ data, cursor, onSeek, onSelect }: { data: ProfilerData; cursor: number; onSeek(t: number): void; onSelect(key: string): void }) {
  const markAt = (m: RulerMark) => () => (m.voice ? onSelect(m.voice) : onSeek(m.time));
  return (
    <div class="pf-track pf-ruler-row">
      <div class="pf-track-head">
        <span class="pf-track-label pf-clock" aria-live="off">
          {clockText(cursor)}
        </span>
      </div>
      <div class="pf-plot pf-ruler" onClick={(e) => onSeek(timeAt(e, data.duration))} aria-label="Ruler: click to move the cursor">
        {rulerTicks(data.duration).map((t) => (
          <span key={t} class="pf-tick" style={{ left: `${pct(t, data.duration)}%` }}>
            {clockText(t).replace(/\.0$/, "")}
          </span>
        ))}
        {data.marks.map((m, i) => (
          <button
            key={i}
            type="button"
            class="pf-mark"
            data-kind={m.kind}
            style={{ left: `${pct(m.time, data.duration)}%` }}
            title={`${clockText(m.time)} ${m.text}`}
            aria-label={`${m.kind === "info" ? "Marker" : m.kind === "error" ? "Error" : "Warning"} at ${clockText(m.time)}: ${m.text}`}
            onClick={(e) => {
              e.stopPropagation();
              markAt(m)();
            }}
          />
        ))}
      </div>
    </div>
  );
}

export function ProfilerTimeline(props: ProfilerTimelineProps) {
  const { data, cursor } = props;
  const readout = (slot: number) => props.readouts.find((r) => r.slot === slot);
  return (
    <div class="pf-timeline" role="region" aria-label="Capture timeline">
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
            case "bus":
              return <BusTrack key={track.id} data={data} track={track} slot={track.slot} readout={readout(track.slot)} cursor={cursor} onSeek={props.onSeek} />;
            case "loudness":
              return <LoudnessTrack key={track.id} data={data} track={track} cursor={cursor} onSeek={props.onSeek} />;
            case "voices":
              return <VoiceLanes key={track.id} data={data} track={track} selected={props.selected} problemsOnly={props.problemsOnly} groupBy={props.groupBy} onSeek={props.onSeek} onSelect={props.onSelect} />;
            case "parameter":
              return <ParameterTrack key={track.id} data={data} track={track} name={track.name} cursor={cursor} onSeek={props.onSeek} />;
          }
        })}
        <div class="pf-cursor-layer" aria-hidden="true">
          <div class="pf-cursor" style={{ left: `${pct(cursor, data.duration)}%` }} />
        </div>
      </div>
    </div>
  );
}
