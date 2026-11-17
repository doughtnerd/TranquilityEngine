// The audio debug panel (ADR 0157, A2.5): `Audio.debug()` while the game plays, about four times a second. Shows the
// status, the backend, the counters, each bus's gain, peak and voices, the spatial, music and mix sections, and the most
// audible voices (with a count of the rest by state), grouped under their event instance (ADR 0158). "Not playing"
// otherwise. Every sample goes to one `AudioDebugMonitor` (ADR 0220), which owns the rates, the sticky health and the
// totals; the panel draws its `view()`.
import { useEffect, useRef, useState } from "preact/hooks";
import { Audio } from "../runtime/Audio";
import { editor, Panel } from "../../../editor/sdk";
import { AudioDebugMonitor, type AudioDebugView, type Cell, type Column, type Row, type Section } from "./audioDebugMonitor";
import { occlusionOverlayOn } from "./OcclusionOverlay";
import "./audioDebugPanel.css";

/** The panel reads `Audio.debug()` this often while playing (not every frame). */
const REFRESH_MS = 250;

/** A cell as a table cell: its health becomes `data-health` (the CSS colours it from the theme tokens). */
const cellView = (c: Cell, key?: number) => (
  <td key={key} title={c.tip} data-health={c.health}>
    {c.text}
  </td>
);

/** A header row; a column without a tooltip has no title. */
const headView = (columns: readonly Column[]) => (
  <thead>
    <tr>
      {columns.map((c) => (
        <th key={c.label} scope="col" title={c.tip || undefined}>
          {c.label}
        </th>
      ))}
    </tr>
  </thead>
);

/** One section: a label/value list, or a table when it has columns. */
function SectionView({ section }: { section: Section }) {
  return (
    <>
      <h5 title={section.tip}>{section.title}</h5>
      {section.rows.length === 0 ? (
        section.empty ? <p class="audio-debug-empty">{section.empty}</p> : null
      ) : section.columns ? (
        <div class="audio-debug-scroll">
          <table class="audio-debug-table audio-debug-wide" aria-label={section.title}>
            {headView(section.columns)}
            <tbody>
              {section.rows.map((r) => (
                <tr key={r.id}>{r.cells.map((c, i) => cellView(c, i))}</tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <table class="audio-debug-summary" aria-label={section.title}>
          <tbody>
            {section.rows.map((r) => (
              <tr key={r.id} data-row={r.id}>
                <td title={r.cells[0]!.tip}>{r.cells[0]!.text}</td>
                {cellView(r.cells[1]!)}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}

/** The voices table: each event instance's header and its voices, then the voices of no instance. */
function VoicesTable({ voices }: { voices: AudioDebugView["voices"] }) {
  const row = (r: Row, inEvent: boolean) => (
    <tr key={r.id} class={inEvent ? "audio-debug-in-event" : undefined}>
      {r.cells.map((c, i) => {
        const kind = voices.columns[i]?.kind;
        if (kind === "clip") return <td key={i} class="audio-debug-clip" title={c.tip}>{c.text}</td>;
        if (kind === "state") return <td key={i} data-state={c.text}>{c.text}</td>;
        return cellView(c, i);
      })}
    </tr>
  );
  return (
    <div class="audio-debug-scroll">
      <table class="audio-debug-table audio-debug-voices" aria-label="Voices">
        {headView(voices.columns)}
        <tbody>
          {voices.groups.flatMap((g) => [
            <tr key={`e${g.id}`} class="audio-debug-event">
              <td colSpan={voices.columns.length} title={g.name}>
                <span class="audio-debug-event-name">{g.name}</span>
                <span class="audio-debug-event-meta">{g.meta}</span>
              </td>
            </tr>,
            ...g.voices.map((v) => row(v, true)),
          ])}
          {voices.ungrouped.map((v) => row(v, false))}
        </tbody>
      </table>
    </div>
  );
}

export function AudioDebugPanel() {
  const isPlaying = editor.scene.playState === "playing";
  const [view, setView] = useState<AudioDebugView | null>(null);
  // The rate-based and sticky health needs every sample; a new Play starts a new monitor.
  const monitor = useRef(new AudioDebugMonitor());
  useEffect(() => {
    if (!isPlaying) {
      setView(null);
      return;
    }
    monitor.current = new AudioDebugMonitor();
    const sample = () => {
      monitor.current.observe(Audio.debug());
      setView(monitor.current.view());
    };
    sample();
    const t = setInterval(sample, REFRESH_MS);
    return () => clearInterval(t);
  }, [isPlaying]);
  if (!isPlaying || !view) {
    return (
      <Panel>
        <section class="audio-debug" aria-label="Audio">
          <p class="audio-debug-empty">Not playing</p>
        </section>
      </Panel>
    );
  }
  return (
    <Panel>
      <section class="audio-debug" aria-label="Audio">
        <h4>
          Audio <span class="audio-debug-status" data-status={view.status}>{view.status}</span>
        </h4>
        <table class="audio-debug-summary">
          <tbody>
            {view.summary.map((r) => (
              <tr key={r.id}>
                <td title={r.cells[0]!.tip}>{r.cells[0]!.text}</td>
                <td>{r.cells[1]!.text}</td>
              </tr>
            ))}
          </tbody>
        </table>

        <h5>Buses</h5>
        <table class="audio-debug-table" aria-label="Buses">
          {headView(view.buses.columns)}
          <tbody>
            {view.buses.rows.map((r) => (
              <tr key={r.id}>{r.cells.map((c, i) => cellView(c, i))}</tr>
            ))}
          </tbody>
        </table>

        <label class="audio-debug-toggle" title="Draw a line from each occluded source to the listener in the scene view, with a marker where it hits a wall, coloured by how much it muffles">
          <input type="checkbox" checked={occlusionOverlayOn.value} onChange={(e) => (occlusionOverlayOn.value = (e.currentTarget as HTMLInputElement).checked)} /> Show occlusion rays in the scene view
        </label>
        {view.sections.map((s) => (
          <SectionView key={s.id} section={s} />
        ))}

        <h5>{view.voices.title}</h5>
        {view.voices.empty ? <p class="audio-debug-empty">{view.voices.empty}</p> : <VoicesTable voices={view.voices} />}
        {view.voices.more ? <p class="audio-debug-more">{view.voices.more}</p> : null}
      </section>
    </Panel>
  );
}
