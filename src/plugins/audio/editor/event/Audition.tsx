// The Event editor's Audition bar (ADR 0158 §7, E6.4; a view over the editor's audition, ADR 0268): Play the open event
// through the running audio host with the parameter sliders' values, Stop, Release, the backend that plays it and the
// instance's voices. Everything about the instance (the flush before Play, the end of the instance, live sliders,
// staleness, the notice) is the audition's; this reads its signals and shows them while it plays this event. Closing the
// panel or moving to another event stops this event's whole-event audition (a music audition of it from the segment view
// goes on).
import { useEffect } from "preact/hooks";
import type { Audition as AuditionModule } from "../audition/audition";
import { auditionBackend, buttonStates, limitRows } from "../audition/auditionView";

export interface AuditionProps {
  /** The editor's audition. */
  audition: AuditionModule;
  /** The event asset to play (`*.audioevent.json`). */
  path: string;
  /** The parameter values to start with: numbers, or a label for a labelled parameter. Slider moves reach the audition by `setParameter`. */
  parameters: Record<string, number | string>;
}

const level = (v: number): string => (v === 0 ? "0" : v.toFixed(2));

export function Audition({ audition, path, parameters }: AuditionProps) {
  const s = audition.state.value;
  const mine = s.event === path;
  const phase = mine ? s.phase : "idle";
  const live = phase === "playing" || phase === "released";
  const voices = mine ? s.voices : [];
  const notice = mine || s.status === "failed" ? audition.notice.value : null;

  // The host's status and backend as the panel opens; the panel closing stops this event's whole-event audition.
  useEffect(() => {
    audition.tick();
    return () => audition.stop({ event: path, segmentId: null });
  }, [audition, path]);

  const buttons = buttonStates(phase);
  const shown = limitRows(voices);
  const backendInfo = auditionBackend(s.backend);
  return (
    <>
    <div class="ev-aud" data-phase={phase}>
      <div class="ev-aud-bar">
        <button onClick={() => void audition.play({ event: path, parameters })} disabled={!buttons.play} data-testid="audition-play" title="Play the event with the parameter values above">Play</button>
        <button onClick={() => audition.stop()} disabled={!buttons.stop} data-testid="audition-stop" title="Stop it now">Stop</button>
        <button onClick={() => audition.release()} disabled={!buttons.release} data-testid="audition-release" title="Key-off: sustain loops play their tails">Release</button>
        <span class="ev-aud-backend" data-testid="audition-backend" title="The audio backend this audition plays on">{backendInfo.label}</span>
        <span class="ev-aud-phase" data-testid="audition-phase">{phase === "idle" ? "" : phase}</span>
      </div>
      {backendInfo.note && <p class="ev-aud-note" data-testid="audition-backend-note">{backendInfo.note}</p>}
      {notice && <p class="ev-aud-notice" role="status" data-testid="audition-notice">{notice}</p>}
      {s.stale && mine && live && <p class="ev-aud-notice" data-testid="audition-stale">The event was edited after this started. Press Play to hear the change.</p>}
      {voices.length > 0 && (
        <table class="ev-aud-voices" aria-label="Audition voices" data-testid="audition-voices">
          <thead>
            <tr><th scope="col">Clip</th><th scope="col">State</th><th scope="col">Gain</th></tr>
          </thead>
          <tbody>
            {shown.shown.map((v) => (
              <tr key={v.id}>
                <td class="ev-aud-clip" title={v.clip}>{v.clip}</td>
                <td data-state={v.state}>{v.state}</td>
                <td>{level(v.gain)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {shown.hidden > 0 && <p class="ev-aud-more">{shown.hidden} more voices</p>}
    </div>
    {voices.length > 0 && <span class="ev-voices">{voices.length} voice{voices.length === 1 ? "" : "s"}</span>}
    </>
  );
}
