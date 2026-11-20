// Ed5: the transport controls of the segment view (Play, Stop, Loop, Play from a cue or bar, a stinger Trigger, Reload),
// a view over the editor's audition (ADR 0268): all the behaviour is in `audition/audition.ts`; this only reads its
// signals and calls it, and shows its state while it plays this bar's event.
import { useState } from "preact/hooks";
import type { SegmentGrid } from "../../../../engine/audio/musicGrid";
import type { Audition, AuditionRequest, AuditionTarget } from "../audition/audition";
import { buttonStates } from "../audition/auditionView";

export interface TransportBarProps {
  readonly audition: Audition;
  readonly event: string;
  readonly segmentId: string;
  readonly grid: SegmentGrid;
  readonly cues: readonly string[];
  readonly stingers: readonly string[];
  /** The Event editor's parameter values (moved sliders over the defaults), passed to the played instance. */
  readonly parameters?: Record<string, number | string>;
}

export function TransportBar({ audition, event, segmentId, grid, cues, stingers, parameters }: TransportBarProps) {
  const s = audition.state.value;
  const mine = s.event === null || s.event === event;
  const phase = mine ? s.phase : "idle";
  const { loop } = s;
  const message = mine || s.status === "failed" ? audition.notice.value : null;
  const [from, setFrom] = useState("start");
  const [bar, setBar] = useState("1");
  const [stinger, setStinger] = useState("");
  const buttons = buttonStates(phase);
  const live = buttons.stop;

  const target = (): AuditionTarget => {
    if (from === "start") return { kind: "start" };
    if (from === "bar") return { kind: "bar", bar: Number.parseInt(bar, 10) };
    return { kind: "cue", name: from.slice(4) };
  };
  const request = (): AuditionRequest => ({ event, parameters, music: { segmentId, grid, startAtSegment: true, from: target() } });
  const chosen = stingers.includes(stinger) ? stinger : (stingers[0] ?? "");

  return (
    <div class="segment-transport" data-testid="segment-transport" data-phase={phase}>
      <button type="button" onClick={() => void audition.play(request())} data-testid="transport-play" title="Play the event from the chosen position">Play</button>
      <button type="button" onClick={() => audition.stop()} disabled={!live} data-testid="transport-stop">Stop</button>
      <label>
        From{" "}
        <select value={from} onChange={(e) => setFrom((e.target as HTMLSelectElement).value)} data-testid="transport-from">
          <option value="start">Start</option>
          {cues.map((c) => <option value={`cue:${c}`}>Cue {c}</option>)}
          <option value="bar">Bar</option>
        </select>
      </label>
      {from === "bar" && (
        <input
          type="number" min={1} step={1} value={bar} aria-label="Bar" class="segment-transport-bar" data-testid="transport-bar"
          onInput={(e) => setBar((e.target as HTMLInputElement).value)}
        />
      )}
      <label class="segment-transport-check">
        <input type="checkbox" checked={loop} onChange={(e) => audition.setLoop((e.target as HTMLInputElement).checked)} data-testid="transport-loop" /> Loop
      </label>
      <button type="button" onClick={() => void audition.reload()} disabled={!live} data-testid="transport-reload" title="Re-prime the playing segment with what is on screen; it swaps at the next bar">Reload</button>
      {stingers.length > 0 && (
        <span class="segment-transport-stinger">
          <select value={chosen} onChange={(e) => setStinger((e.target as HTMLSelectElement).value)} aria-label="Stinger" data-testid="transport-stinger">
            {stingers.map((s) => <option value={s}>{s}</option>)}
          </select>
          <button type="button" onClick={() => audition.trigger(chosen)} disabled={!live} data-testid="transport-trigger" title={live ? "Play this stinger over the music" : "Press Play first"}>Trigger</button>
        </span>
      )}
      <span class="segment-transport-phase" data-testid="transport-phase">{phase === "idle" ? "" : phase}</span>
      {message && <span class="segment-transport-message" role="status" data-testid="transport-message">{message}</span>}
    </div>
  );
}
