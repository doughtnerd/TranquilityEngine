// The player bar's slots while a playlist (not a sequence) is open (ADR 0343; UI pass L2, PB4): now playing, the
// transport (previous and next voice event, Trigger / Stop, Release for held loops), the voice log's scrub and the
// status. Trigger is off, saying why, when there's nothing to play. The scrub row is always there, an idle track before
// the first trigger, so the bar keeps its height when a trigger starts the log.
import { TransportButton, type PlayerBarSlots } from "../../components/PlayerBar";
import { eventTimes, logSpan, stepEvent, type LogRow } from "./voiceLog";

export interface PlaylistPlayerState {
  readonly title: string;
  readonly subtitle: string;
  /** Something the audition started still plays. */
  readonly busy: boolean;
  /** The open playlist holds a loop that waits for release. */
  readonly release: boolean;
  /** Why Trigger is off (null: it plays). */
  readonly triggerOff: string | null;
  readonly log: readonly LogRow[];
  readonly cursor: number | null;
  /** The audio clock at the last poll. */
  readonly now: number;
}

export interface PlaylistPlayerActions {
  trigger(): void;
  stop(): void;
  release(): void;
  seek(t: number | null): void;
}

export function playlistPlayerSlots(s: PlaylistPlayerState, a: PlaylistPlayerActions): PlayerBarSlots {
  const times = eventTimes(s.log);
  const span = logSpan(s.log, s.now);
  const off = !s.busy && s.triggerOff !== null;
  return {
    nowPlaying: { art: "PL", title: s.title, subtitle: s.subtitle },
    transport: (
      <>
        <TransportButton icon="skipBack" label="Previous voice event" title="Previous voice start or end" disabled={times.length === 0} onClick={() => a.seek(stepEvent(times, s.cursor, -1) ?? s.cursor)} />
        <TransportButton icon={s.busy ? "stop" : "play"} primary label={s.busy ? "Stop" : "Trigger"} title={s.busy ? "Stop (Shift+Space)" : (s.triggerOff ?? "Trigger (Space)")} disabled={off} onClick={() => (s.busy ? a.stop() : a.trigger())} />
        {s.release && <TransportButton icon="release" text label="Release" title="Release: held loops end by their exit settings" disabled={!s.busy} onClick={a.release} />}
        <TransportButton icon="skipForward" label="Next voice event" title="Next voice start or end" disabled={times.length === 0} onClick={() => a.seek(stepEvent(times, s.cursor, 1) ?? s.cursor)} />
      </>
    ),
    scrub: span ? (
      <input type="range" class="pl-scrub" aria-label="Scrub the voice log" min={span[0]} max={span[1]} step={0.01} value={s.cursor ?? span[1]} onInput={(e) => a.seek(Number((e.currentTarget as HTMLInputElement).value))} />
    ) : (
      <input type="range" class="pl-scrub" aria-label="Scrub the voice log" title="Trigger to start the voice log" min={0} max={1} value={0} disabled />
    ),
    status: s.busy ? `Auditioning ${s.title}` : s.cursor !== null && span ? `Voice log at ${(s.cursor - span[0]).toFixed(2)} s` : undefined,
  };
}
