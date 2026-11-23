// The Loop seam panel (the prototype's): the selected (or first) loop's end followed by its start, with the
// equal-power crossfade applied (`seam.ts`), the level jump across the seam (amber above 3 dB), the crossfade length,
// and Play across the seam (the loop cycling, through the audio host).
import { useEffect, useRef } from "preact/hooks";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import * as act from "./sampleActions";
import { isHold, loopName, updateLoop } from "./sampleEditing";
import { lengthOf, pcmNow } from "./sampleSession";
import { SEAM_WARN_DB, liveSelection } from "./sampleView";
import { seamJump, seamStrip } from "./seam";
import { openSession, selection } from "./samplesState";

const POINTS = 480;

export function SeamPanel() {
  const session = openSession.value;
  const canvas = useRef<HTMLCanvasElement>(null);
  const length = session ? lengthOf(session.project, session.source.value) : null;
  const e = session?.edits.value;
  const sel = e && length !== null ? liveSelection(selection.value, e, length) : null;
  const loop = e ? (sel?.kind === "loop" ? e.loops.find((l) => l.id === sel.id) : undefined) ?? e.loops.find((l) => !isHold(l)) : undefined;
  const pcm = session && loop ? pcmNow(session.project, session.source.value) : null;
  const strip = pcm && loop && !isHold(loop) ? seamStrip(pcm, loop.start, loop.end, loop.crossfadeMs, POINTS) : null;
  useEffect(() => {
    const c = canvas.current;
    if (!c || !strip) return;
    const w = (c.width = c.clientWidth * (devicePixelRatio || 1));
    const h = (c.height = c.clientHeight * (devicePixelRatio || 1));
    const g = c.getContext("2d");
    if (!g) return;
    const style = getComputedStyle(c);
    g.clearRect(0, 0, w, h);
    g.strokeStyle = style.getPropertyValue("--accent").trim() || "teal";
    g.lineWidth = Math.max(1, devicePixelRatio || 1);
    g.beginPath();
    strip.values.forEach((v, i) => {
      const x = (i / (strip.values.length - 1)) * w, y = h / 2 - v * (h / 2) * 0.9;
      if (i === 0) g.moveTo(x, y);
      else g.lineTo(x, y);
    });
    g.stroke();
    g.fillStyle = style.getPropertyValue("--range-loop").trim() || "cyan";
    g.fillRect((strip.seam / (strip.values.length - 1)) * w, 0, Math.max(1, devicePixelRatio || 1), h);
  });
  if (!session || !e || !loop || isHold(loop)) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="Loop seam" body="Select a loop to see its end joined to its start, and how its crossfade smooths the seam." />
      </Panel>
    );
  }
  const jump = pcm ? seamJump(pcm, loop.start, loop.end) : null;
  const warn = jump !== null && Math.abs(jump) > SEAM_WARN_DB && loop.direction !== "pingPong";
  return (
    <Panel class="smp-seam">
      <div class="smp-seam-head">
        <b>{loopName(e, loop.id)}</b>
        <span class={warn ? "smp-warning" : "smp-ok"} role="status">
          {jump === null ? "Reading the audio…" : loop.direction === "pingPong" ? "Ping-pong: no seam" : `Level jump ${jump > 0 ? "+" : ""}${jump.toFixed(1)} dB`}
        </span>
        <label>
          Crossfade{" "}
          <input type="number" min={0} max={500} value={loop.crossfadeMs} aria-label="Crossfade in ms" disabled={session.readOnly} onChange={(ev) => session.commit(updateLoop(e, loop.id, { crossfadeMs: Number((ev.currentTarget as HTMLInputElement).value) }))} /> ms
        </label>
        <button onClick={() => act.togglePlay({ kind: "loop", id: loop.id })}>Play across the seam</button>
      </div>
      <canvas ref={canvas} class="smp-seam-strip" role="img" aria-label={`The end of ${loopName(e, loop.id)} then its start, ${strip ? Math.round(strip.window * 1000) : 0} ms each side`} />
      <div class="smp-seam-scale smp-muted">
        <span>end − {strip ? Math.round(strip.window * 1000) : "…"} ms</span>
        <span>seam</span>
        <span>start + {strip ? Math.round(strip.window * 1000) : "…"} ms</span>
      </div>
    </Panel>
  );
}
