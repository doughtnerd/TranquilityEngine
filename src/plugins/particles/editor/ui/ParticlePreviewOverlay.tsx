import { useEffect, useState } from "preact/hooks";
import { particlePreview, previewStats, restartPreview, selectedParticleSystem } from "../particlePreview";
import { editor } from "../../../../editor/sdk";
import "./particlePreview.css";

const SPEEDS = [0.1, 0.25, 0.5, 1, 2, 4];

/**
 * The scene view's particle controls (ADR 0057; a Scene panel extension of the Particles plugin, ADR 0144), shown while a ParticleSystem node is selected (or
 * Simulate All is on) in edit mode: play or pause, restart, speed, Simulate All, and the previewed
 * effect's time and particle count.
 */
export function ParticlePreviewOverlay() {
  const node = selectedParticleSystem.value;
  const p = particlePreview.value;
  const [stats, setStats] = useState<{ time: number; count: number } | null>(null);
  const shown = editor.scene.playState === "edit" && (node !== null || p.simulateAll);
  useEffect(() => {
    if (!shown) return;
    const timer = setInterval(() => setStats(previewStats()), 200);
    return () => clearInterval(timer);
  }, [shown]);
  if (!shown) return null;
  const set = (patch: Partial<typeof p>) => (particlePreview.value = { ...p, ...patch });
  return (
    <div class="particle-preview" role="toolbar" aria-label="Particle preview">
      <span class="particle-preview-title">{node?.name ?? "Particles"}</span>
      <button aria-pressed={!p.playing} onClick={() => set({ playing: !p.playing })} title={p.playing ? "Pause the preview" : "Play the preview"}>
        {p.playing ? "Pause" : "Play"}
      </button>
      <button onClick={restartPreview} title="Restart the effect">
        Restart
      </button>
      <select aria-label="Particle preview speed" value={String(p.speed)} onChange={(e) => set({ speed: Number((e.currentTarget as HTMLSelectElement).value) })}>
        {SPEEDS.map((s) => (
          <option key={s} value={String(s)}>
            {s}×
          </option>
        ))}
      </select>
      <label title="Play every particle system in the scene, not only the selected one">
        <input type="checkbox" checked={p.simulateAll} onChange={(e) => set({ simulateAll: (e.currentTarget as HTMLInputElement).checked })} />
        Simulate All
      </label>
      <span class="particle-preview-stats" aria-label="Particle preview stats">
        {stats ? `${stats.time.toFixed(1)} s · ${stats.count} particles` : "—"}
      </span>
    </div>
  );
}
