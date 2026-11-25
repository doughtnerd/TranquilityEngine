// The player bar's slots while a playlist (not a sequence) is open (ADR 0343; UI pass L2, PB1–PB6): now playing (the
// type badge in its colour, the name, the type summary), the transport (previous and next voice event around the
// Trigger pill, which becomes Release while a held loop waits, Pause / Resume, Stop only while something plays), the
// voice strip and the status: what the next trigger plays at rest, what plays while busy. Trigger is off, saying why,
// when there's nothing to play. The scrub row is always there, an idle track before the first trigger, so the bar keeps
// its height when a trigger starts the log.
import { TransportButton, VoiceStrip, type PlayerBarSlots } from "../../components/PlayerBar";
import { eventTimes, stepEvent, triggerRows, triggerSpan, type LogRow, type TriggerMark } from "./voiceLog";

export interface PlaylistPlayerState {
  readonly title: string;
  readonly subtitle: string;
  /** The tile's type badge (QUE, SW, 1D, 2D, LAY, CLP); "PL" when unknown. */
  readonly art?: string;
  /** Something the audition started still plays. */
  readonly busy: boolean;
  /** The audition is paused (its playbacks hold) and the views frozen (Pause). */
  readonly paused?: boolean;
  /** The open playlist holds a loop that waits for release. */
  readonly release: boolean;
  /** Why Trigger is off (null: it plays). */
  readonly triggerOff: string | null;
  /** What the next trigger plays at the test values ("Random pick · 1 of 5"), for the status at rest. */
  readonly next?: string;
  readonly log: readonly LogRow[];
  /** Where the latest trigger began: the strip shows its voices only (null: the whole log). */
  readonly mark?: TriggerMark | null;
  readonly cursor: number | null;
  /** The audio clock at the last poll. */
  readonly now: number;
}

export interface PlaylistPlayerActions {
  trigger(): void;
  stop(): void;
  release(): void;
  pause?(): void;
  resume?(): void;
  seek(t: number | null): void;
}

export function playlistPlayerSlots(s: PlaylistPlayerState, a: PlaylistPlayerActions): PlayerBarSlots {
  // The strip and the event steps cover the latest trigger: its voices from its start, the playhead live until scrubbed.
  const voices = triggerRows(s.log, s.mark ?? null);
  const times = eventTimes(voices);
  const span = triggerSpan(voices, s.mark ?? null, s.now);
  const playhead = s.cursor ?? (span ? Math.min(s.now, span[1]) : null);
  const off = !s.busy && s.triggerOff !== null;
  // The big button is the prototype's accent pill: Trigger, or Release while a held loop waits (a paused one triggers fresh).
  const pill = s.busy && s.release && !s.paused
    ? { icon: "release" as const, label: "Release", title: "Release: held loops end by their exit settings (Space)", run: a.release }
    : { icon: "trigger" as const, label: "Trigger", title: s.triggerOff ?? (s.paused ? "Trigger: start fresh (Space)" : "Resolve and play one voice of this playlist (Space)"), run: a.trigger };
  return {
    nowPlaying: { art: s.art ?? "PL", title: s.title, subtitle: s.subtitle },
    transport: (
      <>
        <TransportButton icon="skipBack" label="Previous voice event" title="Step back to the previous voice start or end" disabled={times.length === 0} onClick={() => a.seek(stepEvent(times, s.cursor, -1) ?? s.cursor)} />
        <TransportButton trigger icon={pill.icon} label={pill.label} title={pill.title} disabled={off && !s.paused} onClick={pill.run} />
        {s.paused ? (
          <TransportButton icon="play" label="Resume" title="Resume: continue the audition from where it paused" onClick={() => a.resume?.()} />
        ) : (
          <TransportButton icon="pause" label="Pause" title="Pause: hold the audition where it is; Plays now, Voices and the curves freeze there" disabled={!s.busy || !a.pause} onClick={() => a.pause?.()} />
        )}
        {s.busy && <TransportButton icon="stop" label="Stop" title="Stop (Shift+Space)" onClick={a.stop} />}
        <TransportButton icon="skipForward" label="Next voice event" title="Step forward to the next voice start or end" disabled={times.length === 0} onClick={() => a.seek(stepEvent(times, s.cursor, 1) ?? s.cursor)} />
      </>
    ),
    // The voice strip: a bar per voice of the log, always there (idle before the first trigger) so the bar keeps its height.
    scrub: span ? (
      <VoiceStrip
        from={span[0]}
        to={span[1]}
        cursor={playhead}
        now={s.now}
        segments={voices.map((r) => ({ start: r.start, end: r.end, done: r.end !== null && playhead !== null && r.end <= playhead }))}
        startText={((playhead ?? span[1]) - span[0]).toFixed(2)}
        endText={voices.some((r) => r.end === null) ? "playing" : `${(span[1] - span[0]).toFixed(2)} s`}
        title="Drag to preview the voice log at any point. Bars are this trigger's voices."
        onSeek={(t) => a.seek(t)}
      />
    ) : (
      <VoiceStrip from={0} to={1} cursor={0} segments={[]} startText="0.00" endText="—" title="Trigger to start the voice log" disabled onSeek={() => {}} />
    ),
    status: s.paused
      ? `Paused at ${span && playhead !== null ? (playhead - span[0]).toFixed(2) : "0.00"} s`
      : s.busy
        ? `Playing: ${s.title}${s.release ? " · held until released" : ""}`
        : s.cursor !== null && span
          ? `Voice log at ${(s.cursor - span[0]).toFixed(2)} s`
          : (s.triggerOff ?? (s.next ? `Next trigger: ${s.next}` : "Space triggers")),
  };
}
