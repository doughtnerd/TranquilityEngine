// The audio debug panel (ADR 0157, A2.5): `Audio.debug()` while the game plays, about four times a second. Shows the
// status, the backend, the counters, each bus's gain, peak and voices, and the most audible voices (with a count of the
// rest by state). Voices that belong to an event instance (ADR 0158) are grouped under it, with its parameters; the
// panel also counts the continuous-container clips started a frame late. "Not playing" otherwise.
import { useEffect, useRef, useState } from "preact/hooks";
import { Audio } from "../runtime/Audio";
import type { AudioDebugInfo } from "../runtime/backend";
import type { AudioDebugState } from "../runtime/Audio";
import type { EventDebugRow } from "../runtime/events/eventRuntime";
import { editor } from "../../../editor/sdk";
import { CounterWatch, VOICE_COLUMNS, debugSections, voiceCells, type Cell, type Section } from "./audioDebugRows";
import { occlusionOverlayOn } from "./OcclusionOverlay";
import "./audioDebugPanel.css";

/** The panel reads `Audio.debug()` this often while playing (not every frame). */
const REFRESH_MS = 250;

/**
 * At most this many voice rows. A game can hold thousands of voices (4,096 logical at the default preset); rendering a
 * row for each four times a second made the editor crawl, so the table shows the most audible ones and counts the rest.
 */
export const MAX_VOICE_ROWS = 64;

type DebugVoice = AudioDebugInfo["voices"][number];

/** The voices the table shows: the `MAX_VOICE_ROWS` most audible (ties by priority), and how many of each state are left out. */
export function voiceRows(voices: readonly DebugVoice[], max = MAX_VOICE_ROWS): { rows: DebugVoice[]; hidden: number; hiddenByState: Record<string, number> } {
  if (voices.length <= max) return { rows: voices.slice(), hidden: 0, hiddenByState: {} };
  const sorted = voices.slice().sort((a, b) => b.audibility - a.audibility || b.priority - a.priority || a.id - b.id);
  const hiddenByState: Record<string, number> = {};
  for (let i = max; i < sorted.length; i++) {
    const s = sorted[i]!.state;
    hiddenByState[s] = (hiddenByState[s] ?? 0) + 1;
  }
  return { rows: sorted.slice(0, max), hidden: sorted.length - max, hiddenByState };
}

/** A playing event instance and its voices among the rows shown. */
export interface VoiceGroup {
  event: EventDebugRow;
  voices: DebugVoice[];
}

/**
 * The shown rows split by event instance (`voices[].event` against `Audio.debug().events`): the groups in the order their
 * first voice appears, and the voices that belong to no listed instance as they were (an instance that already ended
 * counts as none).
 */
export function groupByEvent(rows: readonly DebugVoice[], events: readonly EventDebugRow[] | undefined): { groups: VoiceGroup[]; ungrouped: DebugVoice[] } {
  const byId = new Map<number, EventDebugRow>();
  for (const e of events ?? []) byId.set(e.id, e);
  const groups = new Map<number, VoiceGroup>();
  const ungrouped: DebugVoice[] = [];
  for (const v of rows) {
    const e = v.event !== undefined && v.event !== null ? byId.get(v.event) : undefined;
    if (!e) { ungrouped.push(v); continue; }
    let g = groups.get(e.id);
    if (!g) groups.set(e.id, (g = { event: e, voices: [] }));
    g.voices.push(v);
  }
  return { groups: [...groups.values()], ungrouped };
}

/** How many continuous-container clips the playing event instances started a frame late (0158 §6). */
export const lateStartCount = (events: readonly EventDebugRow[] | undefined): number => (events ?? []).reduce((n, e) => n + (e.lateStarts ?? 0), 0);

/** "Name 0.5, Other Grass": an instance's parameters on one line. */
const parameterText = (p: Record<string, number | string>): string =>
  Object.entries(p).map(([k, v]) => `${k} ${typeof v === "number" ? level(v) : v}`).join(", ");

/** Two decimals, or "0" for a value that is exactly zero. */
const level = (v: number): string => (v === 0 ? "0" : v.toFixed(2));

/** The loudest of a bus's two channels, as the panel shows a peak. */
const peakOf = (b: AudioDebugInfo["buses"][number]): number => Math.max(b.peakL, b.peakR);

/** A cell as a table cell: its health becomes `data-health` (the CSS colours it from the theme tokens). */
const cellView = (c: Cell, key?: number) => (
  <td key={key} title={c.tip} data-health={c.health}>
    {c.text}
  </td>
);

/** One M3 section: a label/value list, or a table when it has columns. */
function SectionView({ section }: { section: Section }) {
  return (
    <>
      <h5 title={section.tip}>{section.title}</h5>
      {section.rows.length === 0 ? (
        section.empty ? <p class="audio-debug-empty">{section.empty}</p> : null
      ) : section.columns ? (
        <div class="audio-debug-scroll">
          <table class="audio-debug-table audio-debug-wide" aria-label={section.title}>
            <thead>
              <tr>
                {section.columns.map((c) => (
                  <th key={c.label} scope="col" title={c.tip}>
                    {c.label}
                  </th>
                ))}
              </tr>
            </thead>
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

export function AudioDebugPanel() {
  const isPlaying = editor.scene.playState === "playing";
  const [info, setInfo] = useState<AudioDebugState | null>(null);
  // The rate-based health (overruns per second, a rise in m3Shed) needs every sample.
  const watch = useRef(new CounterWatch());
  const sample = () => {
    const next = Audio.debug();
    watch.current.observe(next);
    setInfo(next);
  };
  useEffect(() => {
    if (!isPlaying) {
      setInfo(null);
      return;
    }
    sample();
    const t = setInterval(sample, REFRESH_MS);
    return () => clearInterval(t);
  }, [isPlaying]);
  if (!isPlaying || !info) {
    return (
      <section class="audio-debug" aria-label="Audio">
        <p class="audio-debug-empty">Not playing</p>
      </section>
    );
  }
  const c = info.counters;
  const shown = voiceRows(info.voices);
  const grouped = groupByEvent(shown.rows, info.events);
  const late = lateStartCount(info.events);
  const sections = debugSections(info, watch.current);
  const section = (id: Section["id"]) => <SectionView section={sections.find((x) => x.id === id)!} />;
  const voiceRow = (v: DebugVoice, inEvent: boolean) => (
    <tr key={v.id} class={inEvent ? "audio-debug-in-event" : undefined}>
      <td class="audio-debug-clip" title={v.owner ?? "No node: a one-shot or an event voice"}>
        {v.owner ?? "-"}
      </td>
      <td class="audio-debug-clip" title={v.clip}>
        {v.clip}
      </td>
      <td>{v.bus}</td>
      <td data-state={v.state}>{v.state}</td>
      <td>{v.priority}</td>
      <td>{level(v.gain)}</td>
      {voiceCells(v).map((c, i) => cellView(c, i))}
    </tr>
  );
  return (
    <section class="audio-debug" aria-label="Audio">
      <h4>
        Audio <span class="audio-debug-status" data-status={info.status}>{info.status}</span>
      </h4>
      <table class="audio-debug-summary">
        <tbody>
          <tr>
            <td>Backend</td>
            <td>{String(info.core.backend ?? "unknown")}</td>
          </tr>
          <tr>
            <td>Sample rate</td>
            <td>{info.sampleRate} Hz</td>
          </tr>
          <tr>
            <td>Underruns</td>
            <td>{c.underruns}</td>
          </tr>
          <tr>
            <td>Logical voices</td>
            <td>{c.logicalVoices}</td>
          </tr>
          <tr>
            <td>Mixed voices</td>
            <td>
              {c.mixedVoices} / {c.mixedCap}
            </td>
          </tr>
          <tr>
            <td>HRTF voices</td>
            <td>
              {c.hrtfVoices}
              {c.hrtfLoadFailure === 1 ? " (HRTF data failed to load)" : c.hrtfLoadFailure === 2 ? " (HRTF data invalid)" : ""}
            </td>
          </tr>
          <tr>
            <td>Dropped plays</td>
            <td>{c.droppedPlays}</td>
          </tr>
          <tr>
            <td>Event instances</td>
            <td>{(info.events ?? []).length}</td>
          </tr>
          <tr>
            <td title="Clips of a continuous container started on the previous clip's end, one frame late, because their length wasn't known yet">Clips started late</td>
            <td>{late}</td>
          </tr>
        </tbody>
      </table>

      <h5>Buses</h5>
      <table class="audio-debug-table" aria-label="Buses">
        <thead>
          <tr>
            <th scope="col">Bus</th>
            <th scope="col">Gain</th>
            <th scope="col">Peak</th>
            <th scope="col">Voices</th>
            <th scope="col" title="Which ambisonic bed the bus mixes into: its own, its parent's, or none. A warning means it asked for a bed and has none.">Bed</th>
          </tr>
        </thead>
        <tbody>
          {info.buses.map((b) => (
            <tr key={b.name}>
              <td>{b.name}</td>
              <td title={`Effective ${level(b.effectiveGain)}`}>{level(b.gain)}</td>
              <td>{level(peakOf(b))}</td>
              <td>
                {b.voices}
                {b.maxVoices !== null ? ` / ${b.maxVoices}` : ""}
              </td>
              <td data-health={b.bedLost ? "warn" : undefined} title={b.bedLost ? "Asked for a bed and has none" : undefined}>
                {b.bed === undefined ? "-" : b.bedHost && b.bedHost !== b.name ? `${b.bed} (${b.bedHost})` : b.bed}
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      <label class="audio-debug-toggle" title="Draw a line from each occluded source to the listener in the scene view, with a marker where it hits a wall, coloured by how much it muffles">
        <input type="checkbox" checked={occlusionOverlayOn.value} onChange={(e) => (occlusionOverlayOn.value = (e.currentTarget as HTMLInputElement).checked)} /> Show occlusion rays in the scene view
      </label>
      {section("m3Counters")}
      {section("ladder")}
      {section("beds")}
      {section("zones")}
      {section("occlusion")}
      {section("memory")}

      <h5>Voices{shown.hidden > 0 ? ` (the ${shown.rows.length} most audible of ${info.voices.length})` : ""}</h5>
      {info.voices.length === 0 ? (
        <p class="audio-debug-empty">No voices</p>
      ) : (
        <div class="audio-debug-scroll">
        <table class="audio-debug-table audio-debug-voices" aria-label="Voices">
          <thead>
            <tr>
              <th scope="col" title="The node whose AudioSource plays the voice; - for one-shots and event voices">Source</th>
              <th scope="col">Clip</th>
              <th scope="col">Bus</th>
              <th scope="col">State</th>
              <th scope="col">Priority</th>
              <th scope="col">Gain</th>
              {VOICE_COLUMNS.map((c) => (
                <th key={c.label} scope="col" title={c.tip}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grouped.groups.flatMap((g) => [
              <tr key={`e${g.event.id}`} class="audio-debug-event">
                <td colSpan={6 + VOICE_COLUMNS.length} title={g.event.asset}>
                  <span class="audio-debug-event-name">{g.event.asset}</span>
                  <span class="audio-debug-event-meta">
                    {" "}#{g.event.id} · {g.event.voices} voice{g.event.voices === 1 ? "" : "s"}
                    {Object.keys(g.event.parameters).length > 0 ? ` · ${parameterText(g.event.parameters)}` : ""}
                    {g.event.lateStarts > 0 ? ` · ${g.event.lateStarts} late` : ""}
                  </span>
                </td>
              </tr>,
              ...g.voices.map((v) => voiceRow(v, true)),
            ])}
            {grouped.ungrouped.map((v) => voiceRow(v, false))}
          </tbody>
        </table>
        </div>
      )}
      {shown.hidden > 0 ? (
        <p class="audio-debug-more">
          {shown.hidden} more: {Object.entries(shown.hiddenByState).map(([state, n]) => `${n} ${state}`).join(", ")}
        </p>
      ) : null}
    </section>
  );
}
