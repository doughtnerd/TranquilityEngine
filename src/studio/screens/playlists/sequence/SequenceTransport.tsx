// The player bar's slots while a sequence is open (proto §2.6 "Transport"): what Play plays (Selection / From playhead
// / From start), pre-roll, return to start, follow playhead; back to the start, Play/Stop, and Release while a held loop
// waits; the playhead and why nothing plays. The Playlists screen's player-bar effect calls this (it reads the
// transport's signals, so the bar follows them).
import { TransportButton, type PlayerBarSlots } from "../../../components/PlayerBar";
import { SegmentedControl } from "../../../../editor/ui/SegmentedControl";
import { PLAY_MODES, playLabel, type PlayMode } from "./transportModel";
import { Checkbox } from "../../../components/Checkbox";
import { playback, playSequence, releaseSequence, returnToStart, sequenceContext, sequenceHasHeldLoop, seqPlayhead, seqSelection, seqTransport, stopSequence, transportMessage } from "./sequenceState";
import "./sequence.css";

export function sequencePlayerSlots(title: string, subtitle: string): PlayerBarSlots {
  const p = playback.value;
  const opts = seqTransport.value;
  const t = seqPlayhead.value;
  const held = sequenceHasHeldLoop();
  const message = transportMessage.value;
  const ctx = sequenceContext.value;
  // Sequence W-2: the Play button names what it will play.
  const play = ctx ? playLabel(ctx.seq, seqSelection.value, t, opts, ctx.sourceOf) : "Play";
  const toggle = (k: "preRoll" | "returnToStart" | "follow") => (seqTransport.value = { ...seqTransport.peek(), [k]: !seqTransport.peek()[k] });
  return {
    nowPlaying: { art: "SQ", title, subtitle },
    transport: (
      <span class="sq-transport">
        <TransportButton icon="skipBack" label="Return to start" title="Playhead to the start" disabled={!!p} onClick={returnToStart} />
        <TransportButton icon={p ? "stop" : "play"} primary text={!p} label={p ? "Stop" : play} title={p ? "Stop (Space)" : `${play} (Space)`} onClick={() => (p ? stopSequence() : playSequence())} />
        {held && <TransportButton icon="release" text label="Release" title="Release: held loops leave by their exit settings (Space while playing)" disabled={!p || p.released} onClick={releaseSequence} />}
        <SegmentedControl<PlayMode> size="small" label="Play" value={opts.mode} options={PLAY_MODES} onChange={(v) => (seqTransport.value = { ...seqTransport.peek(), mode: v })} />
        <Checkbox label="Pre-roll" title="Start one second early" checked={opts.preRoll} onChange={() => toggle("preRoll")} />
        <Checkbox label="Return" title="Put the playhead back where it started when playback ends" checked={opts.returnToStart} onChange={() => toggle("returnToStart")} />
        <Checkbox label="Follow" title="Scroll the timeline with the playhead" checked={opts.follow} onChange={() => toggle("follow")} />
      </span>
    ),
    status: message ?? (p ? `Playing ${title} · ${t.toFixed(2)} s${p.released ? " · released" : ""}` : `Playhead ${t.toFixed(2)} s`),
  };
}
