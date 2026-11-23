// One clip on the Sequence timeline (proto A4 `.clip`): its box (12 % of the track colour over the sunken background,
// a 16 px name bar at 34 %), trim edges, and in its body the sample as the clip plays it (pickup and first pass, each
// extra loop pass, a hold, the tail) as a waveform, a six-band spectrogram, or both split, mirrored when it plays in
// reverse; the driving loop's band (dashed edges when inherited, solid and brighter when this clip overrides it) with
// pass dividers and a hatched hold; the sample's markers (Exit in green); the name bar's chips (the loop's Active icon,
// "P brake > 0.10" or "⚠ unbound", "⚠ follows", "FX n", the playlist's type badge and "→ pick", the shown curve's name);
// the curve it shows with draggable keys (a dashed 0 dB guide on a selected clip with none); the Amp envelope with its
// three handles; and an Async voice's cursor. Disabled clips are hatched and struck through; muted ones dimmed. A view
// over props: the timeline handles presses.
import { useMemo } from "preact/hooks";
import type { Automation, Clip, PlaylistType, Track } from "../../../../engine/audio/playlist/types";
import type { PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";
import { Icon } from "../../../components/Icon";
import { TypeBadge } from "../../../components/TypeBadge";
import { Waveform } from "../../../components/Waveform";
import type { Pcm } from "../../samples/seam";
import { sampleTitle, playlistTitle } from "../playlistPaths";
import { ADSR_HANDLES, adsrHandleSpots, adsrShape, adsrTip, clipAdsr, type AdsrHandle } from "./adsrModel";
import type { TargetSpec } from "./automationEdits";
import { clipChips, clipMarkers, clipPlan, drawnLoopBand, wavePieces, type WavePiece } from "./clipGeometry";
import { CurveOverlay } from "./CurveOverlay";
import { activeIcon, SeqIcon } from "./sequenceIcons";
import type { SourceFacts } from "./sequenceModel";
import { SPECTRO_BANDS, spectrogramBands } from "./spectrogramModel";

export interface TimelineClipProps {
  readonly clip: Clip;
  readonly track: Track;
  readonly src: SourceFacts | null;
  readonly peaks: PeakMips | null;
  /** The decoded sample, for the spectrogram (null while it decodes, or with the spectrogram off). */
  readonly pcm?: Pcm | null;
  /** What the body draws: the waveform, the spectrogram, or both (split). */
  readonly view?: { readonly wave: boolean; readonly spec: boolean };
  /** The clip's box in the lane, px. */
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly selected: boolean;
  /** Its track is muted, or another track is soloed. */
  readonly silent?: boolean;
  readonly follows: boolean;
  /** Where an Async voice is now, in clip time (null: none playing). */
  readonly voice?: number | null;
  /** A playlist clip's type (its badge) and, for an embedded one, how many entries it has. */
  readonly playlistType?: PlaylistType | null;
  readonly playlistCount?: number | null;
  /** The curve it shows (a time curve), its target's range, and the selected keys. */
  readonly curve: { readonly automation: Automation; readonly spec: TargetSpec; readonly keys: readonly number[] } | null;
  readonly razor: boolean;
  /** The playhead is inside this clip while playing (a playlist clip shows "→ pick"). */
  readonly playingHere?: boolean;
  onPress(e: PointerEvent, part: "body" | "start" | "end"): void;
  onDoubleClick(e: MouseEvent): void;
  onMenu(e: MouseEvent): void;
  onHover(e: PointerEvent | null): void;
  onPointPress(index: number, e: PointerEvent): void;
  onPointDoubleClick(index: number): void;
  onPointMenu(index: number, e: MouseEvent): void;
  /** An Amp envelope handle pressed (the box size maps the drag). */
  onAdsrPress?(handle: AdsrHandle, e: PointerEvent, box: { readonly width: number; readonly height: number }): void;
  /** Enter or Space on the focused clip selects it (Ctrl/⌘ or Shift adds it); the timeline's keys then move it. */
  onKeySelect?(add: boolean): void;
}

/** Opens a menu from the keyboard (the context-menu key or Shift+F10) under the element, as a right-click would. */
export function keyboardMenu(e: KeyboardEvent, open: (m: MouseEvent) => void): boolean {
  if (e.key !== "ContextMenu" && !(e.shiftKey && e.key === "F10")) return false;
  e.preventDefault();
  e.stopPropagation();
  const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
  open(new MouseEvent("contextmenu", { clientX: r.left + Math.min(24, r.width / 2), clientY: r.bottom }));
  return true;
}

/** The width of a clip's trim and length edges (`.sq-edge`), which win over curve points under them. */
const EDGE_PX = 6;
/** The name bar's height. */
const BAR = 16;
const PLAYLIST_NAMES: Record<PlaylistType, string> = { clip: "Clip", queue: "Queue", switch: "Switch", blend: "Blend", layer: "Layer", sequence: "Sequence" };

export const clipName = (c: Clip): string => (c.sample !== undefined ? sampleTitle(c.sample) : typeof c.playlist === "string" ? playlistTitle(c.playlist) : "Embedded playlist");

/** The name the timeline shows: an embedded playlist by its kind and size ("Queue · 3"). */
const shownName = (c: Clip, type: PlaylistType | null | undefined, count: number | null | undefined): string =>
  typeof c.playlist === "object" && c.playlist && type ? `${PLAYLIST_NAMES[type]}${count ? ` · ${count}` : ""}` : clipName(c);

const bandCache = new WeakMap<object, Map<string, Float32Array>>();
function bandsFor(pcm: Pcm, p: WavePiece, columns: number): Float32Array {
  let m = bandCache.get(pcm);
  if (!m) bandCache.set(pcm, (m = new Map()));
  const key = `${p.src.toFixed(4)}:${p.length.toFixed(4)}:${columns}`;
  let v = m.get(key);
  if (!v) {
    v = spectrogramBands(pcm, p.src, p.src + p.length, columns);
    if (m.size > 200) m.clear();
    m.set(key, v);
  }
  return v;
}

function Spectrogram(props: { readonly pcm: Pcm; readonly piece: WavePiece; readonly width: number; readonly height: number }) {
  const cols = Math.max(1, Math.min(160, Math.round(props.width / 3)));
  const bands = bandsFor(props.pcm, props.piece, cols);
  const n = SPECTRO_BANDS.length;
  const bh = props.height / n;
  const cw = props.width / cols;
  const rects = [];
  for (let c = 0; c < cols; c++) {
    for (let b = 0; b < n; b++) {
      const v = bands[c * n + b]!;
      if (v < 0.05) continue;
      // Stepped opacity (proto): quantised to quarters so the bands read as steps, high bands on top.
      rects.push(<rect key={`${c}:${b}`} x={c * cw} y={(n - 1 - b) * bh + 0.5} width={cw + 0.3} height={bh - 1} opacity={Math.ceil(v * 4) / 4 * 0.85} />);
    }
  }
  return <svg class="sq-spec" width={props.width} height={props.height} aria-hidden="true">{rects}</svg>;
}

export function TimelineClip(props: TimelineClipProps) {
  const { clip: c, src, left, width, height } = props;
  const plan = useMemo(() => clipPlan(c, src), [c, src]);
  const pxPerSec = width / Math.max(1e-6, plan.length);
  const at = (u: number) => u * pxPerSec;
  const band = c.sample !== undefined ? drawnLoopBand(plan, c.reverse) : null;
  const markers = c.sample !== undefined ? clipMarkers(c, src, plan) : [];
  const chips = clipChips(c, src, { follows: props.follows, playlistName: undefined }).filter((ch) => ch.kind !== "loop" && ch.kind !== "disabled" && (ch.kind !== "pick" || !!props.playingHere));
  const color = typeof props.track.color === "number" ? `var(--series-${props.track.color})` : props.track.color;
  const name = shownName(c, props.playlistType, props.playlistCount);
  const view = props.view ?? { wave: true, spec: false };
  const split = view.wave && view.spec && !!props.pcm;
  const body = Math.max(0, height - BAR);
  const pieces = c.sample !== undefined ? wavePieces(plan) : [];
  const env = clipAdsr(c.effects);
  const adsr = env && c.sample !== undefined ? adsrShape(env.adsr, plan.length) : null;
  const spots = env && adsr ? adsrHandleSpots(env.adsr, plan.length, Math.max(3, width)) : null;
  const disabled = !(c.enabled && props.track.enabled);
  const shownName_ = props.curve ? props.curve.spec.name : null;
  const fromSample = c.sample !== undefined ? "" : typeof c.playlist === "string" ? " · playlist clip · double-click to open the playlist" : " · embedded playlist clip";
  const tip = `${c.sample ?? name}${fromSample}${c.sample !== undefined ? ` · ${c.sync ? "sync" : "async"} · ${plan.length.toFixed(2)} s${band ? ` · loop ${band.active === "parameter" ? "parameter" : band.active === "held" ? "while held" : "always"}${band.overridden ? " (this clip)" : ""}` : ""}` : ""} · right-click for more`;
  const levelY = (v: number) => BAR + 2 + (1 - v) * (body - 4);
  return (
    <div
      class={`sq-clip${props.selected ? " selected" : ""}${disabled ? " disabled" : ""}${props.silent ? " silent" : ""}${props.razor ? " razor" : ""}${c.reverse ? " reverse" : ""}`}
      style={{ left: `${left}px`, width: `${Math.max(3, width)}px`, height: `${height}px`, "--clip": color }}
      role="button"
      aria-label={`Clip ${clipName(c)}`}
      aria-pressed={props.selected}
      tabIndex={0}
      data-clip={c.id}
      title={tip}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget || keyboardMenu(e, props.onMenu)) return;
        if ((e.key === "Enter" || e.key === " ") && props.onKeySelect) {
          e.preventDefault();
          e.stopPropagation();
          props.onKeySelect(e.ctrlKey || e.metaKey || e.shiftKey);
        }
      }}
      onPointerDown={(e) => props.onPress(e, "body")}
      onDblClick={(e) => props.onDoubleClick(e)}
      onContextMenu={(e) => {
        e.preventDefault();
        props.onHover(null);
        props.onMenu(e);
      }}
      onPointerEnter={(e) => props.onHover(e)}
      onPointerLeave={() => props.onHover(null)}
    >
      <div class="sq-clip-name">
        {band && <SeqIcon name={activeIcon(band.active)} size={11} />}
        {props.playlistType && <span class="sq-clip-badge"><TypeBadge playlist={props.playlistType} /></span>}
        <span class="sq-clip-title">{name}</span>
        {chips.map((ch, i) => (
          <span key={i} class={`sq-chip ${ch.kind}${ch.text.startsWith("⚠") ? " warn" : ""}`} title={ch.title}>
            {ch.text.startsWith("⚠ ") ? <><Icon name="warning" size={9} label="Warning" /> {ch.text.slice(2)}</> : ch.text}
          </span>
        ))}
        {shownName_ && <span class="sq-chip env" title="The curve drawn on this clip (choose another in the Inspector)">{shownName_}</span>}
        {env && <span class="sq-chip adsr" title="Amp envelope: per voice, attack and decay from the start, sustain while the clip plays, release at its end">ADSR</span>}
      </div>
      <div class={`sq-clip-body${c.reverse ? " mirrored" : ""}`}>
        {pieces.map((p, i) => (
          <div key={i} class={`sq-wave-piece${p.hold ? " hold" : ""}`} style={{ left: `${at(p.at)}px`, width: `${at(p.length)}px` }}>
            {!p.hold && view.wave && (
              <div class="sq-wave-box" style={{ height: split ? "50%" : "100%" }}>
                <Waveform mips={props.peaks} view={{ start: p.src, end: p.src + p.length }} length={plan.end === Infinity ? p.src + p.length : plan.end} color="--clip" placeholder="" label={`${name} waveform`} />
              </div>
            )}
            {!p.hold && view.spec && props.pcm && (
              <div class="sq-spec-box" style={{ top: split ? "50%" : "0", height: split ? "50%" : "100%" }}>
                <Spectrogram pcm={props.pcm} piece={p} width={Math.max(1, at(p.length))} height={Math.max(4, split ? body / 2 : body)} />
              </div>
            )}
          </div>
        ))}
      </div>
      {band && (
        band.hold
          ? <div class="sq-hold-band" style={{ left: `${at(band.start)}px`, width: `${Math.max(2, at(band.end - band.start))}px` }} title="Hold: the voice holds here while the loop is active" />
          : (
            <div class={`sq-loop-band${band.overridden ? " override" : ""}`} style={{ left: `${at(band.start)}px`, width: `${Math.max(1, at(band.end - band.start))}px` }} title={`Loop${band.overridden ? " (this clip's own settings)" : " (the sample's settings)"}`}>
              {band.dividers.map((d, i) => <span key={i} class="sq-pass" style={{ left: `${at(d - band.start)}px` }} />)}
            </div>
          )
      )}
      {markers.map((m) => (
        <span key={m.id} class={`sq-clip-marker ${m.type}${m.hidden ? " hidden" : ""}`} style={{ left: `${at(m.at)}px` }} title={`${m.name} (${m.type}${m.hidden ? ", off here" : ""})`} />
      ))}
      {props.selected && !props.curve && c.sample !== undefined && <div class="sq-zero-guide" style={{ top: `${4 + (1 - 60 / 72) * (height - 8)}px` }} title="Double-click to add a volume envelope" />}
      {adsr && (
        <svg class={`sq-adsr${env!.effect.on ? "" : " bypassed"}`} width={Math.max(3, width)} height={height} aria-label="Amp envelope" role="img">
          <polygon points={adsr.points.map(([x, y]) => `${at(x).toFixed(1)},${levelY(y).toFixed(1)}`).join(" ")} />
        </svg>
      )}
      {adsr && env!.effect.on && !props.razor && ADSR_HANDLES.map((h) => (
        <span key={h} class="sq-adsr-handle" style={{ left: `${spots![h][0]}px`, top: `${levelY(spots![h][1])}px` }} title={adsrTip(env!.adsr, h)}
          onPointerDown={(e) => { e.stopPropagation(); props.onAdsrPress?.(h, e, { width: Math.max(3, width), height }); }} />
      ))}
      {props.curve && (
        <CurveOverlay
          curve={props.curve.automation.curve}
          spec={props.curve.spec}
          width={Math.max(3, width)}
          height={height}
          toX={(x) => at(x)}
          fromX={(px) => px / pxPerSec}
          selected={props.curve.keys}
          muted={props.curve.automation.bypass}
          interactive={!props.razor}
          edgeGuard={EDGE_PX}
          label={`${props.curve.spec.name} curve`}
          onPointPress={props.onPointPress}
          onPointDoubleClick={(i) => props.onPointDoubleClick(i)}
          onPointMenu={props.onPointMenu}
        />
      )}
      {props.voice != null && props.voice >= 0 && <span class="sq-voice" style={{ left: `${at(props.voice)}px` }} title="Where this Async clip's voice is playing" />}
      <span class="sq-edge start" onPointerDown={(e) => { e.stopPropagation(); props.onPress(e, "start"); }} title="Drag to trim the start" />
      <span class="sq-edge end" onPointerDown={(e) => { e.stopPropagation(); props.onPress(e, "end"); }} title="Drag to set the clip length" />
    </div>
  );
}
