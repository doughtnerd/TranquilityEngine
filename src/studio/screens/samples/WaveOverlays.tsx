// What the Samples audio lane draws over (or instead of) the waveform (spec §4.1.6, the prototype's lane): the other
// version as a 1 px outline (the source under a render, or the edits under A/B), red clip ticks where the shown audio
// reaches full scale, the effect chips along the top (one per baked effect, Norm, A/B · source, Frozen, Clips), and the
// Spectrogram view (`samplePeaks.ts`), drawn in the accent colour in eight steps of strength. Colours are theme tokens
// read when they draw.
import { useEffect, useRef } from "preact/hooks";
import type { Effect } from "../../../engine/audio/effects/types";
import { effectSpec } from "../../../engine/audio/effects/catalogue";
import { useElementSize } from "../../components/useElementSize";
import type { TimeSpan } from "../../components/timeRulerModel";
import { envelopeRuns, waveColumns, type PeakMips } from "../../components/waveformModel";
import { spectrogram, type PcmFrames } from "./samplePeaks";

const ENVELOPE_SCALE = 0.92;

function canvasFor(c: HTMLCanvasElement, width: number, height: number): CanvasRenderingContext2D | null {
  const dpr = typeof devicePixelRatio === "number" ? devicePixelRatio : 1;
  c.width = Math.max(1, Math.round(width * dpr));
  c.height = Math.max(1, Math.round(height * dpr));
  const g = c.getContext("2d");
  g?.setTransform(dpr, 0, 0, dpr, 0, 0);
  g?.clearRect(0, 0, width, height);
  return g;
}

const token = (el: Element, name: string, fallback: string) => getComputedStyle(el).getPropertyValue(name).trim() || fallback;

/** The other version's envelope as a 1 px outline in --text at 60 %. */
export function WaveOutline(props: { mips: PeakMips | null; view: TimeSpan }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(box);
  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0 || height <= 0) return;
    const g = canvasFor(c, width, height);
    if (!g) return;
    g.strokeStyle = token(c, "--text", "white");
    g.globalAlpha = 0.6;
    g.lineWidth = 1;
    const mid = height / 2, amp = mid * ENVELOPE_SCALE;
    for (const run of envelopeRuns(waveColumns(props.mips, props.view, width))) {
      for (const sign of [-1, 1]) {
        g.beginPath();
        run.amps.forEach((a, i) => (i === 0 ? g.moveTo(run.x + i + 0.5, mid + sign * a * amp) : g.lineTo(run.x + i + 0.5, mid + sign * a * amp)));
        g.stroke();
      }
    }
  });
  return (
    <div ref={box} class="smp-overlay" aria-hidden="true">
      <canvas ref={ref} />
    </div>
  );
}

/** Columns (px) where `mips` reaches full scale in `view`, merged into runs. */
export function clipRuns(mips: PeakMips | null, view: TimeSpan, width: number): { x: number; w: number }[] {
  const cols = waveColumns(mips, view, width);
  const out: { x: number; w: number }[] = [];
  for (let x = 0; x < cols.max.length; x++) {
    const hot = cols.max[x]! >= 0.999 || cols.min[x]! <= -0.999;
    if (!hot) continue;
    const last = out[out.length - 1];
    if (last && last.x + last.w >= x) last.w = x - last.x + 1;
    else out.push({ x, w: 1 });
  }
  return out;
}

/** Red ticks along the top and bottom edges where the shown audio clips. */
export function ClipTicks(props: { runs: readonly { x: number; w: number }[] }) {
  return (
    <div class="smp-overlay" aria-hidden="true">
      {props.runs.map((r) => (
        <span key={r.x} class="smp-clip" style={{ left: `${r.x}px`, width: `${Math.max(2, r.w)}px` }} />
      ))}
    </div>
  );
}

/** The spectrum of `pcm` over `view`: one column per 4 px, 40 log-spaced bands, --accent in eight strengths. */
export function SpectrogramView(props: { pcm: PcmFrames | null; view: TimeSpan }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const box = useRef<HTMLDivElement>(null);
  const { width, height } = useElementSize(box);
  useEffect(() => {
    const c = ref.current;
    if (!c || width <= 0 || height <= 0) return;
    const g = canvasFor(c, width, height);
    if (!g || !props.pcm) return;
    const columns = Math.max(1, Math.floor(width / 4));
    const bands = 40;
    const s = spectrogram(props.pcm, props.view.start, props.view.end, columns, bands);
    g.fillStyle = token(c, "--accent", "teal");
    const cw = width / columns, bh = height / bands;
    for (let col = 0; col < columns; col++) {
      for (let b = 0; b < bands; b++) {
        const v = s.level[col * bands + b]!;
        const step = Math.round(v * 8);
        if (step === 0) continue;
        g.globalAlpha = [0, 0.1, 0.2, 0.3, 0.42, 0.54, 0.68, 0.82, 0.95][step]!;
        g.fillRect(col * cw, height - (b + 1) * bh, Math.ceil(cw), Math.ceil(bh));
      }
    }
    g.globalAlpha = 1;
  });
  return (
    <div ref={box} class="smp-spectrogram" role="img" aria-label="Spectrogram">
      <canvas ref={ref} />
      {!props.pcm && <div class="tl-wave-placeholder">Reading the audio…</div>}
    </div>
  );
}

/** An effect's chip text ("HP 90", "Comp 3:1", "Gain +2 dB", "+3 st", "Fades", "EQ"). */
export function effectChip(f: Effect): string {
  const p = (name: string) => (typeof f.params[name] === "number" ? (f.params[name] as number) : null);
  const sign = (v: number) => `${v > 0 ? "+" : ""}${Math.round(v * 10) / 10}`;
  switch (f.type) {
    case "highpass":
      return p("cutoff") !== null ? `HP ${Math.round(p("cutoff")!)}` : "HP";
    case "lowpass":
      return p("cutoff") !== null ? `LP ${Math.round(p("cutoff")!)}` : "LP";
    case "compressor":
      return p("ratio") !== null ? `Comp ${Math.round(p("ratio")! * 10) / 10}:1` : "Comp";
    case "gain":
      return p("gain") !== null ? `Gain ${sign(p("gain")!)} dB` : "Gain";
    case "pitchShift":
      return p("semitones") !== null ? `${sign(p("semitones")!)} st` : "Pitch";
    case "saturation":
      return "Sat";
    case "noiseReduction":
      return "NR";
    case "reverse":
      return "⇄ Rev";
    default:
      return effectSpec(f.type).label;
  }
}

export interface FxChip {
  readonly id: string;
  readonly label: string;
  readonly tip: string;
  readonly tone?: "on" | "off" | "info" | "danger";
  run?(): void;
}

/** The chips across the top of the lane. */
export function FxChips(props: { chips: readonly FxChip[]; onHover?(id: string | null): void }) {
  if (props.chips.length === 0) return null;
  return (
    <div class="smp-fxs" role="group" aria-label="Effects on this sample" onPointerDown={(e) => e.stopPropagation()} onDblClick={(e) => e.stopPropagation()}>
      {props.chips.map((c) => (
        <button key={c.id} type="button" class={`smp-fxc${c.tone ? ` ${c.tone}` : ""}`} title={c.tip} onClick={c.run} disabled={!c.run}
          onPointerEnter={() => props.onHover?.(c.id)} onPointerLeave={() => props.onHover?.(null)}>
          {c.label}
        </button>
      ))}
    </div>
  );
}
