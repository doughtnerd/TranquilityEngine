// One clip on the Sequence timeline (proto §4 "Clips"): its box with trim edges, the waveform of its sample drawn as
// the clip plays it (pickup and first pass, each extra loop pass, a hold, the tail), the driving loop's band with
// pass dividers, the sample's markers (Exit styled, hidden ones faint), its name, the chips, and the curve it shows
// with draggable keys. A view over props: the timeline handles presses.
import type { Clip, Track } from "../../../../engine/audio/playlist/types";
import type { PeakMips } from "../../../../plugins/audio/editor/music/peaksMip";
import { Icon } from "../../../components/Icon";
import { Waveform } from "../../../components/Waveform";
import { sampleTitle, playlistTitle } from "../playlistPaths";
import type { TargetSpec } from "./automationEdits";
import { clipChips, clipMarkers, clipPlan, loopBand, wavePieces } from "./clipGeometry";
import { CurveOverlay } from "./CurveOverlay";
import type { SourceFacts } from "./sequenceModel";
import type { Automation } from "../../../../engine/audio/playlist/types";

export interface TimelineClipProps {
  readonly clip: Clip;
  readonly track: Track;
  readonly src: SourceFacts | null;
  readonly peaks: PeakMips | null;
  /** The clip's box in the lane, px. */
  readonly left: number;
  readonly width: number;
  readonly height: number;
  readonly selected: boolean;
  readonly follows: boolean;
  readonly showWave: boolean;
  /** The curve it shows (a time curve), its target's range, and the selected keys. */
  readonly curve: { readonly automation: Automation; readonly spec: TargetSpec; readonly keys: readonly number[] } | null;
  readonly razor: boolean;
  onPress(e: PointerEvent, part: "body" | "start" | "end"): void;
  onDoubleClick(e: MouseEvent): void;
  onMenu(e: MouseEvent): void;
  onHover(e: PointerEvent | null): void;
  onPointPress(index: number, e: PointerEvent): void;
  onPointDoubleClick(index: number): void;
  onPointMenu(index: number, e: MouseEvent): void;
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

export const clipName = (c: Clip): string => (c.sample !== undefined ? sampleTitle(c.sample) : typeof c.playlist === "string" ? playlistTitle(c.playlist) : "Embedded playlist");

export function TimelineClip(props: TimelineClipProps) {
  const { clip: c, src, left, width, height } = props;
  const plan = clipPlan(c, src);
  const pxPerSec = width / Math.max(1e-6, plan.length);
  const at = (u: number) => u * pxPerSec;
  const band = c.sample !== undefined ? loopBand(plan) : null;
  const markers = c.sample !== undefined ? clipMarkers(c, src, plan) : [];
  const chips = clipChips(c, src, { follows: props.follows, playlistName: typeof c.playlist === "string" ? playlistTitle(c.playlist) : undefined });
  const color = typeof props.track.color === "number" ? `var(--series-${props.track.color})` : props.track.color;
  const name = clipName(c);
  return (
    <div
      class={`sq-clip${props.selected ? " selected" : ""}${c.enabled && props.track.enabled ? "" : " disabled"}${c.playlist !== undefined ? " playlist" : ""}${props.razor ? " razor" : ""}`}
      style={{ left: `${left}px`, width: `${Math.max(3, width)}px`, height: `${height}px`, "--clip": color }}
      role="button"
      aria-label={`Clip ${name}`}
      aria-pressed={props.selected}
      tabIndex={0}
      data-clip={c.id}
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
        props.onMenu(e);
      }}
      onPointerEnter={(e) => props.onHover(e)}
      onPointerLeave={() => props.onHover(null)}
    >
      {props.showWave && c.sample !== undefined &&
        wavePieces(plan).map((p, i) => (
          <div key={i} class={`sq-wave-piece${p.hold ? " hold" : ""}`} style={{ left: `${at(p.at)}px`, width: `${at(p.length)}px` }}>
            {!p.hold && <Waveform mips={props.peaks} view={{ start: p.src, end: p.src + p.length }} length={plan.end === Infinity ? p.src + p.length : plan.end} color="--clip" placeholder="" label={`${name} waveform`} />}
          </div>
        ))}
      {band && (
        <div class={`sq-loop-band${band.hold ? " hold" : ""}`} style={{ left: `${at(band.start)}px`, width: `${Math.max(1, at(band.end - band.start))}px` }} title={band.hold ? "Hold point: the voice holds here while the loop is active" : `Loop ${band.loopId}${band.overridden ? " (overridden in this clip)" : ""}`}>
          {band.dividers.map((d, i) => <span key={i} class="sq-pass" style={{ left: `${at(d - band.start)}px` }} />)}
        </div>
      )}
      {markers.map((m) => (
        <span key={m.id} class={`sq-clip-marker ${m.type}${m.hidden ? " hidden" : ""}`} style={{ left: `${at(m.at)}px` }} title={`${m.name} (${m.type}${m.hidden ? ", ignored in this clip" : ""})`} />
      ))}
      <span class="sq-clip-name">{name}</span>
      {chips.length > 0 && (
        <span class="sq-chips">
          {chips.map((ch, i) => (
            <span key={i} class={`sq-chip ${ch.kind}`} title={ch.title}>
              {ch.text.startsWith("⚠ ") ? <><Icon name="warning" size={10} label="Warning" /> {ch.text.slice(2)}</> : ch.text}
            </span>
          ))}
        </span>
      )}
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
      <span class="sq-edge start" onPointerDown={(e) => { e.stopPropagation(); props.onPress(e, "start"); }} title="Trim the start" />
      <span class="sq-edge end" onPointerDown={(e) => { e.stopPropagation(); props.onPress(e, "end"); }} title="Set the length (past the sample's end, loops fill it)" />
    </div>
  );
}
