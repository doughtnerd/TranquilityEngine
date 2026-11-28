// The Samples timeline's tools (the prototype's compact `.sbtn` buttons and `.snm` popovers): Tempo (BPM, Tap tempo,
// meter, where the value came from; Detect, Use detected, Clear) with the Tap tempo dialog (beat lights, a big target,
// the steadiness and a ±15 % dot strip, spec §4.1.5), Root note (note and cents, validated; Detect, Revert), Normalize
// (Off / Loudness / Peak, Target, the gain and the clip warning), the Snap split button (the left half toggles it; the
// caret picks the increment in the Time display's unit, a custom step, zero crossings) and the Time display menu with a
// live example per format. Explanations live in tooltips (§1.3). Each change is one step.
import { useEffect, useRef, useState } from "preact/hooks";
import type { LoudnessMeasure } from "../../../engine/audio/loudness/integrated";
import type { SampleEdits, ValueSource } from "../../../engine/audio/sample/types";
import type { DetectKind } from "../../../engine/audio/sample/detect/detect";
import { meterParts } from "../../../engine/audio/meter";
import { Chip } from "../../../editor/ui/Chip";
import { ContextMenu, type MenuEntry } from "../../../editor/ui/ContextMenu";
import { KitDialog } from "../../../editor/ui/KitDialog";
import { formatTime, TIME_FORMATS, type TimeContext, type TimeFormat } from "../../components/timeRulerModel";
import { clipAfterGain, isNoteName, NORMALIZE_RANGES, normalizeGain, normalizeGainText, normalizeTargetText, setNormalize, setRoot, setTempo, type SampleEdit } from "./sampleEditing";
import type { DetectOutcome } from "./sampleDetect";
import { detectionSummary, tempoCandidateEdit } from "./sampleDetectModel";
import { SampleIcon, type SampleIconName } from "./sampleIcons";
import { parseSnapStep, SNAP_PRESETS, type SnapSetting, type SnapUnit } from "./sampleView";
import { addTap, tapDots, tapResult } from "./tapTempo";
import { ToolPopover } from "./ToolPopover";

const METERS = ["4/4", "3/4", "6/8", "5/4", "7/8"];
const SOURCE_NAMES: Record<ValueSource, string> = { file: "From file", detected: "Detected", set: "Set by you" };

/** Where a value came from: lime From file, grey Detected, amber Set by you. Nothing when there's no value. */
function SourceChip(props: { source: ValueSource | null; chunk: string }) {
  if (!props.source) return null;
  return (
    <Chip tone={props.source === "file" ? "success" : props.source === "set" ? "warning" : "neutral"} title={props.source === "file" ? `From the ${props.chunk} chunk; the file isn't changed unless you use Write to file` : props.source === "set" ? "Set by you in the project" : "Found by analysing the audio"}>
      {SOURCE_NAMES[props.source]}
    </Chip>
  );
}

/** Runs a detection (the screen's `detectInto` over the sample's audio); the popover shows what it found. */
export type DetectRun = (kind: DetectKind) => Promise<DetectOutcome>;

/** Detect's state in a popover: running, and the last outcome's line. */
function useDetect(kind: DetectKind, run: DetectRun | undefined) {
  const [busy, setBusy] = useState(false);
  const [outcome, setOutcome] = useState<DetectOutcome | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const start = async () => {
    if (!run || busy) return;
    setBusy(true);
    setFailed(null);
    try {
      setOutcome(await run(kind));
    } catch (err) {
      setOutcome(null);
      setFailed(`Couldn't analyse the audio: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
    }
  };
  const line = busy ? "Analysing the audio…" : failed ?? (outcome ? (outcome.applied ? detectionSummary(outcome.result, kind) : `Nothing changed: ${outcome.refused}.`) : null);
  return { busy, outcome, line, start };
}

/** A popover menu row (the prototype's `.tci`): label, a muted note at the right. */
function Item(props: { label: string; note?: string | null; disabled?: boolean; title?: string; onClick(): void }) {
  return (
    <button type="button" class="smp-tci" role="menuitem" disabled={props.disabled} title={props.title} onClick={props.onClick}>
      <span class="smp-tci-label">{props.label}</span>
      {props.note && <span class="smp-tci-note">{props.note}</span>}
    </button>
  );
}

/** A radio row: ✓ column, label, a note at the right. */
function Radio(props: { label: string; checked: boolean; note?: string; disabled?: boolean; title?: string; onClick(): void }) {
  return (
    <button type="button" class="smp-tci" role="menuitemradio" aria-checked={props.checked} disabled={props.disabled} title={props.title} onClick={props.onClick}>
      <span class="smp-tci-check" aria-hidden="true">{props.checked ? "✓" : ""}</span>
      <span class="smp-tci-label">{props.label}</span>
      {props.note && <span class="smp-tci-note">{props.note}</span>}
    </button>
  );
}

const Sep = () => <div class="smp-tci-sep" role="separator" />;

/** Reads a number field's committed text; null for empty. */
const numberOf = (e: Event): number | null => {
  const text = (e.currentTarget as HTMLInputElement).value.trim();
  return text === "" ? null : Number(text);
};

// --- tempo -----------------------------------------------------------------------------------------------------------

export function TempoPopover(props: { edits: SampleEdits; commit(r: SampleEdit): void; detect?: DetectRun; disabled?: boolean }) {
  const t = props.edits.tempo;
  const det = useDetect("tempo", props.detect);
  const [tapping, setTapping] = useState(false);
  const candidates = det.outcome?.applied && t?.source === "detected" ? (det.outcome.result.tempo?.candidates ?? []) : [];
  const set = (bpm: number | null, meter = t?.meter ?? "4/4") => props.commit(setTempo(props.edits, bpm === null ? null : { bpm, meter }));
  return (
    <>
      <ToolPopover icon="tempo" label={t ? `${t.bpm}` : ""} title={t ? `Tempo ${t.bpm} BPM ${t.meter} · ${SOURCE_NAMES[t.source]}` : "Tempo: none · set one to show bars and beats"} name="Tempo and meter" heading="Tempo" pressed={!!t} disabled={props.disabled}>
        {() => (
          <>
            <div class="smp-tci smp-tci-fields">
              <input class="smp-num" type="number" min={20} max={400} step={0.1} value={t?.bpm ?? ""} placeholder="none" aria-label="BPM" autoFocus
                onChange={(e) => set(numberOf(e))} />
              <span class="smp-muted">BPM</span>
              <button type="button" class="smp-tool" title="Tap tempo: tap along to set the BPM" onClick={() => setTapping(true)}>Tap</button>
              <select aria-label="Meter" title="Meter (can't be detected reliably; defaults to 4/4)" value={t?.meter ?? "4/4"} disabled={!t} onChange={(e) => t && set(t.bpm, (e.currentTarget as HTMLSelectElement).value)}>
                {METERS.map((m) => <option key={m} value={m}>{m}</option>)}
              </select>
              <span class="smp-flex" />
              <SourceChip source={t?.source ?? null} chunk="acid" />
            </div>
            {det.line && <p class="smp-tci-line" role="status" aria-live="polite">{det.line}</p>}
            {candidates.length > 0 && (
              <div class="smp-tci smp-tci-fields" aria-label="Tempo candidates">
                {candidates.map((c) => (
                  <button key={c.relation} type="button" class="smp-tool" title={`${c.relation === "half" ? "Half" : "Double"} the detected tempo · ${Math.round(c.confidence * 100)} % sure`} aria-pressed={t?.bpm === c.bpm}
                    onClick={() => props.commit(tempoCandidateEdit(props.edits, c.bpm))}>
                    {c.relation === "half" ? "½×" : "2×"} {c.bpm} BPM
                  </button>
                ))}
              </div>
            )}
            <Sep />
            <Item label={det.busy ? "Detecting…" : "Detect"} disabled={!props.detect || props.disabled || det.busy} title="Find the tempo and beats by analysing the audio (marked Detected)" onClick={() => void det.start()} />
            <Item label="Clear" disabled={!t} title="No tempo: the timeline shows time, not bars" onClick={() => set(null)} />
          </>
        )}
      </ToolPopover>
      {tapping && <TapTempoDialog meter={t?.meter ?? "4/4"} onUse={(bpm) => (set(bpm), setTapping(false))} onClose={() => setTapping(false)} />}
    </>
  );
}

/** The Tap tempo dialog (spec §4.1.5): tap on each beat with the button, Space, Enter or T. */
export function TapTempoDialog(props: { meter: string; onUse(bpm: number): void; onClose(): void }) {
  const [taps, setTaps] = useState<number[]>([]);
  const r = tapResult(taps);
  const tap = () => setTaps((x) => addTap(x, performance.now()));
  const beats = meterParts(props.meter).beatsPerBar;
  const lit = taps.length > 0 ? (taps.length - 1) % Math.min(4, beats) : -1;
  const dots = tapDots(taps);
  const target = useRef<HTMLButtonElement>(null);
  useEffect(() => target.current?.focus(), []);
  return (
    <KitDialog title="Tap tempo" width={340} class="smp-tapd" onClose={props.onClose}
      onKeyDown={(e) => {
        if ((e.key === " " || e.key === "Enter" || e.key.toLowerCase() === "t") && !(e.target instanceof HTMLButtonElement && e.target !== target.current)) {
          e.preventDefault();
          tap();
        }
      }}
      buttons={
        <>
          <button type="button" onClick={() => setTaps([])}>Start over</button>
          <button type="button" onClick={props.onClose}>Cancel</button>
          <button type="button" class="primary" disabled={!r?.usable} onClick={() => r && props.onUse(r.bpm)}>{r?.usable ? `Use ${r.bpm} BPM` : "Use"}</button>
        </>
      }>
      <div class="smp-tap-lights" aria-hidden="true">
        {Array.from({ length: Math.min(4, beats) }, (_, i) => <span key={i} class={i === lit ? "on" : undefined} />)}
      </div>
      <button ref={target} type="button" class="smp-tap-target" title="Tap on each beat (Space, Enter or T)" onClick={tap}>Tap</button>
      <div class="smp-tap-read" role="status" aria-live="polite">
        <span class="smp-tap-bpm">{r ? r.bpm : "—"}</span>
        <span class="smp-muted">BPM</span>
        <span class="smp-flex" />
        <span class={r?.steadiness === "uneven" ? "smp-warning" : "smp-muted"}>{r ? `${r.taps} taps · ${r.steadiness}` : "Tap at least twice"}</span>
      </div>
      <div class="smp-tap-dots" title="Each dot is one gap between taps, compared with the average (±15%)">
        <span class="smp-tap-mid" aria-hidden="true" />
        {dots.map((d, i) => <span key={i} class="smp-tap-dot" style={{ left: `${(d * 100).toFixed(1)}%` }} aria-hidden="true" />)}
      </div>
    </KitDialog>
  );
}

// --- root note -------------------------------------------------------------------------------------------------------

export function RootPopover(props: { edits: SampleEdits; commit(r: SampleEdit): void; detect?: DetectRun; disabled?: boolean }) {
  const r = props.edits.root;
  const det = useDetect("root", props.detect);
  const [text, setText] = useState(r?.note ?? "");
  // A detected (or undone) root shows in the field.
  const [shown, setShown] = useState(r?.note ?? "");
  if ((r?.note ?? "") !== shown) {
    setShown(r?.note ?? "");
    setText(r?.note ?? "");
  }
  const bad = text.trim() !== "" && !isNoteName(text);
  const label = r ? `${r.note}${r.cents ? ` ${r.cents > 0 ? "+" : ""}${r.cents}` : ""}` : "";
  return (
    <ToolPopover icon="note" label={label} title={r ? `Root note ${label} · ${SOURCE_NAMES[r.source]}` : "Root note: none"} name="Root note" heading="Root note" pressed={!!r} disabled={props.disabled}>
      {() => (
        <>
          <div class="smp-tci smp-tci-fields">
            <input class="smp-note" value={text} placeholder="none" aria-label="Root note" aria-invalid={bad} title="Note and octave, e.g. C3, F#2, Bb4" autoFocus onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
              onChange={() => !bad && props.commit(setRoot(props.edits, text.trim() === "" ? null : { note: text, cents: r?.cents ?? 0 }))} />
            <input class="smp-num" type="number" min={-50} max={50} step={1} value={r?.cents ?? 0} disabled={!r} aria-label="Fine tune in cents" title="Fine tune, cents (±50)"
              onChange={(e) => r && props.commit(setRoot(props.edits, { note: r.note, cents: numberOf(e) ?? 0 }))} />
            <span class="smp-muted">ct</span>
            <span class="smp-flex" />
            <SourceChip source={r?.source ?? null} chunk="smpl" />
          </div>
          {bad && <p class="smp-field-error smp-tci-line">Write a note like C4, F#3 or Bb2.</p>}
          {det.line && <p class="smp-tci-line" role="status" aria-live="polite">{det.line}</p>}
          <Sep />
          <Item label={det.busy ? "Detecting…" : "Detect"} disabled={!props.detect || props.disabled || det.busy} title="Analyse the audio for its root note and fine tune (marked Detected)" onClick={() => void det.start()} />
          <Item label={r?.source === "file" ? "Revert to file" : "Clear"} disabled={!r || r.source === "file"} title={r?.source === "file" ? "It already holds the file's value" : "No root note"} onClick={() => props.commit(setRoot(props.edits, null))} />
        </>
      )}
    </ToolPopover>
  );
}

// --- normalize -------------------------------------------------------------------------------------------------------

const db = (v: number) => (Number.isFinite(v) ? v.toFixed(1).replace("-", "−") : "−∞");

export function NormalizePopover(props: { edits: SampleEdits; measured: LoudnessMeasure | null; bextLoudness: number | null; commit(r: SampleEdit): void; disabled?: boolean }) {
  const n = props.edits.normalize;
  const m = props.measured;
  const clip = m ? clipAfterGain(m.peak, n.gainDb) : null;
  const target = normalizeTargetText(n);
  const pick = (mode: typeof n.mode) => props.commit(setNormalize(props.edits, mode, mode === n.mode ? n.target : undefined, m));
  const stale = m && n.mode !== "off" && normalizeGain(n.mode, n.target, m) !== n.gainDb;
  return (
    <ToolPopover icon="normalize" title={n.mode === "off" ? "Normalize: off · plays at the recorded level" : `Normalize to ${target} · gain ${normalizeGainText(n.gainDb)}`} name="Normalize" heading={`Normalize · ${m ? `${db(m.integrated)} LUFS · peak ${db(m.peak)} dBFS` : "measuring…"}`} pressed={n.mode !== "off"} disabled={props.disabled}>
      {() => (
        <>
          {props.bextLoudness !== null && <p class="smp-tci-line smp-muted">The file's bext says {db(props.bextLoudness)} LUFS</p>}
          <Radio label="Off" checked={n.mode === "off"} title="Play at the recorded level" onClick={() => pick("off")} />
          <Radio label="Loudness" checked={n.mode === "loudness"} title="Match a target loudness (integrated LUFS)" onClick={() => pick("loudness")} />
          <Radio label="Peak" checked={n.mode === "peak"} title="Match a target sample peak (dBFS)" onClick={() => pick("peak")} />
          {n.mode !== "off" && (
            <>
              <label class="smp-tci smp-tci-fields">
                <span class="smp-tci-check" />
                <span class="smp-tci-label">Target</span>
                <input class="smp-num" type="number" step={0.5} min={NORMALIZE_RANGES[n.mode][0]} max={NORMALIZE_RANGES[n.mode][1]} value={n.target} aria-label="Target"
                  onChange={(e) => props.commit(setNormalize(props.edits, n.mode, numberOf(e) ?? n.target, m))} />
                <span class="smp-unit smp-muted">{n.mode === "loudness" ? "LUFS" : "dBFS"}</span>
              </label>
              <div class="smp-tci smp-tci-fields" title={`Stored as a gain; the file isn't changed. Applied last, after the effects.${stale ? " Measured again: change the target to update it." : ""}`}>
                <span class="smp-tci-check" />
                <span class="smp-tci-label smp-muted">Gain</span>
                <span class="smp-tabular">{n.gainDb > 0 ? "+" : ""}{n.gainDb.toFixed(1)} dB{stale ? " *" : ""}</span>
              </div>
            </>
          )}
          {clip !== null && <p class="smp-tci-line smp-warning" role="alert">⚠ Peaks would reach {clip > 0 ? "+" : ""}{clip.toFixed(1)} dBFS and clip</p>}
        </>
      )}
    </ToolPopover>
  );
}

// --- snap ------------------------------------------------------------------------------------------------------------

/** The snap unit the Time display implies (bars snap in beats, samples in samples, timecode in ms). */
export const snapUnitFor = (f: TimeFormat, hasTempo: boolean): SnapUnit => (f === "bars" && hasTempo ? "beats" : f === "samples" ? "samples" : "ms");

const stepLabel = (s: SnapSetting) => (s.unit === "beats" ? (s.step === 4 ? "1 bar" : s.step === 0.25 ? "¼ beat" : `${Math.round(s.step * 1000) / 1000} beat`) : s.unit === "samples" ? `${s.step.toLocaleString("en")} smp` : `${s.step} ms`);

export function SnapSplit(props: { snap: SnapSetting; zero: boolean; format: TimeFormat; hasTempo: boolean; onSnap(s: SnapSetting): void; onZero(on: boolean): void; disabled?: boolean }) {
  const s = props.snap;
  const unit = snapUnitFor(props.format, props.hasTempo);
  const [custom, setCustom] = useState("");
  const tip = s.on ? `Snapping on · every ${stepLabel(s)}${props.zero ? " · zero crossings" : ""} (click to turn off)` : "Snapping off (click to turn on)";
  return (
    <span class="smp-split" role="group" aria-label="Snapping">
      <button type="button" class={`smp-sbtn smp-split-main${s.on ? " on" : ""}`} aria-pressed={s.on} aria-label="Snap" title={tip} disabled={props.disabled} onClick={() => props.onSnap({ ...s, on: !s.on })}>
        <SampleIcon name="snap" size={13} />
        <span class="smp-tabular">{stepLabel(s)}</span>
      </button>
      <ToolPopover caretOnly title="Snap increment and options" name="Snap settings" heading="Snap increment" disabled={props.disabled}>
        {() => (
          <>
            {SNAP_PRESETS[unit].map((p) => (
              <Radio key={p.step} label={p.label} checked={s.unit === unit && s.step === p.step} onClick={() => props.onSnap({ on: true, unit, step: p.step })} />
            ))}
            <label class="smp-tci smp-tci-fields">
              <span class="smp-tci-check" aria-hidden="true">{s.unit === unit && !SNAP_PRESETS[unit].some((p) => p.step === s.step) ? "✓" : ""}</span>
              <span class="smp-tci-label">Custom</span>
              <input class="smp-num" value={custom} placeholder={unit === "beats" ? "e.g. 1/3" : unit === "samples" ? "e.g. 256" : "e.g. 25"} aria-label="Custom snap step"
                title={unit === "beats" ? "Beats: a number or a fraction, e.g. 0.5 or 1/3 (triplets)" : undefined}
                onInput={(e) => setCustom((e.currentTarget as HTMLInputElement).value)}
                onChange={() => {
                  const v = parseSnapStep(custom, unit);
                  if (v !== null) props.onSnap({ on: true, unit, step: v });
                }} />
              <span class="smp-unit smp-muted">{unit === "beats" ? "beats" : unit === "samples" ? "smp" : "ms"}</span>
            </label>
            {unit !== "beats" && (
              <>
                <Sep />
                <label class="smp-tci" title="Move trim and loop points to the nearest zero crossing, to avoid clicks">
                  <input type="checkbox" checked={props.zero} onChange={(e) => props.onZero((e.currentTarget as HTMLInputElement).checked)} />
                  <span class="smp-tci-label">Snap to zero crossings</span>
                </label>
              </>
            )}
          </>
        )}
      </ToolPopover>
    </span>
  );
}

// --- time display ----------------------------------------------------------------------------------------------------

/** The caret beside the playhead readout: Timecode / Samples / Bars, each with a live example (the playhead now). */
export function TimeDisplayCaret(props: { value: TimeFormat; at: number; ctx: TimeContext; onChange(f: TimeFormat): void }) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const entries: MenuEntry[] = [
    { kind: "group", label: "Time display" },
    ...TIME_FORMATS.map((f) => {
      const off = f.id === "bars" && !props.ctx.bpm;
      return { id: f.id, label: f.id === "bars" ? "Bars : beats : ticks" : f.label, checked: props.value === f.id, disabled: off, note: off ? "no tempo" : formatTime(props.at, f.id, props.ctx), title: off ? "Set a tempo to show bars and beats" : undefined, run: () => props.onChange(f.id) };
    }),
  ];
  return (
    <>
      <button ref={button} type="button" class="smp-tcb" aria-haspopup="menu" aria-expanded={open} aria-label="Time display…" title="Time display: timecode, samples or bars (also sets the ruler and grid)" onClick={() => setOpen(!open)}>
        <SampleIcon name="caret" size={10} />
      </button>
      {open && <ContextMenu entries={entries} at={button.current!} label="Time display" onClose={() => setOpen(false)} />}
    </>
  );
}

export type { SampleIconName };
