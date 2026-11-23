// The Samples screen's player bar slots (ADR 0349 `PlayerBar`, the prototype's transport): the play-mode menu
// (spec §4.1.10: Selection; Whole, Cycle loop; Pickup → loop, Loop, Loop → exit for music; To next marker, To next
// exit, To trim end; Pre-roll, Return to start, Follow), the pill naming what Space plays now (S-06), Play /
// Stop (Release while a held loop plays) as the one big button, the scrub row (time, track, end), the mini waveform
// beside the title, and the playhead for the status bar. The play-mode menu floats at the page's root: the player bar
// has container queries, which would otherwise trap it (S-03).
import { effect } from "@preact/signals";
import { useRef, useState } from "preact/hooks";
import type { SampleEdits } from "../../../engine/audio/sample/types";
import { ContextMenu, SEPARATOR, tidyEntries, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { Icon } from "../../components/Icon";
import { MiniWaveform, TransportButton } from "../../components/PlayerBar";
import { formatTime } from "../../components/timeRulerModel";
import { setPlayerSlots } from "../../shell/studioServices";
import * as act from "./sampleActions";
import { viewTime } from "./sampleEditing";
import { metaLine, nameOf } from "./sampleLibrary";
import { lengthOf, peaksOf } from "./sampleSession";
import { editedLength } from "./sampleTime";
import { liveSelection } from "./sampleView";
import { followPlayhead, openSession, playheadTime, playMode, preRoll, returnToStart, selection, timeFormat } from "./samplesState";
import { planPlay, PLAY_MODES, playing, playModeInfo, playModeRefusal, showsMusicModes } from "./sampleTransport";

/** The play-mode menu's entries (the kit's ContextMenu: groups, ✓ on the mode, a note where a mode can't run). */
function modeEntries(e: SampleEdits, close: () => void): MenuEntry[] {
  const current = playModeInfo(playMode.peek()).id;
  const music = showsMusicModes(e);
  const out: MenuEntry[] = [];
  let group = "";
  for (const m of PLAY_MODES) {
    if (m.group === "Music" && !music) continue;
    if (m.group !== group) out.push({ kind: "group", label: (group = m.group) });
    const refused = playModeRefusal(e, m.id);
    out.push({ id: m.id, label: m.label, checked: current === m.id, note: refused ?? undefined, disabled: refused !== null, title: m.tip, run: () => ((playMode.value = m.id), close()) });
  }
  const opt = (id: string, label: string, s: { value: boolean }, tip: string): MenuEntry => ({ id, label, checked: s.value, title: tip, run: () => (s.value = !s.value) });
  return tidyEntries([
    ...out,
    SEPARATOR,
    opt("preroll", "Pre-roll 1 s", preRoll, "Start one second before the start point, so you hear what leads into it; before the sample's start that second is silent: a count-in"),
    opt("return", "Return to start at the end", returnToStart, "Put the playhead back where it started when playback ends"),
    opt("follow", "Follow playhead", followPlayhead, "Scroll the timeline to keep the playhead in view"),
  ]);
}

function ModeMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const session = openSession.value;
  const length = session ? lengthOf(session.project, session.source.value) : null;
  const e = session?.edits.value;
  const mode = playModeInfo(playMode.value);
  // The pill names what Space would play now (S-06): the selection's scope in Selection mode, else the mode.
  const plan = session && e && length !== null && mode.id === "selection" ? planPlay(e, length, liveSelection(selection.value, e, length), "selection", playheadTime.value) : null;
  const text = plan?.scope ?? mode.label;
  return (
    <>
      <button ref={button} class="studio-player-scope" aria-haspopup="menu" aria-expanded={open} aria-label={`Play mode: ${mode.label}${plan ? ` · ${text}` : ""}`} title={`Play mode: ${mode.label} · ${mode.tip}`} onClick={() => setOpen(!open)}>
        <span class="smp-ellipsis">{text}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && e && <ContextMenu entries={modeEntries(e, () => setOpen(false))} at={button.current!} label="Play mode" onClose={() => setOpen(false)} />}
    </>
  );
}

export function SampleTransportButtons() {
  const session = openSession.value;
  const p = playing.value;
  const mine = p && session && p.path === session.path;
  const held = mine && p.plan.held && !p.released;
  return (
    <>
      <ModeMenu />
      <TransportButton
        primary={!held}
        text={!!held}
        icon={held ? "skipForward" : mine ? "stop" : "play"}
        label={held ? "Release" : mine ? "Stop" : "Play"}
        title={held ? "Release the held loop (Space)" : mine ? "Stop (Space)" : "Play the selection (Space)"}
        disabled={!session}
        onClick={() => act.togglePlay()}
      />
    </>
  );
}

export function SampleScrub() {
  const session = openSession.value;
  if (!session) return null;
  const length = lengthOf(session.project, session.source.value);
  if (length === null) return null;
  const e = session.edits.value;
  const len = editedLength(length, e.closedGaps);
  const ctx = { rate: 48000, bpm: e.tempo?.bpm, meter: e.tempo?.meter };
  const t = viewTime(e, playheadTime.value);
  return (
    <>
      <span>{formatTime(t, timeFormat.value, ctx)}</span>
      <input
        type="range"
        class="smp-scrub"
        min={0}
        max={length}
        step={0.001}
        value={playheadTime.value}
        aria-label="Playhead"
        aria-valuetext={formatTime(t, timeFormat.value, ctx)}
        onInput={(ev) => act.movePlayhead(Number((ev.currentTarget as HTMLInputElement).value))}
      />
      <span>{formatTime(len, timeFormat.value, ctx)}</span>
    </>
  );
}

/** Bars in the mini waveform. */
const MINI_BARS = 24;

/** The open sample's mini waveform (24 bars of its peaks) with the playhead. */
function SampleMiniWave() {
  const session = openSession.value;
  if (!session) return null;
  const mips = peaksOf(session.project, session.source.value);
  if (!mips || mips.frames <= 0) return null;
  const level = [...mips.levels].reverse().find((l) => l.bins >= MINI_BARS) ?? mips.levels[0];
  const levels: number[] = [];
  for (let b = 0; b < MINI_BARS; b++) {
    const from = Math.floor((b / MINI_BARS) * level.bins);
    const to = Math.max(from + 1, Math.floor(((b + 1) / MINI_BARS) * level.bins));
    let peak = 0;
    for (let ch = 0; ch < level.channels; ch++)
      for (let i = from; i < Math.min(to, level.bins); i++) {
        const at = (ch * level.bins + i) * 2;
        peak = Math.max(peak, Math.abs(level.data[at]), Math.abs(level.data[at + 1]));
      }
    levels.push(peak / 32768);
  }
  const length = mips.frames / mips.rate;
  return <MiniWaveform levels={levels} playhead={length > 0 ? playheadTime.value / length : null} />;
}

/** What Space plays now, for the status line ("Space plays Trim"). */
function spaceScope(session: NonNullable<typeof openSession.value>): string {
  const length = lengthOf(session.project, session.source.value);
  const e = session.edits.value;
  if (length === null) return "the selection";
  const mode = playModeInfo(playMode.value);
  return planPlay(e, length, liveSelection(selection.value, e, length), mode.id, playheadTime.value)?.scope ?? mode.label;
}

let installed = false;
/** Keep the Samples player bar slots in step with the open sample (installed once). */
export function installSampleTransport(): void {
  if (installed) return;
  installed = true;
  effect(() => {
    const session = openSession.value;
    const p = playing.value;
    const length = session ? lengthOf(session.project, session.source.value) : null;
    setPlayerSlots("samples", {
      nowPlaying: session ? { art: "WAV", title: nameOf(session.path), subtitle: metaLine(session.path, session.edits.value, length, session.derived.value) } : null,
      transport: <SampleTransportButtons />,
      scrub: <SampleScrub />,
      viz: session ? <SampleMiniWave /> : undefined,
      playhead: session ? playheadTime : null,
      status: p ? `${p.plan.held && !p.released ? "Holding" : "Playing"} ${p.plan.scope}${p.plan.held && !p.released ? " · Space releases" : ""}` : session ? `Space plays ${spaceScope(session)}` : undefined,
    });
  });
}
