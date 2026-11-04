import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { loadParticleEffectPreview, type ParticleEffectPreview, type PreviewBackground } from "../../../engine/editor";
import { compileParticleGraph } from "../../../engine/scene/particleCompile";
import type { ParticleGraph } from "../../../engine/scene/particleGraph";
import "./preview.css";

const SPEEDS = [0.25, 0.5, 1, 2];
const BACKGROUNDS: PreviewBackground[] = ["grid", "dark", "light"];
const REBUILD_DELAY = 100;

/** Live preview of a particle graph (ADR 0060): recompiled shortly after the graph changes. */
export function ParticleGraphPreview(props: { graph: ParticleGraph; problems?: number }): JSX.Element {
  const host = useRef<HTMLDivElement>(null);
  const preview = useRef<ParticleEffectPreview | null>(null);
  const [playing, setPlaying] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [loop, setLoop] = useState(true);
  const [background, setBackground] = useState<PreviewBackground>("grid");
  const [stats, setStats] = useState({ particles: 0, time: 0 });
  const pending = useRef<ParticleGraph | null>(null);

  useEffect(() => {
    let p: ParticleEffectPreview | null = null;
    let poll = 0;
    let gone = false;
    void loadParticleEffectPreview().then(({ ParticleEffectPreview }) => {
      if (gone || !host.current) return;
      const made = new ParticleEffectPreview(host.current);
      p = made;
      made.onChange = () => setPlaying(made.playing);
      preview.current = made;
      if (pending.current) made.setProgram(compileParticleGraph(pending.current));
      poll = window.setInterval(() => setStats((s) => {
        const n = made.stats;
        const time = Math.round(n.time * 10) / 10;
        return s.particles === n.particles && s.time === time ? s : { particles: n.particles, time };
      }), 120);
    });
    return () => {
      gone = true;
      window.clearInterval(poll);
      p?.dispose();
      preview.current = null;
    };
  }, []);

  useEffect(() => {
    pending.current = props.graph;
    const t = window.setTimeout(() => {
      try {
        preview.current?.setProgram(compileParticleGraph(props.graph));
      } catch (err) {
        console.warn("[myco] particle preview:", err);
      }
    }, REBUILD_DELAY);
    return () => window.clearTimeout(t);
  }, [props.graph]);

  useEffect(() => { if (preview.current) preview.current.speed = speed; }, [speed]);
  useEffect(() => { if (preview.current) preview.current.looping = loop; }, [loop]);
  useEffect(() => { if (preview.current) preview.current.background = background; }, [background]);

  const toggle = () => {
    const p = preview.current;
    if (!p) return;
    if (p.playing) p.pause();
    else p.play();
  };
  const nextBackground = () => setBackground((b) => BACKGROUNDS[(BACKGROUNDS.indexOf(b) + 1) % BACKGROUNDS.length]);

  return (
    <div class="pg-preview">
      <div class="pg-preview-canvas" ref={host} />
      <div class="pg-preview-bar" role="toolbar" aria-label="Preview controls">
        <button type="button" aria-label="Preview play" aria-pressed={playing} title={playing ? "Pause" : "Play"} onClick={toggle}>{playing ? "Pause" : "Play"}</button>
        <button type="button" aria-label="Preview restart" title="Restart" onClick={() => preview.current?.restart()}>Restart</button>
        <select aria-label="Preview speed" title="Speed" value={String(speed)} onChange={(e) => setSpeed(Number((e.currentTarget as HTMLSelectElement).value))}>
          {SPEEDS.map((s) => <option key={s} value={String(s)}>{s}×</option>)}
        </select>
        <button type="button" class={loop ? "on" : ""} aria-label="Preview loop" aria-pressed={loop} title="Repeat one-shot effects" onClick={() => setLoop(!loop)}>Loop</button>
        <button type="button" aria-label="Preview background" title="Background" onClick={nextBackground}>{background}</button>
      </div>
      <div class="pg-preview-stats" aria-label="Preview stats" aria-live="off">
        {stats.particles} particles · {stats.time.toFixed(1)}s
        {props.problems ? <span class="pg-preview-problems"> · {props.problems} problem{props.problems === 1 ? "" : "s"}</span> : null}
      </div>
    </div>
  );
}
