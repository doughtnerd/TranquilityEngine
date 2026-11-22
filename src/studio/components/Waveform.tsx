// The waveform (ADR 0335 `Waveform`): a sample's peaks drawn on a canvas for a view (`waveformModel.ts`), coloured
// bands over it (loops, the play scope, deleted snippets hatched), and children laid over it (playhead, cut lines).
// Ctrl/⌘+wheel zooms at the pointer and a plain or Shift+wheel scrolls (`onView`); a press reports the time under
// the pointer (`onPress`). Colours are theme tokens read when it draws, so it follows Settings > Appearance.
import type { ComponentChildren } from "preact";
import { useEffect, useRef } from "preact/hooks";
import { useElementWidth } from "./useElementWidth";
import type { TimeSpan } from "./timeRulerModel";
import { bandRect, scrollBy, waveColumns, xToTime, zoomAt, type PeakMips, type WaveBand } from "./waveformModel";
import "./timelineComponents.css";

export interface WaveformProps {
  readonly mips: PeakMips | null;
  readonly view: TimeSpan;
  /** The sample's length, seconds (zoom and scroll stay inside it). */
  readonly length: number;
  readonly bands?: readonly WaveBand[];
  /** The waveform's colour token (default `--accent`). */
  readonly color?: string;
  /** Px; default fills its box. */
  readonly height?: number;
  /** What it says while the peaks load or when there are none. */
  readonly placeholder?: string;
  readonly label?: string;
  onView?(view: TimeSpan): void;
  onPress?(t: number, e: PointerEvent): void;
  onDoubleClick?(t: number, e: MouseEvent): void;
  onHover?(t: number | null): void;
  readonly children?: ComponentChildren;
}

function draw(canvas: HTMLCanvasElement, props: WaveformProps, width: number): void {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  const h = canvas.clientHeight || props.height || 80;
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
  const cols = waveColumns(props.mips, props.view, width);
  g.fillStyle = style.getPropertyValue(props.color ?? "--accent").trim() || "teal";
  for (let x = 0; x < cols.min.length; x++) {
    const lo = cols.min[x], hi = cols.max[x];
    if (Number.isNaN(lo)) continue;
    const y0 = mid - hi * mid * 0.95, y1 = mid - lo * mid * 0.95;
    g.fillRect(x, y0, 1, Math.max(1, y1 - y0));
  }
}

export function Waveform(props: WaveformProps) {
  const box = useRef<HTMLDivElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const width = useElementWidth(box);
  useEffect(() => {
    if (canvas.current && width > 0) draw(canvas.current, props, width);
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
      role="img"
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
    </div>
  );
}
