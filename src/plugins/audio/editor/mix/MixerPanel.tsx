// The Mixer panel (ADR 0171 change 22, ADR 0172; api-and-models §7; task Mp2b): the channel strips (`MixerStrip.tsx`), the
// snapshot buttons (one at a time), the loudness target picker, Reset, Pause and the elapsed time, Compare with Play start,
// and the banners (a problem in the audio section, an edit that applies at the next Play, monitor controls on, Compare on).
//
// Thin over a pure model: `MixerPanelController` (`mixerPanelModel.ts`) holds every decision and is tested without a DOM;
// `MixerChrome` only renders its `view` and forwards events (it has no hooks, so a test calls it as a function), and
// `MixerPanel` owns the timer: the controller samples the live readings every `POLL_MS` (the cadence of `BusMeters`) while
// the editor plays. Sampling writes nothing, so a moving meter never marks the project dirty.
//
// Where it gets its things (`defaultMixerDeps`): the audio section's draft and undo from the shell's Project Settings
// section (`mixerHost.section`, set by `mix/index.ts`; the fader's one undo step goes through it, and Ctrl+Z follows its
// history while the panel is focused), the play Engine's `mixer`, the page's `loudnessHub`, `Audio.loudnessTarget`,
// `Audio.capture.mark` and the audio clock. Colours are theme tokens in `mixerPanel.css`.
import type { JSX } from "preact";
import { useEffect, useRef, useState } from "preact/hooks";
import { editor, usePanelHistory, type EditorProject, type SettingsDraft, type UndoHistory } from "../../../../editor/sdk";
import { mixer } from "../../../../engine/audio/mixer";
import type { LoudnessResetWhat } from "../../../../engine/audio/loudnessTypes";
import { Audio } from "../../runtime/Audio";
import { loudnessHub } from "../../runtime/mix/loudnessHub";
import { MixerStrip } from "./MixerStrip";
import { MixerPanelController, type MixerBanner, type MixerPanelDeps, type MixerView } from "./mixerPanelModel";
import type { BusReading } from "./mixerModel";
import type { OpLogEntry } from "./opLog";
import "./mixerPanel.css";

/** The panel's sample cadence while playing, in ms: the strips follow the live readings this often. */
export const POLL_MS = 50;

/** What the panel needs of the shell's Project Settings section (structurally `ProjectSection<SettingsDraft>`). */
export interface MixerSection {
  open(project: EditorProject): { readonly draft: SettingsDraft; edit(label: string, next: SettingsDraft): Promise<void> };
  readonly history: UndoHistory;
  readonly version?: { readonly value: number };
}

/** What `mix/index.ts` fills when the panel loads, so this module imports nothing of the shell's panels. */
export const mixerHost: {
  section: MixerSection | null;
  /** The backend's `flushNow` (post the staged batch at once), when the editor can reach it. */
  flushNow: (() => void) | null;
  /** The op log's entries (the answers to the edits made in Play), when the editor can reach them. */
  entries: (() => readonly OpLogEntry[]) | null;
} = { section: null, flushNow: null, entries: null };

const loudnessBuses = (): string[] => [...mixer.busNames];

/** The deps over the real editor, mixer and hub. */
export function defaultMixerDeps(): MixerPanelDeps {
  const hubReset = (what: LoudnessResetWhat): void => { for (const n of loudnessBuses()) mixer.bus(n).loudness.reset(what); };
  return {
    draft: () => {
      const p = editor.project.peek();
      if (!p) return null;
      return mixerHost.section ? mixerHost.section.open(p).draft : (p.settings as SettingsDraft);
    },
    commit: (label, next) => {
      const p = editor.project.peek();
      if (p && mixerHost.section) return mixerHost.section.open(p).edit(label, next);
    },
    playing: () => editor.scene.peekPlayState() === "playing",
    apply: (op) => mixer.apply(op),
    flushNow: () => mixerHost.flushNow?.(),
    readBus: (name): BusReading | null => {
      const b = mixer.bus(name);
      if (!b.exists) return null;
      return { runtimeVolume: b.volume, runtimeMute: b.mute, solo: b.solo, peak: b.peak, effectiveGain: b.effectiveGain, duckGain: b.duckGain, activeVoices: b.activeVoices, loudness: b.loudness };
    },
    setMonitor: (bus, controls) => mixer.setMonitor(bus, controls),
    hub: {
      reset: hubReset,
      pause: () => { for (const n of loudnessBuses()) mixer.bus(n).loudness.pause(); },
      resume: () => { for (const n of loudnessBuses()) mixer.bus(n).loudness.resume(); },
      noteMonitorMute: (bus) => loudnessHub.noteMonitorMute(bus),
      noteMonitorSolo: () => loudnessHub.noteMonitorSolo(),
      setMonitorActive: (on) => loudnessHub.setMonitorActive(on),
      setCompare: (on) => loudnessHub.setCompare(on),
    },
    target: () => Audio.loudnessTarget,
    setTarget: (name) => { Audio.loudnessTarget = name; },
    snapshot: (name) => (name === null ? mixer.clearSnapshot() : mixer.snapshot(name)),
    currentSnapshot: () => mixer.currentSnapshot,
    mark: (text) => Audio.capture.mark(text),
    clock: () => Audio.time,
    entries: () => mixerHost.entries?.() ?? [],
  };
}

// ---- the view ---------------------------------------------------------------------------------------------------------

export interface MixerChromeProps {
  readonly controller: MixerPanelController;
  readonly view: MixerView;
  /** A gesture changed something: re-render. */
  readonly onChange: () => void;
}

function Banners(props: { banners: readonly MixerBanner[] }): JSX.Element | null {
  if (props.banners.length === 0) return null;
  return (
    <div class="mixer-banners">
      {props.banners.map((b, i) => (
        <p key={`${b.id}${i}`} class="mixer-banner" data-banner={b.id} data-severity={b.severity} role={b.severity === "warn" ? "alert" : "status"}>
          {b.text}
        </p>
      ))}
    </div>
  );
}

/** The panel's chrome from a view: no hooks, so a test calls it as a function. */
export function MixerChrome(props: MixerChromeProps): JSX.Element {
  const { controller: c, view: v, onChange } = props;
  const selected = v.targets.find((t) => t.selected);
  return (
    <div class="mixer-panel">
      <div class="mixer-toolbar" role="toolbar" aria-label="Mixer controls">
        {v.snapshots.length > 0 && (
          <div class="mixer-snapshots" role="group" aria-label="Snapshots">
            {v.snapshots.map((s) => (
              <button
                key={s.name}
                type="button"
                class={`mixer-snapshot${s.active ? " on" : ""}`}
                aria-pressed={s.active}
                disabled={!v.playing}
                title={s.active ? `Fade back to the plain mix` : `Fade to the ${s.name} snapshot`}
                onClick={() => c.pickSnapshot(s.name)}
              >{s.name}</button>
            ))}
          </div>
        )}
        <label class="mixer-target">
          <span class="mixer-target-label">Target</span>
          <select
            aria-label="Loudness target"
            title={selected ? selected.label : "Loudness target"}
            value={selected?.name}
            onChange={(e) => { c.pickTarget((e.currentTarget as HTMLSelectElement).value); onChange(); }}
          >
            {v.targets.map((t) => <option key={t.name} value={t.name} selected={t.selected}>{`${t.name} (${t.label})`}</option>)}
          </select>
        </label>
        <button type="button" class="mixer-reset" title="Reset the loudness meters and the elapsed time" onClick={() => c.reset("all")}>Reset</button>
        <button type="button" class={`mixer-pause${v.paused ? " on" : ""}`} aria-pressed={v.paused} title={v.paused ? "Resume the loudness meters" : "Pause the loudness meters"} onClick={() => c.togglePause()}>
          {v.paused ? "Resume" : "Pause"}
        </button>
        <span class="mixer-elapsed" role="timer" aria-label="Elapsed" title="Time since the last reset, paused time excluded">{v.elapsed}</span>
        <button
          type="button"
          class={`mixer-compare${v.compare.active ? " on" : ""}`}
          aria-pressed={v.compare.active}
          disabled={!v.compare.available}
          title={v.compare.active ? "Back to the edited mix" : v.compare.differs ? "Hear the saved mix from Play start (nothing is saved)" : "The mix is the same as at Play start"}
          onClick={() => c.toggleCompare()}
        >Compare</button>
      </div>
      <Banners banners={v.banners} />
      {v.empty !== null && <p class="mixer-empty">{v.empty}</p>}
      <div class="mixer-strips" role="group" aria-label="Channel strips">
        {v.strips.map((s) => (
          <MixerStrip key={s.name} strip={s} model={c.stripModel} onChange={onChange} onResetClip={(bus) => c.resetClip(bus)} levelDucked={v.ducked.has(s.name)} />
        ))}
      </div>
    </div>
  );
}

/** The registered panel (`audiomixer`). */
export function MixerPanel(): JSX.Element {
  const root = useRef<HTMLDivElement>(null);
  const [, setTick] = useState(0);
  const rerender = useRef(() => setTick((n) => n + 1));
  const controller = useRef<MixerPanelController | null>(null);
  controller.current ??= new MixerPanelController(defaultMixerDeps(), () => rerender.current());
  const c = controller.current;
  editor.scene.playState; // Play starting or stopping re-renders (and samples)
  editor.project.version; // the project's files changed
  void mixerHost.section?.version?.value; // the audio section's edit, undo or redo
  usePanelHistory(root, mixerHost.section?.history ?? null);
  useEffect(() => {
    let was = false;
    const id = setInterval(() => {
      c.sample();
      const now = editor.scene.peekPlayState() === "playing";
      if (now || was) rerender.current(); // playing: follow the readings; just stopped: show the rest state once
      was = now;
    }, POLL_MS);
    c.sample();
    return () => clearInterval(id);
  }, [c]);
  const view = c.view();
  return (
    <div class="mixer-root" ref={root} tabIndex={-1}>
      <MixerChrome controller={c} view={view} onChange={() => rerender.current()} />
    </div>
  );
}
