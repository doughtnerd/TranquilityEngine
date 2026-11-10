// Audition (ADR 0158 §7, E6.4): plays the open event through the running audio host (`Audio.play`, the same path a
// game's script takes, so what is heard is what the game will do), with the parameter sliders live and a small list
// of the instance's voices. The pure decisions (phases, which debug rows are ours, which parameters changed, the
// "nothing is heard" message) are in `auditionHost.ts`.
//
// The audio host: the editor's own World has the view, so `Audio.play` works in the editor outside play mode too, and
// the asset reaches it through the project's asset source (a write replaces the raw object, which is what the runtime's
// parse cache is keyed on, so flushing the document's pending write before Play is all "reload" takes).
import { useEffect, useRef, useState } from "preact/hooks";
import { Assets } from "../../../../engine/scene/Assets";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import { Audio } from "../../runtime/Audio";
import type { AudioEventHandle, AudioReason, AudioStatus } from "../../runtime/backend";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import {
  auditionNotice, buttonStates, instanceAlive, instanceVoices, isStale, limitRows, newInstanceId, nextPhase, parameterChanges,
  type AuditionAction, type AuditionPhase,
} from "./auditionHost";

export interface AuditionProps {
  /** The event asset to play (`*.audioevent.json`). */
  path: string;
  /** The parameter values to apply while it plays: numbers, or a label for a labelled parameter. */
  parameters: Record<string, number | string>;
  /** Called with the audition's playing voice count, for the panel's status line. */
  onVoices?(count: number): void;
}

/** The voice list refreshes this often, only while an instance is live. */
const POLL_MS = 200;

interface VoiceView { id: number; clip: string; state: string; gain: number }

const rawAsset = (path: string): object | undefined => {
  try { return Assets.json<object>(path); } catch { return undefined; }
};

const level = (v: number): string => (v === 0 ? "0" : v.toFixed(2));

export function Audition({ path, parameters, onVoices }: AuditionProps) {
  const [phase, setPhase] = useState<AuditionPhase>("idle");
  const [voices, setVoices] = useState<VoiceView[]>([]);
  const [status, setStatus] = useState<AudioStatus>(() => Audio.status);
  const [played, setPlayed] = useState(false);
  const [reason, setReason] = useState<AudioReason | null>(null);
  const [stale, setStale] = useState(false);
  const handle = useRef<AudioEventHandle | null>(null);
  const instance = useRef<number | null>(null);
  const started = useRef<object | undefined>(undefined);
  const applied = useRef<Record<string, number | string>>({});
  const phaseRef = useRef<AuditionPhase>("idle");
  const latest = useRef({ parameters, onVoices });
  latest.current = { parameters, onVoices };

  const move = (action: AuditionAction): AuditionPhase => {
    const next = nextPhase(phaseRef.current, action);
    phaseRef.current = next;
    setPhase(next);
    return next;
  };
  const showVoices = (list: VoiceView[]) => {
    setVoices(list);
    latest.current.onVoices?.(list.length);
  };

  /** Stop and forget the current instance (a new Play, Stop, the panel closing, another event). */
  const drop = (fade: number) => {
    const h = handle.current;
    handle.current = null;
    instance.current = null;
    try { h?.stop(fade); } catch { /* already gone */ }
  };

  const play = async () => {
    drop(0.02);
    try {
      const project = editor.project.current;
      if (project) await openAssetDocument<AudioEventAsset>(project, path, "audioEvent").flush(); // audition what is on screen
    } catch { /* an unwritable project: play what the host has */ }
    const before = Audio.debug().events.map((e) => e.id);
    started.current = rawAsset(path);
    const h = Audio.play(path, { parameters: latest.current.parameters });
    applied.current = { ...latest.current.parameters };
    const ok = h.playing;
    handle.current = ok ? h : null;
    instance.current = ok ? newInstanceId(before, Audio.debug().events, path) : null;
    setPlayed(ok);
    setReason(h.reason);
    setStale(false);
    setStatus(Audio.status);
    move(ok ? "play" : "refused");
    if (!ok) showVoices([]);
  };

  const stop = () => {
    drop(0.05);
    move("stop");
    showVoices([]);
  };

  const release = () => {
    handle.current?.release();
    move("release");
  };

  // Slider changes reach the playing instance at once.
  useEffect(() => {
    const h = handle.current;
    if (!h) return;
    for (const [name, value] of parameterChanges(applied.current, parameters)) h.setParameter(name, value);
    applied.current = { ...parameters };
  }, [parameters]);

  // The voice list, on a light poll that runs only while an instance is live.
  const live = phase === "playing" || phase === "released";
  useEffect(() => {
    if (!live) return;
    const tick = () => {
      const h = handle.current;
      setStatus(Audio.status);
      if (!h) return;
      const info = Audio.debug();
      const alive = instance.current !== null ? instanceAlive(info.events, instance.current) : h.playing;
      if (!alive && !h.playing) {
        handle.current = null;
        instance.current = null;
        move("finished");
        showVoices([]);
        return;
      }
      showVoices(instanceVoices(info.voices, instance.current).map((v) => ({ id: v.id, clip: v.clip, state: v.state, gain: v.gain })));
      setStale(isStale(started.current, rawAsset(path)));
    };
    tick();
    const t = setInterval(tick, POLL_MS);
    return () => clearInterval(t);
  }, [live, path]);

  // Closing the panel or moving to another event ends the sound.
  useEffect(() => () => {
    drop(0.05);
    latest.current.onVoices?.(0);
  }, [path]);

  const buttons = buttonStates(phase);
  const notice = auditionNotice(status, phase, reason, played);
  const shown = limitRows(voices);
  return (
    <div class="ev-aud" data-phase={phase}>
      <div class="ev-aud-bar">
        <button onClick={() => void play()} disabled={!buttons.play} data-testid="audition-play" title="Play the event with the parameter values above">Play</button>
        <button onClick={stop} disabled={!buttons.stop} data-testid="audition-stop" title="Stop it now">Stop</button>
        <button onClick={release} disabled={!buttons.release} data-testid="audition-release" title="Key-off: sustain loops play their tails">Release</button>
        <span class="ev-aud-phase" data-testid="audition-phase">{phase === "idle" ? "" : phase === "ended" ? "ended" : phase}</span>
      </div>
      {notice && <p class="ev-aud-notice" role="status" data-testid="audition-notice">{notice}</p>}
      {stale && live && <p class="ev-aud-notice" data-testid="audition-stale">The event was edited after this started. Press Play to hear the change.</p>}
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
  );
}
