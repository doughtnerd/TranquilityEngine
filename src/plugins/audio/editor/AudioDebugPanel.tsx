// The audio debug panel (ADR 0157, A2.5): `Audio.debug()` while the game plays, about four times a second. Shows the
// status, the backend, the counters, each bus's gain, peak and voices, and the most audible voices (with a count of the
// rest by state). "Not playing" otherwise.
import { useEffect, useState } from "preact/hooks";
import { Audio } from "../runtime/Audio";
import type { AudioDebugInfo } from "../runtime/backend";
import { editor } from "../../../editor/sdk";
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

/** Two decimals, or "0" for a value that is exactly zero. */
const level = (v: number): string => (v === 0 ? "0" : v.toFixed(2));

/** The loudest of a bus's two channels, as the panel shows a peak. */
const peakOf = (b: AudioDebugInfo["buses"][number]): number => Math.max(b.peakL, b.peakR);

export function AudioDebugPanel() {
  const isPlaying = editor.scene.playState === "playing";
  const [info, setInfo] = useState<AudioDebugInfo | null>(null);
  useEffect(() => {
    if (!isPlaying) {
      setInfo(null);
      return;
    }
    setInfo(Audio.debug());
    const t = setInterval(() => setInfo(Audio.debug()), REFRESH_MS);
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
            </tr>
          ))}
        </tbody>
      </table>

      <h5>Voices{shown.hidden > 0 ? ` (the ${shown.rows.length} most audible of ${info.voices.length})` : ""}</h5>
      {info.voices.length === 0 ? (
        <p class="audio-debug-empty">No voices</p>
      ) : (
        <table class="audio-debug-table audio-debug-voices" aria-label="Voices">
          <thead>
            <tr>
              <th scope="col">Clip</th>
              <th scope="col">Bus</th>
              <th scope="col">State</th>
              <th scope="col">Priority</th>
              <th scope="col">Gain</th>
            </tr>
          </thead>
          <tbody>
            {shown.rows.map((v) => (
              <tr key={v.id}>
                <td class="audio-debug-clip" title={v.clip}>
                  {v.clip}
                </td>
                <td>{v.bus}</td>
                <td data-state={v.state}>{v.state}</td>
                <td>{v.priority}</td>
                <td>{level(v.gain)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown.hidden > 0 ? (
        <p class="audio-debug-more">
          {shown.hidden} more: {Object.entries(shown.hiddenByState).map(([state, n]) => `${n} ${state}`).join(", ")}
        </p>
      ) : null}
    </section>
  );
}
