// The Samples screen's player bar slots (ADR 0349 `PlayerBar`, the prototype's transport): the play-mode menu
// (Selection; Whole, Loop, Through loops; To next marker, To the end; Pre-roll, Return to start, Follow), Play /
// Stop (Release while a held loop plays) as the one big button, the scrub row (time, track, end), the mini waveform
// beside the title, and the playhead for the status bar. The play-mode menu floats at the page's root: the player bar
// has container queries, which would otherwise trap it (S-03).
import { effect } from "@preact/signals";
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../../../editor/ui/popover";
import { FloatingPortal } from "../../../editor/ui/FloatingPortal";
import { Icon } from "../../components/Icon";
import { MiniWaveform, TransportButton } from "../../components/PlayerBar";
import { formatTime } from "../../components/timeRulerModel";
import { setPlayerSlots } from "../../shell/studioServices";
import * as act from "./sampleActions";
import { viewTime } from "./sampleEditing";
import { metaLine, nameOf } from "./sampleLibrary";
import { lengthOf, peaksOf } from "./sampleSession";
import { editedLength } from "./sampleTime";
import { followPlayhead, openSession, playheadTime, playMode, preRoll, returnToStart, timeFormat, type PlayMode } from "./samplesState";
import { playing } from "./sampleTransport";

const MODES: { id: PlayMode; label: string; group: string }[] = [
  { id: "selection", label: "Selection", group: "Play" },
  { id: "whole", label: "Whole", group: "Whole sample" },
  { id: "loop", label: "Loop", group: "Whole sample" },
  { id: "through", label: "Through loops", group: "Whole sample" },
  { id: "toNextMarker", label: "To next marker", group: "From the playhead" },
  { id: "toEnd", label: "To the end", group: "From the playhead" },
];

function ModeMenu() {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const pop = useRef<HTMLDivElement>(null);
  usePopover(pop, open, { anchor: button.current, side: "above", inside: [button], focusFirst: true, onDismiss: () => setOpen(false) });
  const mode = MODES.find((m) => m.id === playMode.value)!;
  const opt = (label: string, s: { value: boolean }) => (
    <button role="menuitemcheckbox" aria-checked={s.value} onClick={() => (s.value = !s.value)}>
      <span class="smp-menu-check">{s.value && <Icon name="check" size={12} />}</span>
      {label}
    </button>
  );
  return (
    <>
      <button ref={button} class="studio-player-scope" aria-haspopup="menu" aria-expanded={open} aria-label={`Play mode: ${mode.label}`} title="Play mode" onClick={() => setOpen(!open)}>
        <span class="smp-ellipsis">{mode.label}</span>
        <Icon name="chevronDown" size={12} />
      </button>
      {open && (
        <FloatingPortal>
        <div ref={pop} class="context-menu kit-menu smp-menu" role="menu" aria-label="Play mode">
          {MODES.map((m, i) => (
            <div key={m.id}>
              {(i === 0 || MODES[i - 1].group !== m.group) && <div class="smp-menu-group">{m.group}</div>}
              <button role="menuitemradio" aria-checked={playMode.value === m.id} onClick={() => ((playMode.value = m.id), setOpen(false))}>
                <span class="smp-menu-check">{playMode.value === m.id && <Icon name="check" size={12} />}</span>
                {m.label}
              </button>
            </div>
          ))}
          <div class="context-sep" role="separator" />
          {opt("Pre-roll 1 s", preRoll)}
          {opt("Return to start at the end", returnToStart)}
          {opt("Follow playhead", followPlayhead)}
        </div>
        </FloatingPortal>
      )}
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
      status: p ? `Playing ${p.plan.scope}${p.plan.held && !p.released ? " · Space releases the loop" : ""}` : session ? "Space plays the selection" : undefined,
    });
  });
}
