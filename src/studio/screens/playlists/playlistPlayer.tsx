// The player bar's slots while a playlist (not a sequence) is open (ADR 0343; UI pass L2, PB4): now playing, the
// transport (previous and next voice event, Trigger / Stop, Release for held loops), the voice log's scrub and the
// status. Trigger is off, saying why, when there's nothing to play. The scrub row is always there, an idle track before
// the first trigger, so the bar keeps its height when a trigger starts the log.
import { TransportButton, VoiceStrip, type PlayerBarSlots } from "../../components/PlayerBar";
import { eventTimes, logSpan, stepEvent, type LogRow } from "./voiceLog";

export interface PlaylistPlayerState {
  readonly title: string;
  readonly subtitle: string;
  /** The tile's type badge (QUE, SW, 1D, 2D, LAY, CLP); "PL" when unknown. */
  readonly art?: string;
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
  // The big button is the prototype's accent pill: Trigger, then Release while a held loop waits, then Stop.
  const pill = s.busy
    ? s.release
      ? { icon: "release" as const, label: "Release", title: "Release: held loops end by their exit settings (Space)", run: a.release }
      : { icon: "stop" as const, label: "Stop", title: "Stop (Shift+Space)", run: a.stop }
    : { icon: "trigger" as const, label: "Trigger", title: s.triggerOff ?? "Resolve and play one voice of this playlist (Space)", run: a.trigger };
  const voices = s.log.filter((r) => r.kind === "voice");
  return {
    nowPlaying: { art: s.art ?? "PL", title: s.title, subtitle: s.subtitle },
    transport: (
      <>
        <TransportButton icon="skipBack" label="Previous voice event" title="Step back to the previous voice start or end" disabled={times.length === 0} onClick={() => a.seek(stepEvent(times, s.cursor, -1) ?? s.cursor)} />
        <TransportButton trigger icon={pill.icon} label={pill.label} title={pill.title} disabled={off} onClick={pill.run} />
        {s.busy && s.release && <TransportButton icon="stop" label="Stop" title="Stop (Shift+Space)" onClick={a.stop} />}
        <TransportButton icon="skipForward" label="Next voice event" title="Step forward to the next voice start or end" disabled={times.length === 0} onClick={() => a.seek(stepEvent(times, s.cursor, 1) ?? s.cursor)} />
      </>
    ),
    // The voice strip: a bar per voice of the log, always there (idle before the first trigger) so the bar keeps its height.
    scrub: span ? (
      <VoiceStrip
        from={span[0]}
        to={span[1]}
        cursor={s.cursor}
        segments={voices.map((r) => ({ start: r.start, end: r.end, done: r.end !== null && s.cursor !== null && r.end <= s.cursor }))}
        startText={((s.cursor ?? span[1]) - span[0]).toFixed(2)}
        endText={voices.some((r) => r.end === null) ? "playing" : `${(span[1] - span[0]).toFixed(2)} s`}
        title="Drag to preview the voice log at any point. Bars are this trigger's voices."
        onSeek={(t) => a.seek(t)}
      />
    ) : (
      <VoiceStrip from={0} to={1} cursor={0} segments={[]} startText="0.00" endText="—" title="Trigger to start the voice log" disabled onSeek={() => {}} />
    ),
    status: s.busy ? `Playing ${s.title}` : s.cursor !== null && span ? `Voice log at ${(s.cursor - span[0]).toFixed(2)} s` : (s.triggerOff ?? "Space triggers"),
  };
}
