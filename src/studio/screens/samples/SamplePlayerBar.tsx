// The Samples screen's player bar slots (ADR 0335 `PlayerBar`, the prototype's transport): the play-mode menu
// (Selection; Whole, Loop, Through loops; To next marker, To the end; Pre-roll, Return to start, Follow), Play /
// Pause (Release while a held loop plays), Stop, and the scrub row (time, track, end).
import { effect } from "@preact/signals";
import { useRef, useState } from "preact/hooks";
import { usePopover } from "../../../editor/ui/popover";
import { formatTime } from "../../components/timeRulerModel";
import { setPlayerSlots } from "../../shell/studioServices";
import * as act from "./sampleActions";
import { viewTime } from "./sampleEditing";
import { metaLine, nameOf } from "./sampleLibrary";
import { lengthOf } from "./sampleSession";
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
      <span class="smp-menu-check">{s.value ? "✓" : ""}</span>
      {label}
    </button>
  );
  return (
    <>
      <button ref={button} class="smp-tool" aria-haspopup="menu" aria-expanded={open} title="Play mode" onClick={() => setOpen(!open)}>
        {mode.label} ▾
      </button>
      {open && (
        <div ref={pop} class="context-menu kit-menu smp-menu" role="menu" aria-label="Play mode">
          {MODES.map((m, i) => (
            <div key={m.id}>
              {(i === 0 || MODES[i - 1].group !== m.group) && <div class="smp-menu-group">{m.group}</div>}
              <button role="menuitemradio" aria-checked={playMode.value === m.id} onClick={() => ((playMode.value = m.id), setOpen(false))}>
                <span class="smp-menu-check">{playMode.value === m.id ? "✓" : ""}</span>
                {m.label}
              </button>
            </div>
          ))}
          <div class="context-sep" role="separator" />
          {opt("Pre-roll 1 s", preRoll)}
          {opt("Return to start at the end", returnToStart)}
          {opt("Follow playhead", followPlayhead)}
        </div>
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
      <button class="primary smp-play" disabled={!session} aria-label={held ? "Release" : mine ? "Stop" : "Play"} title={held ? "Release the held loop (Space)" : "Play the selection (Space)"} onClick={() => act.togglePlay()}>
        {held ? "⇥ Release" : mine ? "■" : "▶"}
      </button>
      <button class="smp-tool" disabled={!mine} aria-label="Stop" onClick={act.stop}>Stop</button>
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
      status: p ? `Playing ${p.plan.scope}${p.plan.held && !p.released ? " · Space releases the loop" : ""}` : session ? "Space plays the selection" : undefined,
    });
  });
}
