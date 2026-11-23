// A Clip's editor (the prototype's Clip view, `.ctb` and `.ctl`): the toolbar row (the sample's name and length, the
// Loop icons From sample / Off / Loop, the Voice button, the Variation button with its popover, Make shared for an
// embedded clip, Open in Samples) over the clip lanes: a ruler with the time display (▾ Timecode / Samples / Bars,
// shared with Samples), the sample's loop regions, the Trim bar and the waveform with the trimmed-out parts dimmed and
// both trim edges draggable (one undo step per drag). The trim is the clip's own; with none it shows the sample's.
// A view over props.
import { useRef, useState } from "preact/hooks";
import type { PlaylistBody, SampleEntry } from "../../../engine/audio/playlist/types";
import { ContextMenu } from "../../../editor/ui/ContextMenu";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { NumberBox } from "../../../editor/ui/PanelFields";
import type { PeakMips } from "../../../plugins/audio/editor/music/peaksMip";
import { Icon } from "../../components/Icon";
import { TimeRuler } from "../../components/TimeRuler";
import { TIME_FORMATS, formatTime, type TimeFormat } from "../../components/timeRulerModel";
import { Waveform } from "../../components/Waveform";
import type { BodyEdit } from "./EntryList";
import { secondsText } from "./entryRowModel";
import { Glyph, IconSegments, LOOP_GLYPHS, VARIATION_GLYPH } from "./glyphs";
import { MiniPopover } from "./MiniPopover";
import { setClipSampleFields, setEntryUse, setLevels } from "./playlistEdits";
import { sampleTitle } from "./playlistPaths";
import { VoiceButton } from "./VoiceButton";

/** What the clip lanes know of the sample (null fields while its peaks load). */
export interface ClipSource {
  readonly peaks: PeakMips | null;
  /** Where the sample's playable part starts in its file, and how long it is (its own trim applied). */
  readonly start: number;
  readonly length: number | null;
  readonly loops: readonly { readonly id: string; readonly start: number; readonly end: number }[];
}

export interface ClipEditorProps {
  readonly body: PlaylistBody;
  readonly writable: boolean;
  readonly source: ClipSource | null;
  /** The time display (shared with Samples) and its change. */
  readonly format: TimeFormat;
  onFormat(f: TimeFormat): void;
  /** An embedded clip can be made shared. */
  readonly embedded: boolean;
  onEdit(label: string, edit: BodyEdit, drag?: boolean): void;
  onReplace(): void;
  onOpenSamples(sample: string): void;
  onEditCurves(index: number): void;
  onMakeShared?(): void;
}

const LOOPS = [
  { value: "inherit" as const, label: "From sample", title: "From sample: use the sample's own loop points (edit them in Samples)", glyph: LOOP_GLYPHS.inherit },
  { value: "off" as const, label: "Off", title: "Off: play once", glyph: LOOP_GLYPHS.off },
  { value: "on" as const, label: "Loop", title: "Loop: loop the trimmed region", glyph: LOOP_GLYPHS.on },
];

/** The Variation button's text: "±1.5 dB · ±0.5 st" when symmetric, the ranges otherwise, "No variation" for none. */
function variationText(volume: readonly [number, number], pitch: readonly [number, number]): string {
  const one = (r: readonly [number, number], unit: string) => {
    if (r[0] === 0 && r[1] === 0) return null;
    if (r[0] === -r[1]) return `±${Math.abs(r[1])} ${unit}`;
    const f = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : ""}${Math.abs(v)}`;
    return `${f(r[0])}..${f(r[1])} ${unit}`;
  };
  const parts = [one(volume, "dB"), one(pitch, "st")].filter(Boolean);
  return parts.length ? parts.join(" · ") : "No variation";
}

export function ClipEditor(props: ClipEditorProps) {
  const { body, writable, onEdit, source } = props;
  const s = body.entries[0] as SampleEntry | undefined;
  const [tcMenu, setTcMenu] = useState<Element | null>(null);
  const lane = useRef<HTMLDivElement>(null);
  if (!s || s.kind !== "sample") {
    return <EmptyState compact title="No sample yet" body="A Clip plays one sample." action={{ label: "Choose sample…", disabled: !writable, run: props.onReplace }} />;
  }
  const rate = source?.peaks?.rate ?? 48000;
  const fileLength = source?.peaks && source.peaks.rate > 0 ? source.peaks.frames / source.peaks.rate : null;
  const own = source && source.length !== null ? ([source.start, source.start + source.length] as const) : null;
  const trim = s.trim ?? own ?? [0, fileLength ?? 1];
  const end = fileLength ?? Math.max(trim[1], 1);
  const view = { start: 0, end };
  const ctx = { rate };
  const length = Math.max(0, trim[1] - trim[0]);
  const at = (t: number) => `${(Math.max(0, Math.min(1, t / end)) * 100).toFixed(3)}%`;
  const fmt = (t: number) => formatTime(t, props.format, ctx);

  /** Drag a trim edge across the lane: live edits that coalesce, one undo step on release. */
  const drag = (edge: 0 | 1, e: PointerEvent) => {
    const el = lane.current;
    if (!writable || !el || e.button !== 0) return;
    e.preventDefault();
    e.stopPropagation();
    const doc = el.ownerDocument;
    let next: [number, number] = [trim[0], trim[1]];
    const place = (ev: PointerEvent) => {
      const r = el.getBoundingClientRect();
      const t = Math.max(0, Math.min(end, ((ev.clientX - r.left) / Math.max(1, r.width)) * end));
      next = edge === 0 ? [Math.min(t, trim[1] - 0.01), trim[1]] : [trim[0], Math.max(t, trim[0] + 0.01)];
      onEdit("Trim", (b) => setClipSampleFields(b, { trim: next }), true);
    };
    const up = () => {
      doc.removeEventListener("pointermove", place);
      doc.removeEventListener("pointerup", up);
      doc.removeEventListener("pointercancel", up);
      onEdit("Trim", (b) => setClipSampleFields(b, { trim: next }));
    };
    doc.addEventListener("pointermove", place);
    doc.addEventListener("pointerup", up);
    doc.addEventListener("pointercancel", up);
  };
  const edgeKeys = (edge: 0 | 1, e: KeyboardEvent) => {
    if (!writable || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
    e.preventDefault();
    const d = (e.key === "ArrowLeft" ? -1 : 1) * (e.shiftKey ? 0.1 : 0.01);
    const next: [number, number] = edge === 0 ? [Math.max(0, Math.min(trim[0] + d, trim[1] - 0.01)), trim[1]] : [trim[0], Math.min(end, Math.max(trim[1] + d, trim[0] + 0.01))];
    onEdit("Trim", (b) => setClipSampleFields(b, { trim: next }));
  };
  const handle = (edge: 0 | 1, cls: string) => (
    <span class={cls} style={{ left: at(trim[edge]) }} role="slider" tabIndex={writable ? 0 : -1} aria-label={edge === 0 ? "Trim start" : "Trim end"} aria-valuenow={trim[edge]} aria-valuetext={fmt(trim[edge])}
      title={`Drag to trim the ${edge === 0 ? "start" : "end"} (← → nudge, Shift ×10)`} onPointerDown={(e) => drag(edge, e)} onKeyDown={(e) => edgeKeys(edge, e)} />
  );
  const info = source?.peaks ? `${Math.round(source.peaks.rate / 100) / 10} kHz · ${source.peaks.channels === 1 ? "mono" : source.peaks.channels === 2 ? "stereo" : `${source.peaks.channels} ch`} · ${secondsText(fileLength ?? 0)}` : "Reading…";

  return (
    <div class="pl-clip">
      <div class="pl-ctb" role="toolbar" aria-label="Clip">
        <span class="pl-note-glyph" aria-hidden="true">♪</span>
        <b class="pl-nm" title={`Sample used by this clip: ${s.sample}`}>{sampleTitle(s.sample)}</b>
        <span class="pl-faint">{secondsText(length)}</span>
        <span class="pl-vs" />
        <IconSegments label="Loop" value={s.loop} options={LOOPS} disabled={!writable} onChange={(v) => onEdit("Loop", (b) => setClipSampleFields(b, { loop: v }))} />
        <span class="pl-vs" />
        <VoiceButton use={{ volume: body.volume, pitch: body.pitch, curves: s.curves }} name={sampleTitle(s.sample)} writable={writable} onOpen={() => props.onEditCurves(0)}
          onCurves={(curves, label) => onEdit(label, (b) => setEntryUse(b, 0, { curves }))} />
        <MiniPopover title="Variation per trigger" align="start" buttonClass={`pl-cvw${body.volumeRandom.some(Boolean) || body.pitchRandom.some(Boolean) ? " set" : ""}`}
          buttonTitle="Variation: a small random offset on every trigger, so repeats don't sound identical" buttonLabel={`Variation: ${variationText(body.volumeRandom, body.pitchRandom)}`}
          button={<><Glyph paths={VARIATION_GLYPH} size={13} width={1.4} /><span>{variationText(body.volumeRandom, body.pitchRandom)}</span><Icon name="chevronDown" size={10} /></>}>
          <div class="pl-pop-grid">
            <span class="pl-faint">Gain</span>
            <span class="pl-inline">
              <NumberBox class="pl-n56" label="Random gain, low" value={body.volumeRandom[0]} min={-48} max={48} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Variation", (b) => setLevels(b, { volumeRandom: [v, b.volumeRandom[1]] }))} />
              <span class="pl-faint">to</span>
              <NumberBox class="pl-n56" label="Random gain, high" value={body.volumeRandom[1]} min={-48} max={48} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Variation", (b) => setLevels(b, { volumeRandom: [b.volumeRandom[0], v] }))} />
              <span class="pl-unit">dB</span>
            </span>
            <span class="pl-faint">Pitch</span>
            <span class="pl-inline">
              <NumberBox class="pl-n56" label="Random pitch, low" value={body.pitchRandom[0]} min={-24} max={24} step={0.1} digits={2} disabled={!writable} onValue={(v) => onEdit("Variation", (b) => setLevels(b, { pitchRandom: [v, b.pitchRandom[1]] }))} />
              <span class="pl-faint">to</span>
              <NumberBox class="pl-n56" label="Random pitch, high" value={body.pitchRandom[1]} min={-24} max={24} step={0.1} digits={2} disabled={!writable} onValue={(v) => onEdit("Variation", (b) => setLevels(b, { pitchRandom: [b.pitchRandom[0], v] }))} />
              <span class="pl-unit">st</span>
            </span>
          </div>
          <span class="pl-faint pl-pop-note">Drawn again on every trigger, between the two values. Keeps repeats (footsteps, impacts) from sounding identical; usually 0 for music, dialogue and long loops.</span>
        </MiniPopover>
        <span class="pl-flex" />
        {props.embedded && props.onMakeShared && <button type="button" class="pl-small" disabled={!writable} title="Give it its own place in the playlist list so other playlists can use it" onClick={props.onMakeShared}>Make shared</button>}
        <button type="button" class="pl-small" title="Replace the sample (or drop one from the Library)" disabled={!writable} onClick={props.onReplace}>Replace…</button>
        <button type="button" class="pl-small pl-link-btn" title="Edit its loops, markers and trim in Samples" onClick={() => props.onOpenSamples(s.sample)}>Open in Samples <Icon name="chevronRight" size={11} /></button>
      </div>
      {body.entries.length > 1 && <p class="pl-note">A Clip plays its first sample; the {body.entries.length - 1} after it are kept but not played.</p>}
      <div class="pl-ctl">
        <div class="pl-crow">
          <div class="pl-chd pl-tc">
            <span class="pl-tc-text" title={`This clip plays ${fmt(trim[0])} to ${fmt(trim[1])} of the sample`}>{fmt(length)}</span>
            <button type="button" class="pl-tcb" aria-haspopup="menu" aria-expanded={!!tcMenu} aria-label="Time display…" title="Time display: timecode, samples or bars (also sets the ruler; shared with Samples)" onClick={(e) => setTcMenu(e.currentTarget as Element)}>
              <Icon name="chevronDown" size={10} />
            </button>
          </div>
          <div class="pl-cbd"><TimeRuler view={view} format={props.format} context={ctx} length={end} label="Clip time" /></div>
        </div>
        {source && source.loops.length > 0 && (
          <div class="pl-crow">
            <div class="pl-chd pl-faint" title="Loop regions stored in the sample (edit them in Samples)">Sample loops</div>
            <div class="pl-cbd pl-clane">
              {source.loops.map((l) => (
                <span key={l.id} class="pl-cloop" style={{ left: at(l.start), width: `calc(${at(l.end)} - ${at(l.start)})` }} title={`${l.id}: ${fmt(l.start)} – ${fmt(l.end)}`}>↻ {l.id}</span>
              ))}
            </div>
          </div>
        )}
        <div class="pl-crow">
          <div class="pl-chd pl-faint" title="The part of the sample this clip plays: drag either edge">
            Trim
            {s.trim && <button type="button" class="pl-ib pl-trim-reset" aria-label="Use the sample's own trim" title="Use the sample's own trim" disabled={!writable} onClick={() => onEdit("Trim from the sample", (b) => setClipSampleFields(b, { trim: null }))}><Icon name="close" size={10} /></button>}
          </div>
          <div class="pl-cbd pl-clane">
            <div class={`pl-ctrim${s.trim ? "" : " inherited"}`} style={{ left: at(trim[0]), width: `calc(${at(trim[1])} - ${at(trim[0])})` }} title={s.trim ? "This clip's trim" : "The sample's own trim (drag an edge to give the clip its own)"}>
              Trim · {fmt(trim[0])} – {fmt(trim[1])}
            </div>
            {handle(0, "pl-ctrh")}
            {handle(1, "pl-ctrh")}
          </div>
        </div>
        <div class="pl-crow wv">
          <div class="pl-chd"><b>Audio</b><span class="pl-badge-info">{info}</span></div>
          <div class="pl-cbd">
            <div class="pl-dwave" ref={lane}>
              <Waveform mips={source?.peaks ?? null} view={view} length={end} placeholder="Reading the sample…" label={`${sampleTitle(s.sample)} waveform`} />
              <div class="pl-dcut" style={{ left: 0, width: at(trim[0]) }} />
              <div class="pl-dcut" style={{ left: at(trim[1]), right: 0 }} />
              {source?.loops.map((l) => <div key={l.id} class="pl-cloopw" style={{ left: at(l.start), width: `calc(${at(l.end)} - ${at(l.start)})` }} />)}
              <div class="pl-cdl" style={{ left: at(trim[0]) }} />
              <div class="pl-cdl" style={{ left: at(trim[1]) }} />
              {handle(0, "pl-dh")}
              {handle(1, "pl-dh")}
            </div>
          </div>
        </div>
      </div>
      {tcMenu && (
        <ContextMenu at={tcMenu} label="Time display" onClose={() => setTcMenu(null)}
          entries={[{ kind: "group", label: "Time display" }, ...TIME_FORMATS.map((f) => ({ id: f.id, label: f.label, checked: f.id === props.format, note: formatTime(length, f.id, ctx), run: () => props.onFormat(f.id) }))]} />
      )}
    </div>
  );
}
