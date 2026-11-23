// The player bar's slots while a sequence is open (proto §2.6 "Transport"): what Play plays (Selection / From playhead
// / From start), pre-roll, return to start, follow playhead; ⏮ to the start, ▶/■, and "⇥ Release" while a held loop
// waits; the playhead and why nothing plays. The Playlists screen's player-bar effect calls this (it reads the
// transport's signals, so the bar follows them).
import type { PlayerBarSlots } from "../../../components/PlayerBar";
import { SegmentedControl } from "../../../../editor/ui/SegmentedControl";
import { PLAY_MODES, type PlayMode } from "./transportModel";
import { playback, playSequence, releaseSequence, returnToStart, sequenceContext, sequenceHasHeldLoop, seqPlayhead, seqTransport, stopSequence, transportMessage } from "./sequenceState";
import "./sequence.css";

export function sequencePlayerSlots(title: string, subtitle: string): PlayerBarSlots {
  const p = playback.value;
  const opts = seqTransport.value;
  const t = seqPlayhead.value;
  void sequenceContext.value;
  const held = sequenceHasHeldLoop();
  const message = transportMessage.value;
  const toggle = (k: "preRoll" | "returnToStart" | "follow") => (seqTransport.value = { ...seqTransport.peek(), [k]: !seqTransport.peek()[k] });
  return {
    nowPlaying: { art: "SQ", title, subtitle },
    transport: (
      <span class="sq-transport">
        <button type="button" class="pl-transport" aria-label="Return to start" title="Playhead to the start" disabled={!!p} onClick={returnToStart}>⏮</button>
        <button type="button" class="pl-transport pl-trigger" aria-label={p ? "Stop" : "Play"} title={p ? "Stop (Space)" : "Play (Space)"} onClick={() => (p ? stopSequence() : playSequence())}>{p ? "■" : "▶"}</button>
        {held && <button type="button" class="pl-transport" title="Release: held loops leave by their exit settings (Space while playing)" disabled={!p || p.released} onClick={releaseSequence}>⇥ Release</button>}
        <SegmentedControl<PlayMode> size="small" label="Play" value={opts.mode} options={PLAY_MODES} onChange={(v) => (seqTransport.value = { ...seqTransport.peek(), mode: v })} />
        <label title="Start one second early"><input type="checkbox" checked={opts.preRoll} onChange={() => toggle("preRoll")} /> Pre-roll</label>
        <label title="Put the playhead back where it started when playback ends"><input type="checkbox" checked={opts.returnToStart} onChange={() => toggle("returnToStart")} /> Return</label>
        <label title="Scroll the timeline with the playhead"><input type="checkbox" checked={opts.follow} onChange={() => toggle("follow")} /> Follow</label>
      </span>
    ),
    status: message ?? (p ? `Playing ${title} · ${t.toFixed(2)} s${p.released ? " · released" : ""}` : `Playhead ${t.toFixed(2)} s`),
  };
}
