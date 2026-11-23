// The Samples toolbar's popovers (the prototype's): Tempo (BPM, meter, Tap tempo, where the value came from), Root
// note (name and cents, validated), Normalize (Off / Loudness / Peak with targets; the gain is target − measured, with
// the clip warning), Snap (unit, step, custom, zero crossings) and the Time display. Each change is one step.
import { useState } from "preact/hooks";
import type { LoudnessMeasure } from "../../../engine/audio/loudness/integrated";
import type { SampleEdits, ValueSource } from "../../../engine/audio/sample/types";
import { Chip } from "../../../editor/ui/Chip";
import { Icon } from "../../components/Icon";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { TIME_FORMATS, type TimeFormat } from "../../components/timeRulerModel";
import type { DetectKind } from "../../../engine/audio/sample/detect/detect";
import { clipAfterGain, isNoteName, NORMALIZE_RANGES, normalizeGain, setNormalize, setRoot, setTempo, type SampleEdit } from "./sampleEditing";
import type { DetectOutcome } from "./sampleDetect";
import { detectionSummary, tempoCandidateEdit } from "./sampleDetectModel";
import { parseSnapStep, SNAP_PRESETS, type SnapSetting, type SnapUnit } from "./sampleView";
import { addTap, tapResult } from "./tapTempo";
import { ToolPopover } from "./ToolPopover";

const METERS = ["4/4", "3/4", "6/8", "5/4", "7/8"];
const SOURCE_NAMES: Record<ValueSource, string> = { file: "From file", detected: "Detected", set: "Set by you" };

function SourceChip(props: { source: ValueSource | null; chunk: string }) {
  if (!props.source) return <Chip>None</Chip>;
  return (
    <Chip tone={props.source === "file" ? "success" : props.source === "set" ? "accent" : "neutral"} title={props.source === "file" ? `From the ${props.chunk} chunk; the file isn't changed unless you use Write to file` : undefined}>
      {SOURCE_NAMES[props.source]}
      {props.source === "file" ? ` · ${props.chunk}` : ""}
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

export function TempoPopover(props: { edits: SampleEdits; commit(r: SampleEdit): void; detect?: DetectRun; disabled?: boolean }) {
  const t = props.edits.tempo;
  const det = useDetect("tempo", props.detect);
  const candidates = det.outcome?.applied && t?.source === "detected" ? (det.outcome.result.tempo?.candidates ?? []) : [];
  const [taps, setTaps] = useState<number[]>([]);
  const tap = tapResult(taps);
  const doTap = () => setTaps((x) => addTap(x, performance.now()));
  return (
    <ToolPopover label={t ? `${t.bpm} BPM ${t.meter}` : "Tempo"} title="Tempo and meter" heading="Tempo" disabled={props.disabled}>
      {() => (
        <div class="smp-form">
          <label>
            <span>BPM</span>
            <input type="number" min={20} max={400} step={0.1} value={t?.bpm ?? ""} placeholder="None" aria-label="BPM"
              onChange={(e) => {
                const v = Number((e.currentTarget as HTMLInputElement).value);
                props.commit(setTempo(props.edits, (e.currentTarget as HTMLInputElement).value === "" ? null : { bpm: v, meter: t?.meter ?? "4/4" }));
              }} />
          </label>
          <label>
            <span>Meter</span>
            <select aria-label="Meter" value={t?.meter ?? "4/4"} disabled={!t} onChange={(e) => t && props.commit(setTempo(props.edits, { bpm: t.bpm, meter: (e.currentTarget as HTMLSelectElement).value }))}>
              {METERS.map((m) => <option key={m} value={m}>{m}</option>)}
            </select>
          </label>
          <div class="smp-form-row">
            <span>Source</span>
            <SourceChip source={t?.source ?? null} chunk="acid" />
          </div>
          <div class="smp-tap">
            <button
              class="smp-tap-button"
              onClick={doTap}
              onKeyDown={(e) => {
                if (e.key === "t" || e.key === "T") {
                  e.preventDefault();
                  doTap();
                }
              }}
            >
              Tap
            </button>
            <span role="status" aria-live="polite">{tap ? `${tap.bpm} BPM · ${tap.steadiness} · ${tap.taps} taps` : "Tap the beat (Space, Enter or T)"}</span>
            <button disabled={!tap?.usable} onClick={() => tap && props.commit(setTempo(props.edits, { bpm: tap.bpm, meter: t?.meter ?? "4/4" }))}>Use</button>
          </div>
          {det.line && <p class="smp-muted" role="status" aria-live="polite">{det.line}</p>}
          {candidates.length > 0 && (
            <div class="smp-form-actions" aria-label="Tempo candidates">
              {candidates.map((c) => (
                <button key={c.relation} title={`${c.relation === "half" ? "Half" : "Double"} the detected tempo · ${Math.round(c.confidence * 100)} % sure`} aria-pressed={t?.bpm === c.bpm}
                  onClick={() => props.commit(tempoCandidateEdit(props.edits, c.bpm))}>
                  {c.relation === "half" ? "½×" : "2×"} {c.bpm} BPM
                </button>
              ))}
            </div>
          )}
          <div class="smp-form-actions">
            <button disabled={!props.detect || props.disabled || det.busy} title="Analyse the audio for its tempo (marked Detected; Clear or type to change it)" onClick={() => void det.start()}>{det.busy ? "Detecting…" : "Detect"}</button>
            <button disabled={!t} onClick={() => props.commit(setTempo(props.edits, null))}>Clear</button>
          </div>
        </div>
      )}
    </ToolPopover>
  );
}

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
  return (
    <ToolPopover label={r ? `${r.note}${r.cents ? ` ${r.cents > 0 ? "+" : ""}${r.cents}` : ""}` : "Root"} title="Root note" heading="Root note" disabled={props.disabled}>
      {() => (
        <div class="smp-form">
          <label>
            <span>Note</span>
            <input value={text} placeholder="C4" aria-label="Root note" aria-invalid={bad} onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
              onChange={() => !bad && props.commit(setRoot(props.edits, text.trim() === "" ? null : { note: text, cents: r?.cents ?? 0 }))} />
          </label>
          {bad && <p class="smp-field-error">Write a note like C4, F#3 or Bb2.</p>}
          <label>
            <span>Cents</span>
            <input type="number" min={-50} max={50} step={1} value={r?.cents ?? 0} disabled={!r} aria-label="Fine tune in cents"
              onChange={(e) => r && props.commit(setRoot(props.edits, { note: r.note, cents: Number((e.currentTarget as HTMLInputElement).value) }))} />
          </label>
          <div class="smp-form-row">
            <span>Source</span>
            <SourceChip source={r?.source ?? null} chunk="smpl" />
          </div>
          {det.line && <p class="smp-muted" role="status" aria-live="polite">{det.line}</p>}
          <div class="smp-form-actions">
            <button disabled={!props.detect || props.disabled || det.busy} title="Analyse the audio for its root note and fine tune (marked Detected)" onClick={() => void det.start()}>{det.busy ? "Detecting…" : "Detect"}</button>
            <button disabled={!r} onClick={() => props.commit(setRoot(props.edits, null))}>Clear</button>
          </div>
        </div>
      )}
    </ToolPopover>
  );
}

const db = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "−∞");

export function NormalizePopover(props: { edits: SampleEdits; measured: LoudnessMeasure | null; bextLoudness: number | null; commit(r: SampleEdit): void; disabled?: boolean }) {
  const n = props.edits.normalize;
  const m = props.measured;
  const clip = m ? clipAfterGain(m.peak, n.gainDb) : null;
  const label = n.mode === "off" ? "Normalize" : `${n.mode === "loudness" ? `${n.target} LUFS` : `${n.target} dBFS`}`;
  return (
    <ToolPopover label={label} title="Normalize" heading="Normalize" pressed={n.mode !== "off"} disabled={props.disabled}>
      {() => (
        <div class="smp-form">
          <p class="smp-muted" role="status">{m ? `Measured ${db(m.integrated)} LUFS · peak ${db(m.peak)} dBFS` : "Measuring…"}</p>
          {props.bextLoudness !== null && <p class="smp-muted">The file's bext says {props.bextLoudness.toFixed(1)} LUFS</p>}
          <SegmentedControl
            label="Normalize mode"
            value={n.mode}
            options={[{ value: "off", label: "Off" }, { value: "loudness", label: "Loudness" }, { value: "peak", label: "Peak" }]}
            onChange={(mode) => props.commit(setNormalize(props.edits, mode, mode === n.mode ? n.target : undefined, m))}
          />
          <p class="smp-muted">{n.mode === "off" ? "Play at the recorded level." : n.mode === "loudness" ? "Match a target loudness (integrated LUFS)." : "Match a target sample peak (dBFS)."}</p>
          {n.mode !== "off" && (
            <label>
              <span>Target</span>
              <input type="number" step={0.5} min={NORMALIZE_RANGES[n.mode][0]} max={NORMALIZE_RANGES[n.mode][1]} value={n.target} aria-label="Target"
                onChange={(e) => props.commit(setNormalize(props.edits, n.mode, Number((e.currentTarget as HTMLInputElement).value), m))} />
              <span class="smp-muted">{n.mode === "loudness" ? "LUFS" : "dBFS"}</span>
            </label>
          )}
          {n.mode !== "off" && (
            <p class="smp-muted">
              Gain {n.gainDb > 0 ? "+" : ""}{n.gainDb.toFixed(1)} dB{m && normalizeGain(n.mode, n.target, m) !== n.gainDb ? " (measured again: change the target to update)" : ""}. Stored as a gain; the file isn't changed. Applied last, after the effects.
            </p>
          )}
          {clip !== null && <p class="smp-warning" role="alert">Peaks would reach {clip > 0 ? "+" : ""}{clip.toFixed(1)} dBFS and clip</p>}
        </div>
      )}
    </ToolPopover>
  );
}

export function SnapPopover(props: { snap: SnapSetting; zero: boolean; onSnap(s: SnapSetting): void; onZero(on: boolean): void; disabled?: boolean }) {
  const s = props.snap;
  const [custom, setCustom] = useState("");
  const unitLabel: Record<SnapUnit, string> = { ms: "ms", samples: "Samples", beats: "Beats" };
  return (
    <ToolPopover label={s.on ? `Snap ${s.unit === "beats" ? `${s.step} beat` : `${s.step} ${s.unit === "ms" ? "ms" : "smp"}`}` : "Snap off"} title="Snapping" heading="Snap" pressed={s.on} disabled={props.disabled}>
      {() => (
        <div class="smp-form">
          <label class="smp-check">
            <input type="checkbox" checked={s.on} onChange={(e) => props.onSnap({ ...s, on: (e.currentTarget as HTMLInputElement).checked })} />
            Snap to the grid
          </label>
          <SegmentedControl label="Snap unit" value={s.unit} options={(["ms", "samples", "beats"] as const).map((u) => ({ value: u, label: unitLabel[u] }))}
            onChange={(unit) => props.onSnap({ on: true, unit, step: SNAP_PRESETS[unit][1].step })} />
          <div class="smp-form-actions">
            {SNAP_PRESETS[s.unit].map((p) => (
              <button key={p.step} class={s.step === p.step ? "on" : undefined} aria-pressed={s.step === p.step} onClick={() => props.onSnap({ on: true, unit: s.unit, step: p.step })}>{p.label}</button>
            ))}
          </div>
          <label>
            <span>Custom</span>
            <input value={custom} placeholder={s.unit === "beats" ? "1/3" : "25"} aria-label="Custom snap step" onInput={(e) => setCustom((e.currentTarget as HTMLInputElement).value)}
              onChange={() => {
                const v = parseSnapStep(custom, s.unit);
                if (v !== null) props.onSnap({ on: true, unit: s.unit, step: v });
              }} />
          </label>
          <label class="smp-check">
            <input type="checkbox" checked={props.zero} onChange={(e) => props.onZero((e.currentTarget as HTMLInputElement).checked)} />
            Snap to zero crossings
          </label>
        </div>
      )}
    </ToolPopover>
  );
}

export function TimeFormatPopover(props: { value: TimeFormat; hasTempo: boolean; onChange(f: TimeFormat): void }) {
  return (
    <ToolPopover label={TIME_FORMATS.find((f) => f.id === props.value)!.label} title="Time display" heading="Time display">
      {(close) => (
        <div class="smp-menu" role="menu">
          {TIME_FORMATS.map((f) => (
            <button key={f.id} role="menuitemradio" aria-checked={props.value === f.id} disabled={f.id === "bars" && !props.hasTempo} title={f.id === "bars" && !props.hasTempo ? "Set a tempo to show bars and beats" : undefined}
              onClick={() => {
                props.onChange(f.id);
                close();
              }}>
              <span class="smp-menu-check">{props.value === f.id && <Icon name="check" size={12} />}</span>
              {f.label}
            </button>
          ))}
        </div>
      )}
    </ToolPopover>
  );
}
