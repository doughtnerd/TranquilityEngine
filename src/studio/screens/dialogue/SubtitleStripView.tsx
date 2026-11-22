// The subtitle strip (ADR 0343 §6): a line's subtitle pages over time beside the heard audio, each page's characters
// per second, and warnings (reading speed, too many lines, a line too long). Kit-drawn from the pure model; a timing and
// length preview (the editor's Play is the exact one). A view over props.
import type { SubtitleStrip } from "./subtitleStrip";

export function SubtitleStripView(props: { readonly strip: SubtitleStrip; readonly speaker?: string | null }) {
  const s = props.strip;
  const span = Math.max(s.shown, s.duration, 0.001);
  const pct = (t: number) => `${(t / span) * 100}%`;
  return (
    <div class="dl-strip-wrap" aria-label={`Subtitle timing in ${s.language}`} role="group">
      <div class="dl-strip">
        {s.duration > 0 && <span class="dl-strip-audio" style={{ width: pct(s.duration) }} title={`Audio ${s.duration.toFixed(2)} s`} />}
        {s.pages.map((p, i) => (
          <span key={i} class={`dl-strip-page${p.fast ? " fast" : ""}`} style={{ left: pct(p.start), width: pct(p.end - p.start) }} title={`${p.text}\n${p.start.toFixed(2)}–${p.end.toFixed(2)} s · ${Math.round(p.cps)} cps`}>
            {i === 0 && props.speaker ? `${props.speaker}: ` : ""}{p.text}
          </span>
        ))}
      </div>
      <div class="dl-strip-legend">
        {s.pages.map((p, i) => <span key={i}>Page {i + 1}: {Math.round(p.cps)} cps</span>)}
        <span>max {Math.round(s.rule.speed)} cps</span>
      </div>
      {s.warnings.length > 0 && (
        <ul class="dl-list dl-warn" aria-label={`Subtitle warnings in ${s.language}`}>
          {s.warnings.map((w) => <li key={w}>{w}</li>)}
        </ul>
      )}
    </div>
  );
}
