// The waveform (ADR 0349 `Waveform`): a sample's peaks drawn on a canvas for a view (`waveformModel.ts`) as the owner's
// prototype draws them (a filled envelope mirrored about the centre line, redrawn when the box's width or height
// changes), coloured
// bands over it (loops, the play scope, deleted snippets hatched), and children laid over it (playhead, cut lines).
// Ctrl/⌘+wheel zooms at the pointer and a plain or Shift+wheel scrolls (`onView`); a press reports the time under
// the pointer (`onPress`). With `zoomButtons` it also draws Zoom in, Zoom out and Fit over its top-right corner, so touch
// and keyboard users can zoom (ADR 0361); a screen whose toolbar has its own zoom buttons leaves it off. Colours are
// theme tokens read when it draws, so it follows Settings > Appearance.
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { Icon } from "./Icon";
import { useElementSize } from "./useElementSize";
import type { TimeSpan } from "./timeRulerModel";
import { bandRect, envelopeRuns, scrollBy, waveColumns, xToTime, zoomAt, type PeakMips, type WaveBand } from "./waveformModel";
import "./audioParts.css";
import "./timelineComponents.css";

export interface WaveformProps {
  readonly mips: PeakMips | null;
  readonly view: TimeSpan;
  /** The sample's length, seconds (zoom and scroll stay inside it). */
  readonly length: number;
  readonly bands?: readonly WaveBand[];
  /** The waveform's colour token (default `--badge-text` at half strength, as the prototype draws it). */
  readonly color?: string;
  /** Its opacity (default 0.5 with the default colour, 1 with a named one). */
  readonly opacity?: number;
  /** Px; default fills its box. */
  readonly height?: number;
  /** What it says while the peaks load or when there are none. */
  readonly placeholder?: string;
  readonly label?: string;
  onView?(view: TimeSpan): void;
  onPress?(t: number, e: PointerEvent): void;
  onDoubleClick?(t: number, e: MouseEvent): void;
  onHover?(t: number | null): void;
  /** Draw Zoom in / Zoom out / Fit buttons over the corner (needs `onView`). */
  readonly zoomButtons?: boolean;
  readonly children?: ComponentChildren;
}

/** The envelope's half-height as a share of half the lane (the prototype draws 46 of 50). */
const ENVELOPE_SCALE = 0.92;

function draw(canvas: HTMLCanvasElement, props: WaveformProps, width: number, height: number): void {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const h = height || canvas.clientHeight || props.height || 80;
  canvas.width = Math.max(1, Math.round(width * dpr));
  canvas.height = Math.max(1, Math.round(h * dpr));
  const g = canvas.getContext("2d");
  if (!g) return;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.clearRect(0, 0, width, h);
  const style = getComputedStyle(canvas);
  const mid = h / 2;
  g.fillStyle = style.getPropertyValue("--border").trim() || "gray";
  g.fillRect(0, Math.floor(mid), width, 1);
  // A filled envelope mirrored about the centre line, in --badge-text at half strength (the prototype's look) unless
  // the owner names a colour.
  g.fillStyle = style.getPropertyValue(props.color ?? "--badge-text").trim() || "teal";
  g.globalAlpha = props.opacity ?? (props.color ? 1 : 0.5);
  const amp = mid * ENVELOPE_SCALE;
  for (const run of envelopeRuns(waveColumns(props.mips, props.view, width))) {
    const n = run.amps.length;
    g.beginPath();
    g.moveTo(run.x, mid - Math.max(0.5, run.amps[0]! * amp));
    for (let i = 0; i < n; i++) g.lineTo(run.x + i + 0.5, mid - Math.max(0.5, run.amps[i]! * amp));
    g.lineTo(run.x + n, mid - Math.max(0.5, run.amps[n - 1]! * amp));
    g.lineTo(run.x + n, mid + Math.max(0.5, run.amps[n - 1]! * amp));
    for (let i = n - 1; i >= 0; i--) g.lineTo(run.x + i + 0.5, mid + Math.max(0.5, run.amps[i]! * amp));
    g.lineTo(run.x, mid + Math.max(0.5, run.amps[0]! * amp));
    g.closePath();
    g.fill();
  }
  g.globalAlpha = 1;
}

export function Waveform(props: WaveformProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const { width, height } = useElementSize(box);
  useEffect(() => {
    if (canvas.current && width > 0) draw(canvas.current, props, width, height);
  });
  const timeAt = (clientX: number) => {
    const r = box.current!.getBoundingClientRect();
    return Math.max(0, Math.min(props.length, xToTime(clientX - r.left, props.view, r.width)));
  };
  const onWheel = (e: WheelEvent) => {
    if (!props.onView) return;
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) props.onView(zoomAt(props.view, Math.exp(-e.deltaY * 0.002), timeAt(e.clientX), props.length));
    else {
      const d = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX || e.deltaY : e.deltaY;
      props.onView(scrollBy(props.view, (d / Math.max(1, width)) * (props.view.end - props.view.start), props.length));
    }
  };
  return (
    <div
      ref={box}
      class="tl-wave"
      style={props.height ? { height: `${props.height}px` } : undefined}
      role={props.zoomButtons ? "group" : "img"}
      aria-label={props.label ?? "Waveform"}
      onWheel={onWheel}
      onPointerDown={(e) => props.onPress?.(timeAt(e.clientX), e)}
      onDblClick={(e) => props.onDoubleClick?.(timeAt(e.clientX), e)}
      onPointerMove={(e) => props.onHover?.(timeAt(e.clientX))}
      onPointerLeave={() => props.onHover?.(null)}
    >
      <canvas ref={canvas} class="tl-wave-canvas" aria-hidden="true" />
      {(props.bands ?? []).map((b, i) => {
        const r = bandRect(b, props.view, width);
        if (!r) return null;
        return (
          <div key={i} class={`tl-band${b.hatched ? " hatched" : ""}`} style={{ left: `${r.x}px`, width: `${r.w}px`, "--band": `var(${b.color})` }} title={b.label}>
            {b.label && <span class="tl-band-label">{b.label}</span>}
          </div>
        );
      })}
      {!props.mips && <div class="tl-wave-placeholder">{props.placeholder ?? "Reading the waveform…"}</div>}
      {props.children}
      {props.zoomButtons && props.onView && <ZoomButtons view={props.view} length={props.length} onView={props.onView} />}
    </div>
  );
}

/** Zoom about the view's middle, or fit the whole sample. */
function ZoomButtons(props: { view: TimeSpan; length: number; onView(view: TimeSpan): void }) {
  const { view, length } = props;
  const mid = (view.start + view.end) / 2;
  const whole = view.start <= 0 && view.end >= length;
  return (
    <div class="tl-wave-zoom" role="toolbar" aria-label="Zoom" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      <button type="button" class="studio-icon-button" aria-label="Zoom out" title="Zoom out (Ctrl+wheel)" disabled={whole} onClick={() => props.onView(zoomAt(view, 1 / 1.5, mid, length))}>
        <Icon name="zoomOut" size={14} />
      </button>
      <button type="button" class="studio-icon-button" aria-label="Zoom in" title="Zoom in (Ctrl+wheel)" onClick={() => props.onView(zoomAt(view, 1.5, mid, length))}>
        <Icon name="zoomIn" size={14} />
      </button>
      <button type="button" class="studio-icon-button" aria-label="Fit" title="Show the whole sample" disabled={whole} onClick={() => props.onView({ start: 0, end: length })}>
        <Icon name="fit" size={14} />
      </button>
    </div>
  );
}
