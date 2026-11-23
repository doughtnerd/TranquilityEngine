// The Loop seam panel (spec §4.1.8, the prototype's): the selected (or first) loop's end flowing into its start, ±N ms
// around the seam (`seam.ts`), so a click shows and can be heard. Header: Play across the seam (the loop's last moment
// into its first, `planSeam`), Repeat, and chips for At (the seam playhead, relative to the seam), Level jump (lime,
// amber over 3 dB), Crossfade (editable) and Loop length. The strip: the loop end's half tinted, labels "loop end" and
// "loop start", the waveform with the crossfade applied, the amber equal-power crossfade curves, the seam line and the
// lime seam playhead; click or drag to scrub across the seam (the main playhead follows). A ruler beneath follows the
// Time display.
import { useEffect, useRef, useState } from "preact/hooks";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { Icon } from "../../components/Icon";
import { NumberField } from "../../components/NumberField";
import { formatTime } from "../../components/timeRulerModel";
import * as act from "./sampleActions";
import { isHold, loopName, updateLoop } from "./sampleEditing";
import { SampleIcon } from "./sampleIcons";
import { lengthOf, pcmNow } from "./sampleSession";
import { SEAM_WARN_DB, liveSelection } from "./sampleView";
import { equalPower, seamJump, seamStrip } from "./seam";
import { openSession, playheadTime, seamRepeat, selection, timeFormat } from "./samplesState";
import { playing, SEAM_SCOPE } from "./sampleTransport";

const POINTS = 600;

/** A seam offset (seconds from the seam) as the ruler and the At chip write it. */
function offsetText(rel: number, fmt: string, rate: number, bpm?: number): string {
  const sign = rel < 0 ? "−" : rel > 0 ? "+" : "";
  const a = Math.abs(rel);
  if (fmt === "samples") return `${sign}${Math.round(a * rate).toLocaleString("en")} smp`;
  if (fmt === "bars" && bpm) return `${sign}${Math.round(a * (bpm / 60) * 960)} ticks`;
  return `${sign}${Math.round(a * 1000)} ms`;
}

export function SeamPanel() {
  const session = openSession.value;
  const canvas = useRef<HTMLCanvasElement>(null);
  const [scrubRel, setScrubRel] = useState<number | null>(null);
  const length = session ? lengthOf(session.project, session.source.value) : null;
  const e = session?.edits.value;
  const sel = e && length !== null ? liveSelection(selection.value, e, length) : null;
  const loop = e ? (sel?.kind === "loop" ? e.loops.find((l) => l.id === sel.id) : undefined) ?? e.loops.find((l) => !isHold(l)) : undefined;
  const pcm = session && loop ? pcmNow(session.project, session.source.value) : null;
  const strip = pcm && loop && !isHold(loop) ? seamStrip(pcm, loop.start, loop.end, loop.crossfadeMs, POINTS) : null;
  // The seam playhead: where the main playhead is, when it's within the window on either side of the seam.
  const t = playheadTime.value;
  const w = strip?.window ?? 0;
  const live = loop && strip ? (t >= loop.end - w && t <= loop.end ? t - loop.end : t >= loop.start && t <= loop.start + w ? t - loop.start : null) : null;
  const rel = live ?? scrubRel ?? -w;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !strip || !loop) return;
    const dpr = devicePixelRatio || 1;
    const cw = c.clientWidth, ch = c.clientHeight;
    c.width = Math.max(1, Math.round(cw * dpr));
    c.height = Math.max(1, Math.round(ch * dpr));
    const g = c.getContext("2d");
    if (!g) return;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, cw, ch);
    const style = getComputedStyle(c);
    const tok = (n: string, f: string) => style.getPropertyValue(n).trim() || f;
    const mid = ch / 2;
    // The loop end's half, tinted.
    g.fillStyle = tok("--accent-faint", "rgba(0,200,200,.08)");
    g.fillRect(0, 0, cw / 2, ch);
    // The waveform: a filled envelope in --badge-text at .55.
    g.fillStyle = tok("--badge-text", "teal");
    g.globalAlpha = 0.55;
    g.beginPath();
    const n = strip.values.length;
    for (let i = 0; i < n; i++) g.lineTo((i / (n - 1)) * cw, mid - Math.abs(strip.values[i]) * mid * 0.9);
    for (let i = n - 1; i >= 0; i--) g.lineTo((i / (n - 1)) * cw, mid + Math.abs(strip.values[i]) * mid * 0.9);
    g.closePath();
    g.fill();
    g.globalAlpha = 1;
    // The equal-power crossfade curves, amber, crossing at the seam.
    const xf = Math.min(strip.window, loop.crossfadeMs / 1000) / 2;
    if (xf > 0) {
      g.strokeStyle = tok("--warning", "orange");
      g.lineWidth = 1.5;
      const x0 = cw / 2 - (xf / strip.window) * (cw / 2), x1 = cw / 2 + (xf / strip.window) * (cw / 2);
      for (const which of ["out", "in"] as const) {
        g.beginPath();
        for (let k = 0; k <= 40; k++) {
          const gain = equalPower(k / 40)[which];
          const x = x0 + (k / 40) * (x1 - x0), y = ch - 4 - gain * (ch - 8);
          if (k === 0) g.moveTo(x, y);
          else g.lineTo(x, y);
        }
        g.stroke();
      }
    }
    // The seam.
    g.fillStyle = tok("--accent", "teal");
    g.fillRect(cw / 2 - 1, 0, 2, ch);
  });
  if (!session || !e || !loop || isHold(loop)) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="No loop" icon={<Icon name="loop" size={28} />} body="No loop on this file. Add one with Add loop in the toolbar to tune its seam here." />
      </Panel>
    );
  }
  const jump = pcm ? seamJump(pcm, loop.start, loop.end) : null;
  const p = playing.value;
  const seamPlaying = !!p && p.path === session.path && p.plan.scope === SEAM_SCOPE;
  const pingPong = loop.direction === "pingPong";
  const warn = jump !== null && Math.abs(jump) > SEAM_WARN_DB && !pingPong;
  const fmt = timeFormat.value;
  const rate = pcm?.rate ?? 48000;
  const bpm = e.tempo?.bpm;
  const several = e.loops.filter((l) => !isHold(l)).length > 1;
  const loopLen = loop.end - loop.start;
  const scrubTo = (clientX: number, el: HTMLElement) => {
    if (!strip) return;
    const r = el.getBoundingClientRect();
    const x = Math.max(0, Math.min(1, (clientX - r.left) / r.width));
    const v = (x * 2 - 1) * strip.window;
    setScrubRel(v);
    act.movePlayhead(v < 0 ? loop.end + v : loop.start + v, false);
  };
  return (
    <Panel class="smp-seam" toolbar={
      <div class="smp-seam-head">
        <button type="button" class="smp-ibtn" aria-pressed={seamPlaying} aria-label={seamPlaying ? "Stop" : "Play across the seam"} title="Play across the seam: the end of the loop into its start, repeating" onClick={() => act.playSeam(loop.id)}>
          <Icon name={seamPlaying ? "stop" : "play"} size={12} />
        </button>
        <button type="button" class={`smp-sbtn${seamRepeat.value ? " on" : ""}`} aria-pressed={seamRepeat.value} aria-label="Repeat" title="Repeat: keep cycling through the seam" onClick={() => (seamRepeat.value = !seamRepeat.value)}>
          <SampleIcon name="repeat" size={12} />
        </button>
        <span class="smp-chip" title="The seam playhead, relative to the seam">At <b>{offsetText(rel, fmt, rate, bpm)}</b></span>
        <span class={`smp-chip${warn ? " warn" : jump !== null && !pingPong ? " ok" : ""}`} role="status" title={pingPong ? "Ping-pong turns around: there is no seam" : warn ? "The level jumps across the seam: it may click; lengthen the crossfade" : "The levels match across the seam"}>
          Level jump <b>{jump === null ? "…" : pingPong ? "none" : `${jump > 0 ? "+" : jump < 0 ? "−" : ""}${Math.abs(jump).toFixed(1)} dB`}</b>
        </span>
        <span class="smp-chip smp-chip-edit">
          <NumberField label="Crossfade" value={loop.crossfadeMs} min={0} max={500} step={1} unit="ms" size="narrow" disabled={session.readOnly} onValue={(v, live) => session.commit(updateLoop(session.edits.peek(), loop.id, { crossfadeMs: Math.round(v) }), { coalesce: live })} />
        </span>
        <span class="smp-chip" title="The loop's length">Loop length <b>{fmt === "timecode" ? `${loopLen.toFixed(3)} s` : formatTime(loopLen, fmt, { rate, bpm, meter: e.tempo?.meter })}</b></span>
        {e.snapToZero && <span class="smp-muted smp-seam-zc">Points snap to zero crossings</span>}
      </div>
    }>
      <div class="smp-seam-body">
        <div class="smp-seam-th">{several ? `${loopName(e, loop.id)} end → start` : "Loop end → start"}</div>
        <div class="smp-seam-lane">
          <div
            class="smp-seam-strip"
            role="slider"
            tabIndex={0}
            aria-label="Seam playhead"
            aria-valuemin={-(strip?.window ?? 0)}
            aria-valuemax={strip?.window ?? 0}
            aria-valuenow={rel}
            aria-valuetext={offsetText(rel, fmt, rate, bpm)}
            title="Click or drag to scrub across the seam"
            onPointerDown={(ev) => {
              if (ev.button !== 0) return;
              const el = ev.currentTarget as HTMLElement;
              el.setPointerCapture(ev.pointerId);
              scrubTo(ev.clientX, el);
            }}
            onPointerMove={(ev) => (ev.currentTarget as HTMLElement).hasPointerCapture(ev.pointerId) && scrubTo(ev.clientX, ev.currentTarget as HTMLElement)}
            onKeyDown={(ev) => {
              if (!strip || (ev.key !== "ArrowLeft" && ev.key !== "ArrowRight")) return;
              ev.preventDefault();
              const v = Math.max(-strip.window, Math.min(strip.window, rel + (ev.key === "ArrowLeft" ? -1 : 1) * (ev.shiftKey ? 0.01 : 0.001)));
              setScrubRel(v);
              act.movePlayhead(v < 0 ? loop.end + v : loop.start + v, false);
            }}
          >
            <canvas ref={canvas} aria-hidden="true" />
            <span class="smp-seam-label left">loop end</span>
            <span class="smp-seam-label right">loop start</span>
            {strip && <span class="smp-seam-ph" style={{ left: `${(((rel / strip.window) + 1) / 2) * 100}%` }} aria-hidden="true" />}
          </div>
          <div class="smp-seam-ruler smp-muted" aria-hidden="true">
            {[-1, -0.5, 0, 0.5, 1].map((k) => (
              <span key={k} style={{ left: `${((k + 1) / 2) * 100}%` }}>{k === 0 ? "seam" : offsetText(k * (strip?.window ?? 0), fmt, rate, bpm)}</span>
            ))}
          </div>
        </div>
      </div>
    </Panel>
  );
}
