// The Inspector while a sequence is open (proto A9, spec §4.2.9): what the timeline's selection focuses, under a header
// with the colour chip, the kind badge ("Sequence", "Track", "Clip · 3 selected", "Sequence loop", "Hold point",
// "Marker") and the title; explanations live in tooltips (§1.3).
// - A clip: the "follows" banner with Make Async; the track and sample's folder with Open sample in Samples; Enabled (A),
//   Start, Length and Offset as timecode fields, Direction and Timing, Gain, Pitch (A) and Pan (A) sliders; clip effects
//   (Amp envelope, no Delay or Reverb, spec B.2); the sample's loops as cards (Inherited / Override, reset, Active,
//   the parameter condition, Exit, Exit fade, Re-entry) and markers (use or "Off here"); its automation.
// - A track: Name, Enabled (A), Colour (theme swatches, saved and custom colours), Volume (A) and Pan (A) sliders,
//   Output; track effects with the "Move to track" hint; its clips; its automation.
// - A sequence loop or hold point: Start and End (Make hold point beside it) and its behaviour card.
// - A marker: Name, At and its type. Selected automation points: their shape, the curve editor, delete.
// - Nothing: the sequence's Length and Tempo (Tap) above the playlist's own Inspector (playback, output, effects),
//   which the screen passes as children.
// The Automate (A) buttons open the curve editor on a click and the automate menu on a right-click; with Write armed a
// slider moved while playing writes its curve. A view over props and the shared selection.
import type { ComponentChildren } from "preact";
import { signal } from "@preact/signals";
import { useState } from "preact/hooks";
import { effectSpec, effectTypesAt } from "../../../../engine/audio/effects/catalogue";
import type { EffectType } from "../../../../engine/audio/effects/types";
import type { ParameterDef } from "../../../../engine/audio/parameters";
import { isLabelled, parameterDefault, parameterRange } from "../../../../engine/audio/parameters";
import type { PlaylistLint } from "../../../../engine/audio/playlist/lint";
import type { Automation, LoopBehaviour, PlaylistBody, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { evalCurve } from "../../../../engine/core/curve";
import { evalCurveBy, secondValueOf } from "../../../../engine/audio/curveBy";
import { SegmentedControl } from "../../../../editor/ui/SegmentedControl";
import { FieldRow, SelectBox, Section } from "../../../../editor/ui/PanelFields";
import { accept, type EditResult } from "../../../../editor/sdk/editResult";
import { Checkbox } from "../../../components/Checkbox";
import { ColourPicker, type ColourPreset } from "../../../components/ColourPicker";
import { EffectChain } from "../../../components/EffectChain";
import { Icon } from "../../../components/Icon";
import { isNewParameter, NEW_PARAMETER, NEW_PARAMETER_LABEL } from "../../../components/newParameterModel";
import { SliderField } from "../../../components/SliderField";
import type { TimeFormat } from "../../../components/timeRulerModel";
import { effectiveFormat, formatTime } from "../../../components/timeRulerModel";
import { chainNote } from "../chainCost";
import { AutomateButton } from "./AutomateButton";
import { automateLane, deletePoints as deletePointsOf, isTimeInput, ownerOf, pasteCurves, QUANTIZE_CHOICES, quantizeChoice, removeAutomation, setAutomation, setPointShape, SHAPES, targetSpec, writeAutomation, type AutomationOwner } from "./automationEdits";
import { clipFollows, clipLoops } from "./clipGeometry";
import { clearLoopOverride, makeHoldPoint, moveLoop, moveMarker, renameMarker, setLoopBehaviour, setLoopEdge, setLoopMusic, setLoopOverride, setMarkerColour, setMarkerHidden, setMarkerNote, setMarkerType } from "./loopMarkerEdits";
import { markColourCss, markColourOf } from "../../../../engine/audio/markColour";
import { markerTypeCss } from "./markerLook";
import { FadeShapeSelect } from "../../../components/FadeShapeSelect";
import { openSequenceCurves } from "./openSequenceCurves";
import { keepTaps, METERS, tapTempo } from "./sequenceGrid";
import { activeIcon, SeqIcon } from "./sequenceIcons";
import { makeAsync, moveEffectToTrack, setClip, setClipEffects, setMeter, setSequenceLength, setTempo, setTrack, setTrackEffects, sharedClipEffect } from "./sequenceEdits";
import { clipLength, findClip, onSequence, sequenceLength, type BodyEdit, type SeqEdit, type SourceOf } from "./sequenceModel";
import { clickClip } from "./sequenceSelection";
import { seqPlayhead, seqSelection, seqShownCurve, seqTimeFormat, touchWrite } from "./sequenceState";
import { clipName } from "./TimelineClip";
import { TimecodeField } from "./TimecodeField";
import { loopName } from "./timelineOverlays";
import "./sequence.css";
import { EmptyState } from "../../../../editor/ui/EmptyState";

export interface SequenceInspectorProps {
  readonly body: PlaylistBody;
  readonly writable: boolean;
  readonly title: string;
  readonly where: string;
  readonly lints: readonly PlaylistLint[];
  readonly sourceOf: SourceOf;
  readonly buses: readonly string[];
  readonly parameters: readonly ParameterDef[];
  /** The game parameters' test values (an automated control's live value). */
  readonly parameterValues?: Readonly<Record<string, number>>;
  /** "+ New parameter…" in its parameter selects and the curves' Driven by (J6.5): make a game parameter. */
  onNewParameter?(kind?: "numeric" | "labelled"): Promise<ParameterDef | null>;
  onEdit(label: string, edit: BodyEdit): void;
  onNotify(text: string): void;
  onOpenSamples?(sample: string): void;
  /** The playlist's own Inspector, shown under the Sequence section when nothing is selected. */
  readonly children?: ComponentChildren;
}

const ACTIVE = [
  { value: "always" as const, label: "Always", title: "Repeats for as long as the voice plays" },
  { value: "held" as const, label: "While held", title: "Repeats while the sequence is held; on release it leaves by its Exit setting" },
  { value: "parameter" as const, label: "Parameter", title: "Active while the bound parameter meets its condition" },
];
const EXIT = [
  { value: "jump" as const, label: "Jump now", title: "Leave the loop at once, from wherever the playhead is" },
  { value: "finish" as const, label: "Finish pass", title: "Play on to the loop end, then carry on" },
  { value: "crossfade" as const, label: "Crossfade", title: "Crossfade out of the loop into what follows" },
];
const REENTRY = [
  { value: "ignore" as const, label: "Ignore", title: "Once the playhead has left the loop, turning it active again does nothing" },
  { value: "reenter" as const, label: "Re-enter", title: "Turning it active again after the playhead left jumps back into the loop" },
];
const ACTIVE_NAME: Record<LoopBehaviour["active"], string> = { always: "Always", held: "While held", parameter: "Parameter" };
/** The track colour swatches (proto: six theme colours). */
const TRACK_COLOURS: readonly ColourPreset[] = [
  { name: "Teal", color: "var(--series-1)" }, { name: "Green", color: "var(--series-2)" }, { name: "Amber", color: "var(--series-3)" },
  { name: "Blue", color: "var(--series-4)" }, { name: "Pink", color: "var(--series-5)" }, { name: "Violet", color: "var(--series-6)" },
];
/** ADR 0362 item 4: marker flag swatches after its type's colour (theme tokens). */
const MARKER_COLOURS: readonly ColourPreset[] = [
  { name: "Amber", color: "var(--warning)" }, { name: "Cyan", color: "var(--accent)" }, { name: "Green", color: "var(--accent2)" },
  { name: "Red", color: "var(--danger)" }, { name: "Violet", color: "var(--series-6)" },
];
/** Spec B.2: a clip's Add effect list is the sequencer's minus Delay and Reverb, with the Amp envelope first. */
const CLIP_EFFECT_TYPES: readonly EffectType[] = ["envelope", ...effectTypesAt("instance").filter((t) => t !== "delay" && t !== "reverb" && t !== "envelope")];

/** Saved custom colours, shared by the Studio's colour pickers in this browser. */
const SAVED_KEY = "myco.studio.savedColours";
const savedColours = signal<string[]>((() => {
  try {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem(SAVED_KEY) : null;
    const list = raw ? (JSON.parse(raw) as unknown) : [];
    return Array.isArray(list) ? list.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
})());
function saveColours(list: string[]): void {
  savedColours.value = list;
  try {
    localStorage.setItem(SAVED_KEY, JSON.stringify(list));
  } catch {
    // Private windows: the palette lasts for the session.
  }
}

const colourOf = (c: number | string): string => (typeof c === "number" ? `var(--series-${c})` : c);
const colourValue = (css: string): number | string => {
  const m = /^var\(--series-(\d+)\)$/.exec(css);
  return m ? Number(m[1]) : css;
};

function Header(props: { readonly color?: string; readonly kind: string; readonly title: string }) {
  return (
    <div class="sq-tb">
      {props.color && <span class="sq-tb-chip" style={{ background: props.color }} />}
      <span class="sq-tb-badge">{props.kind}</span>
      <strong class="sq-tb-title" title={props.title}>{props.title}</strong>
    </div>
  );
}

/** A name field: Enter or leaving it commits, Escape puts it back. */
function NameField(props: { readonly value: string; readonly label: string; readonly disabled?: boolean; onValue(v: string): void }) {
  const [draft, setDraft] = useState<{ text: string; over: string } | null>(null);
  const text = draft && draft.over === props.value ? draft.text : props.value;
  const commit = (v: string) => {
    setDraft(null);
    if (v.trim() && v !== props.value) props.onValue(v.trim());
  };
  return (
    <input class="sq-text" aria-label={props.label} value={text} disabled={props.disabled}
      onInput={(e) => setDraft({ text: (e.currentTarget as HTMLInputElement).value, over: props.value })}
      onBlur={(e) => commit((e.currentTarget as HTMLInputElement).value)}
      onKeyDown={(e) => {
        if (e.key === "Enter") commit((e.currentTarget as HTMLInputElement).value);
        if (e.key === "Escape") {
          e.stopPropagation();
          setDraft(null);
          (e.currentTarget as HTMLInputElement).value = props.value;
        }
      }} />
  );
}

/** A row label in the 86 px column, then its control. */
function Fld(props: { readonly label: string; readonly title?: string; readonly children: ComponentChildren }) {
  return (
    <div class="sq-fld" title={props.title}>
      <span class="sq-fld-label">{props.label}</span>
      <span class="sq-fld-control">{props.children}</span>
    </div>
  );
}

export function SequenceInspector(props: SequenceInspectorProps) {
  const s = props.body.sequence!;
  const sel = seqSelection.value;
  const { writable } = props;
  const values = props.parameterValues ?? {};
  const playhead = seqPlayhead.value;
  const timeCtx = { rate: 48000, bpm: s.tempo?.bpm ?? null, meter: s.tempo?.meter ?? null };
  const format: TimeFormat = effectiveFormat(seqTimeFormat.value, timeCtx);
  const [taps, setTaps] = useState<number[]>([]);

  function run<X>(label: string, edit: (q: SequenceSettings) => EditResult<X>, pick: (x: X) => SequenceSettings): void {
    if (!writable) return;
    const r = edit(s);
    if ("refused" in r) return props.onNotify(`Can't ${label.charAt(0).toLowerCase()}${label.slice(1)}: ${r.refused}.`);
    if (pick(r.next) === s) return;
    props.onEdit(label, onSequence((q) => {
      const r2 = edit(q);
      return "refused" in r2 ? r2 : accept(pick(r2.next));
    }));
  }
  const runSeq = (label: string, edit: SeqEdit) => run(label, edit, (x) => x);
  const invalid = () => props.onNotify("Not a valid timecode");
  const tc = (label: string, value: number, onValue: (v: number) => void, title?: string) => (
    <TimecodeField label={label} value={value} format={format} context={timeCtx} disabled={!writable} title={title} onValue={onValue} onInvalid={invalid} />
  );

  const curves = (owner: AutomationOwner, length: number, name: string, lane?: string) =>
    openSequenceCurves({ doc: document, seq: s, owner, length, name, context: props.title, parameters: props.parameters, lane, playhead: seqPlayhead.peek(), commit: runSeq, newParameter: props.onNewParameter });

  /** The lanes of a property (a base target, or every lane of an effect `fx:<id>:`). */
  const lanesFor = (list: readonly Automation[], target: string) => list.filter((a) => (target.endsWith(":") ? a.target.startsWith(target) : a.target === target));
  /** A live value: the curve at the playhead (time) or at the parameter's test value. */
  const testValue = (name: string): number => {
    const v = values[name];
    const def = props.parameters.find((p) => p.name === name);
    return typeof v === "number" ? v : def ? parameterDefault(def) : 0;
  };
  const liveValue = (a: Automation, origin = 0) => {
    const x = isTimeInput(a.input) ? Math.max(0, playhead - origin) : testValue((a.input as { parameter: string }).parameter);
    // ADR 0362 §5: a lane that follows a second parameter, at its test value (as the runtime plays it).
    const second = a.by ? props.parameters.find((p) => p.name === a.by!.input) : undefined;
    return a.by && second ? evalCurveBy(a.curve, a.by, x, secondValueOf(second, testValue(second.name))) : evalCurve(a.curve, x);
  };

  const aButton = (owner: AutomationOwner, list: readonly Automation[], target: string, name: string, ownerName: string, length: number) => {
    const lanes = lanesFor(list, target);
    return (
      <AutomateButton name={name} lanes={lanes} owner={ownerName} writable={writable}
        onEdit={() => curves(owner, length, ownerName, target.endsWith(":") ? `${target}on` : target)}
        onPaste={(copied) => runSeq("Paste curves", (q) => pasteCurves(q, owner, copied))}
        onBypass={(bypass) => runSeq(`${name} automation ${bypass ? "off" : "on"}`, (q) => lanes.reduce<EditResult<SequenceSettings>>((r, a) => ("refused" in r ? r : setAutomation(r.next, owner, a.id, { bypass })), accept(q)))}
        onClear={() => runSeq(`Clear ${name} automation`, (q) => lanes.reduce<EditResult<SequenceSettings>>((r, a) => ("refused" in r ? r : removeAutomation(r.next, owner, a.id)), accept(q)))} />
    );
  };

  /** A slider row with its A button: locked showing the live value while automated; Write armed writes its curve. */
  const autoSlider = (o: {
    owner: AutomationOwner; list: readonly Automation[]; target: "volume" | "pan" | "pitch"; label: string; ownerName: string; length: number; origin?: number;
    value: number; min: number; max: number; step: number; unit: string; scale?: number; set(label: string, v: number): void;
  }) => {
    const lane = o.list.find((a) => a.target === o.target && !a.bypass);
    const k = o.scale ?? 1;
    const live = lane ? liveValue(lane, o.origin) * k : null;
    const key = `${JSON.stringify(o.owner)}:${o.target}`;
    return (
      <div class="sq-arow">
        <SliderField label={o.label} value={live ?? o.value} min={Math.min(o.min, o.value)} max={Math.max(o.max, o.value)} step={o.step} unit={o.unit}
          disabled={!writable || !!lane} note={lane ? `auto · ${(live ?? 0).toFixed(1)}${o.unit ? ` ${o.unit}` : ""}` : undefined}
          title={lane ? `${o.label} is automated by ${isTimeInput(lane.input) ? "the timeline" : (lane.input as { parameter: string }).parameter}` : undefined}
          onValue={(v, drag) => {
            const w = touchWrite(key, v / k, drag);
            if (w === null) return;
            if (w !== "plain") return run(`Write ${o.label} automation`, (q) => writeAutomation(q, o.owner, o.target, w), (x) => x.seq);
            if (!drag) o.set(o.label, v);
          }} />
        {aButton(o.owner, o.list, o.target, o.label, o.ownerName, o.length)}
      </div>
    );
  };

  const enabledRow = (on: boolean, toggle: () => void, owner: AutomationOwner, list: readonly Automation[], ownerName: string, length: number) => {
    const lane = list.find((a) => a.target === "enabled" && !a.bypass);
    return (
      <Fld label="Enabled">
        <button type="button" class={`sq-sbtn solo sq-onoff${on ? " on" : ""}`} aria-pressed={on} disabled={!writable}
          title={lane ? "Enabled is automated: click to edit its curve" : on ? "On · click to disable" : "Off · click to enable"}
          onClick={() => (lane ? curves(owner, length, ownerName, "enabled") : toggle())}>
          <SeqIcon name="power" size={11} /> {on ? "On" : "Off"}
        </button>
        <span class="sq-push" />
        {aButton(owner, list, "enabled", "Enabled", ownerName, length)}
      </Fld>
    );
  };

  const behaviourFields = (b: LoopBehaviour, set: (label: string, patch: Partial<LoopBehaviour>) => void, hold: boolean) => {
    const scalars = props.parameters.filter((p) => !isLabelled(p));
    const def = b.binding ? props.parameters.find((p) => p.name === b.binding!.parameter) : undefined;
    const [lo, hi] = def ? parameterRange(def) : [0, 1];
    return (
      <>
        <Fld label="Active">
          <SegmentedControl<LoopBehaviour["active"]> size="small" label="Loop active" value={b.active} options={ACTIVE}
            onChange={(v) => writable && set(`Loop active: ${ACTIVE_NAME[v]}`, v === "parameter" && !b.binding && scalars[0] ? { active: v, binding: { parameter: scalars[0].name, op: ">", value: 0.1 } } : { active: v })} />
        </Fld>
        {b.active === "parameter" && (
          <>
            <Fld label="Parameter" title="The loop is active while this holds">
              <SelectBox label="Bind parameter" value={b.binding?.parameter ?? ""} disabled={!writable}
                options={[{ value: "", label: "⚠ none" }, ...props.parameters.map((p) => ({ value: p.name, label: p.name })), ...(props.onNewParameter ? [{ value: NEW_PARAMETER, label: NEW_PARAMETER_LABEL }] : [])]}
                onValue={(v) => {
                  const bind = (name: string) => set("Bind parameter", { binding: name ? { parameter: name, op: b.binding?.op ?? ">", value: b.binding?.value ?? 0 } : undefined });
                  if (!isNewParameter(v)) return bind(v);
                  void props.onNewParameter?.("numeric").then((d) => d && bind(d.name));
                }} />
              <select class="kit-select sq-op" aria-label="Parameter condition" disabled={!writable || !b.binding} value={b.binding?.op ?? ">"}
                onChange={(e) => b.binding && set("Parameter condition", { binding: { ...b.binding, op: (e.currentTarget as HTMLSelectElement).value as ">" | "<" } })}>
                <option value=">">&gt;</option>
                <option value="<">&lt;</option>
              </select>
            </Fld>
            <SliderField label="Threshold" value={b.binding?.value ?? 0} min={Math.min(lo, b.binding?.value ?? 0)} max={Math.max(hi, b.binding?.value ?? 0)} step={(hi - lo) / 100 || 0.01} disabled={!writable || !b.binding}
              onValue={(v, drag) => !drag && b.binding && set("Threshold", { binding: { ...b.binding, value: Math.round(v * 1000) / 1000 } })} />
          </>
        )}
        {!hold && b.active !== "always" && (
          <Fld label="Exit">
            <SegmentedControl<LoopBehaviour["exit"]> size="small" label="Loop exit" value={b.exit} options={EXIT} onChange={(v) => writable && set("Loop exit", { exit: v })} />
          </Fld>
        )}
        {!hold && b.active !== "always" && b.exit === "crossfade" && (
          <SliderField label="Exit fade" value={b.exitFadeMs} min={0} max={2000} step={10} unit="ms" disabled={!writable} onValue={(v, drag) => !drag && set("Exit fade", { exitFadeMs: Math.round(v) })} />
        )}
        <Fld label="Re-entry">
          <SegmentedControl<LoopBehaviour["reentry"]> size="small" label="Loop re-entry" value={b.reentry} options={REENTRY} onChange={(v) => writable && set("Loop re-entry", { reentry: v })} />
        </Fld>
      </>
    );
  };

  const automationList = (owner: AutomationOwner, list: readonly Automation[], effects: Parameters<typeof targetSpec>[1], length: number, name: string, clipId?: string) => {
    if (!list.length) return null;
    return (
      <Section title="Automation" hint={"clip" in owner ? "Every curve on this clip: time curves read clip time; a curve may be driven by a parameter instead. The eye shows a curve on the clip." : "Every curve on this track: time curves read the sequence's time."}>
        <ul class="sq-auto-list">
          {list.map((a) => {
            const spec = targetSpec(a.target, effects);
            const nm = spec?.name ?? a.target;
            return (
              <li key={a.id}>
                <span class={a.bypass ? "off" : undefined} title={a.target}>{nm} <span class="sq-faint">{isTimeInput(a.input) ? "· time" : `· by ${(a.input as { parameter: string }).parameter}`}</span></span>
                {clipId && isTimeInput(a.input) && <button type="button" class="sq-ib" title="Show this curve on the clip" aria-label={`Show ${nm} on the clip`} onClick={() => (seqShownCurve.value = { ...seqShownCurve.peek(), [clipId]: a.id })}><Icon name="eye" size={13} /></button>}
                {!isTimeInput(a.input) && (
                  <select class="kit-select sq-quantize" aria-label={`${nm} quantize`} disabled={!writable} value={quantizeChoice(a.quantize)}
                    title="When a change of the parameter takes effect: continuously, or on the next beat or bar of the music (rhythm games)"
                    onChange={(e) => {
                      const v = (e.currentTarget as HTMLSelectElement).value;
                      const c = QUANTIZE_CHOICES.find((x) => x.value === v);
                      if (c) runSeq(`${nm} quantize: ${c.label}`, (q) => setAutomation(q, owner, a.id, { quantize: c.quantize }));
                    }}>
                    {[...QUANTIZE_CHOICES, ...(QUANTIZE_CHOICES.some((c) => c.value === quantizeChoice(a.quantize)) ? [] : [{ value: quantizeChoice(a.quantize), label: `Every ${quantizeChoice(a.quantize)} beats` }])].map((c) => <option key={c.value} value={c.value}>{c.label}</option>)}
                  </select>
                )}
                <button type="button" class="sq-ib" aria-label={`Edit ${nm} curve`} title="Open in the curve editor" onClick={() => curves(owner, length, name, a.target)}><Icon name="edit" size={13} /></button>
                <button type="button" class="sq-ib del" aria-label={`Remove ${nm} automation`} title="Delete this automation (Ctrl/⌘+Z to undo)" disabled={!writable} onClick={() => runSeq("Remove automation", (q) => removeAutomation(q, owner, a.id))}><Icon name="trash" size={13} /></button>
              </li>
            );
          })}
        </ul>
      </Section>
    );
  };

  // --- clips ---
  if ((sel.focus === "clips" || sel.focus === "points") && sel.clips.length >= 1) {
    const f = findClip(s, sel.clips[0]!);
    if (f) {
      const c = f.clip;
      const ids = sel.clips;
      const src = props.sourceOf(c);
      const len = clipLength(c, src);
      const set = (label: string, patch: Parameters<typeof setClip>[2]) => runSeq(label, (q) => setClip(q, c.id, patch));
      const follows = clipFollows(s, c.id, props.sourceOf);
      const followsTrack = follows ? s.tracks.find((t) => t.clips.some((x) => x.id === follows.id))?.name : null;
      const loops = clipLoops(c, src);
      const name = clipName(c);
      const owner = { clip: c.id };
      const dir = c.sample?.includes("/") ? c.sample.slice(0, c.sample.lastIndexOf("/")) : "";
      const allEnabled = ids.every((id) => findClip(s, id)?.clip.enabled);
      return (
        <div class="sq-inspector">
          <Header color={colourOf(f.track.color)} kind={ids.length > 1 ? `Clip · ${ids.length} selected` : "Clip"} title={name} />
          {follows && (
            <div class="sq-warnb" role="note">
              <Icon name="warning" size={14} />
              <span class="sq-warnb-text" title="It overlaps the Sync clip before it on this track, whose loop drives the playhead here, so this clip's loop is ignored">Follows {followsTrack} · {clipName(follows)}</span>
              <button type="button" class="sq-btn" disabled={!writable} onClick={() => runSeq("Clip async", (q) => makeAsync(q, c.id))}>Make Async</button>
            </div>
          )}
          {sel.focus === "points" && sel.points && <PointsSection {...props} s={s} runSeq={runSeq} curves={curves} />}
          <div class="sq-isec">
            <div class="sq-context">
              <span class="sq-context-text" title={c.sample ?? (typeof c.playlist === "string" ? c.playlist : "An embedded playlist; it resolves once when the playhead enters")}>{f.track.name}{dir ? ` · ${dir}` : typeof c.playlist === "string" ? ` · ${c.playlist}` : ""}</span>
              {c.sample !== undefined && props.onOpenSamples && (
                <button type="button" class="sq-ib" aria-label="Open sample in Samples" title="Open sample in Samples (Ctrl/⌘+1)" onClick={() => props.onOpenSamples!(c.sample!)}><Icon name="samples" size={14} /></button>
              )}
            </div>
            {enabledRow(ids.length > 1 ? allEnabled : c.enabled, () => runSeq(`${allEnabled ? "Disable" : "Enable"} ${ids.length > 1 ? `${ids.length} clips` : "clip"}`, (q) => ids.reduce<EditResult<SequenceSettings>>((r, id) => ("refused" in r ? r : setClip(r.next, id, { enabled: !allEnabled })), accept(q))), owner, c.automation, name, len)}
            <Fld label="Start">{tc("Clip start", c.at, (v) => set("Clip start", { at: v }), "Where the clip starts in the sequence · type a timecode or seconds · Enter to apply, Esc to cancel")}</Fld>
            <Fld label="Length">{tc("Clip length", len, (v) => set("Clip length", { length: v }), "How long the clip plays (past the sample's end, its loop repeats to fill it) · Enter to apply, Esc to cancel")}</Fld>
            <Fld label="Offset">{tc("Clip offset", c.offset, (v) => set("Clip offset", { offset: v }), "Where in the sample it starts · Enter to apply, Esc to cancel")}</Fld>
            <Fld label="Direction">
              <SegmentedControl<"forward" | "reverse"> size="small" label="Direction" value={c.reverse ? "reverse" : "forward"}
                options={[{ value: "forward", label: "Forward" }, { value: "reverse", label: "Reverse", title: "Plays the clip's span backwards: its tail first, its loop's passes backwards inside the span" }]}
                onChange={(v) => writable && set(v === "reverse" ? "Reverse clip" : "Forward clip", { reverse: v === "reverse" })} />
            </Fld>
            <Fld label="Timing">
              <SegmentedControl<"sync" | "async"> size="small" label="Clip timing" value={c.sync ? "sync" : "async"}
                options={[
                  { value: "sync", label: "Sync", title: "Locked to the sequence playhead: when this clip loops, leaves at an Exit marker or skips to its tail, the playhead moves with it" },
                  { value: "async", label: "Async", title: "Runs on its own clock: the clip keeps looping or plays its tail while the sequence playhead moves on or waits at a hold point" },
                ]}
                onChange={(v) => writable && set(v === "sync" ? "Clip sync" : "Clip async", { sync: v === "sync" })} />
            </Fld>
            <div class="sq-arow">
              <SliderField label="Gain" value={c.gain} min={Math.min(-48, c.gain)} max={Math.max(12, c.gain)} step={0.5} unit="dB" disabled={!writable} onValue={(v, drag) => !drag && set("Clip gain", { gain: v })} />
              <span class="sq-abtn-space" />
            </div>
            {autoSlider({ owner, list: c.automation, target: "pitch", label: "Pitch", ownerName: name, length: len, origin: c.at, value: c.pitch, min: -12, max: 12, step: 0.1, unit: "st", set: (l, v) => set("Clip pitch", { pitch: v }) })}
            {autoSlider({ owner, list: c.automation, target: "pan", label: "Pan", ownerName: name, length: len, origin: c.at, value: Math.round(c.pan * 100), min: -100, max: 100, step: 1, unit: "%", scale: 100, set: (l, v) => set("Clip pan", { pan: v / 100 }) })}
          </div>
          <div class="sq-isec">
            <EffectChain effects={c.effects} level="instance" types={CLIP_EFFECT_TYPES} readOnly={!writable} title="Clip effects" note={chainNote("clip", c.effects)}
              onEdit={(r, label) => run(label, (q) => ("refused" in r ? r : setClipEffects(q, c.id, r.next)), (x) => x)}
              onAutomate={(fxId) => curves(owner, len, name, automateLane(c.effects, fxId))} />
          </div>
          {c.sample !== undefined && (
            <Section title={`Loops${loops.length ? ` · ${loops.length}` : ""}`} hint="The sample's loops. Changing one here overrides it in this clip only; reset goes back to the sample's settings.">
              {loops.length === 0 && <EmptyState compact title="No loops" />}
              {loops.map((l, i) => (
                <div key={l.id} class="sq-lpb">
                  <div class="sq-lph">
                    <SeqIcon name={activeIcon(l.active)} size={12} />
                    <strong>Loop {i + 1}</strong>
                    <span class="sq-faint">{l.start === l.end ? `at ${formatTime(l.start, "timecode", timeCtx)}` : `${l.start.toFixed(2)} s – ${l.end.toFixed(2)} s`}</span>
                    <span class="sq-push" />
                    <span class={`sq-badge ${l.overridden ? "override" : "inherited"}`} title={l.overridden ? "This clip uses its own settings for this loop" : "Uses the settings stored on the sample"}>{l.overridden ? "Override" : "Inherited"}</span>
                    <button type="button" class="sq-ib" aria-label="Use the sample's settings" title="Use the sample's settings" disabled={!writable || !l.overridden} onClick={() => runSeq("Use sample loop settings", (q) => clearLoopOverride(q, c.id, l.id))}><Icon name="undo" size={13} /></button>
                  </div>
                  {behaviourFields(l, (label, patch) => runSeq(label, (q) => setLoopOverride(q, c.id, l.id, patch)), l.start === l.end)}
                </div>
              ))}
            </Section>
          )}
          {c.sample !== undefined && (
            <Section title={`Markers${src?.markers.length ? ` · ${src.markers.length}` : ""}`} hint="The sample's markers. Turn one off for this clip only (an Exit marker turned off isn't a way out here).">
              {!src?.markers.length && <EmptyState compact title="No markers" />}
              {src?.markers.map((m) => {
                const on = !c.hiddenMarkers.includes(m.id);
                return (
                  <div key={m.id} class={`sq-mrow${on ? "" : " off"}`} title={m.type === "cue" ? "Cue marker: the game is told when the clip passes it" : m.type === "exit" ? "Exit marker: music may leave here" : "Marker from the sample"}>
                    <Checkbox checked={on} ariaLabel={`Use ${m.name} in this clip`} disabled={!writable} onChange={(use) => runSeq(use ? "Use marker in clip" : "Ignore marker in clip", (q) => setMarkerHidden(q, c.id, m.id, !use))} />
                    <span class="sq-mrow-name">{m.name}</span>
                    <span class="sq-faint sq-mono">{m.at.toFixed(2)} s</span>
                    <span class="sq-push" />
                    <span class={`sq-badge ${on ? "inherited" : "override"}`}>{on ? "Inherited" : "Off here"}</span>
                  </div>
                );
              })}
            </Section>
          )}
          {automationList(owner, c.automation, c.effects, len, name, c.id)}
        </div>
      );
    }
  }

  // --- a track ---
  if (sel.focus === "track" && sel.track) {
    const t = s.tracks.find((x) => x.id === sel.track);
    if (t) {
      const set = (label: string, patch: Parameters<typeof setTrack>[2]) => runSeq(label, (q) => setTrack(q, t.id, patch));
      const length = sequenceLength(s, props.sourceOf);
      const owner = { track: t.id };
      const shared = sharedClipEffect(t);
      return (
        <div class="sq-inspector">
          <Header color={colourOf(t.color)} kind={t.kind === "audio" ? "Track" : "Synth track"} title={t.name} />
          <div class="sq-isec">
            <Fld label="Name"><NameField value={t.name} label="Track name" disabled={!writable} onValue={(v) => set("Rename track", { name: v })} /></Fld>
            {enabledRow(t.enabled, () => set(t.enabled ? "Disable track" : "Enable track", { enabled: !t.enabled }), owner, t.automation, t.name, length)}
            <Fld label="Colour">
              <ColourPicker label="Track colour" value={colourOf(t.color)} presets={TRACK_COLOURS} saved={savedColours.value} disabled={!writable}
                onChange={(css) => set("Track colour", { color: colourValue(css) })} onSavedChange={saveColours} />
            </Fld>
            {autoSlider({ owner, list: t.automation, target: "volume", label: "Volume", ownerName: t.name, length, value: t.volume, min: -60, max: 12, step: 0.5, unit: "dB", set: (l, v) => set("Track volume", { volume: v }) })}
            {autoSlider({ owner, list: t.automation, target: "pan", label: "Pan", ownerName: t.name, length, value: Math.round(t.pan * 100), min: -100, max: 100, step: 1, unit: "%", scale: 100, set: (l, v) => set("Track pan", { pan: v / 100 }) })}
            <Fld label="Output">
              <SelectBox label="Track output" value={t.output ?? ""} disabled={!writable} options={[{ value: "", label: "Sequence" }, ...props.buses.map((b) => ({ value: b, label: b }))]} onValue={(v) => set("Track output", { output: v || null })} />
            </Fld>
          </div>
          <div class="sq-isec">
            <EffectChain effects={t.effects} level="instance" readOnly={!writable} title="Track effects" note={chainNote("track", t.effects)}
              onEdit={(r, label) => run(label, (q) => ("refused" in r ? r : setTrackEffects(q, t.id, r.next)), (x) => x)}
              onAutomate={(fxId) => curves(owner, length, t.name, automateLane(t.effects, fxId))} />
            {shared && (
              <div class="sq-fxmv">
                <span>Every clip on this track has {effectSpec(shared).label}. Moving it here runs it once on the track mix instead of on each voice.</span>
                <button type="button" class="sq-btn" disabled={!writable} onClick={() => runSeq(`Move ${effectSpec(shared).label} to track`, (q) => moveEffectToTrack(q, t.id, shared))}>Move to track</button>
              </div>
            )}
          </div>
          <Section title={`Clips · ${t.clips.length}`} hint="Click one to select it">
            {t.clips.length === 0 && <EmptyState compact title="No clips" />}
            {[...t.clips].sort((a, b) => a.at - b.at).map((c) => (
              <button key={c.id} type="button" class="sq-frow" onClick={() => (seqSelection.value = clickClip(sel, c.id, t.id))}>
                <span class="sq-frow-name">{clipName(c)}</span>
                <span class="sq-faint sq-mono">{formatTime(c.at, format, timeCtx)}</span>
              </button>
            ))}
          </Section>
          {automationList(owner, t.automation, t.effects, length, t.name)}
        </div>
      );
    }
  }

  // --- a loop of the sequence ---
  if (sel.focus === "loop" && sel.loop) {
    const l = s.loops.find((x) => x.id === sel.loop);
    if (l) {
      const hold = l.start === l.end;
      return (
        <div class="sq-inspector">
          <Header kind={hold ? "Hold point" : "Sequence loop"} title={loopName(s, l.id)} />
          <div class="sq-isec">
            <Fld label="Start">{tc("Loop start", l.start, (v) => runSeq(hold ? "Move loop" : "Loop start", (q) => (hold ? moveLoop(q, l.id, v - l.start) : setLoopEdge(q, l.id, "start", v))))}</Fld>
            <Fld label="End">
              {tc("Loop end", l.end, (v) => runSeq("Loop end", (q) => setLoopEdge(q, l.id, "end", v)))}
              <button type="button" class="sq-ib" aria-label="Make hold point" title={hold ? "Already a hold point (drag its right cap to stretch it into a loop)" : "Make hold point (end = start)"} disabled={!writable || hold} onClick={() => runSeq("Make hold point", (q) => makeHoldPoint(q, l.id))}><SeqIcon name="addHold" size={13} /></button>
            </Fld>
            <div class="sq-lpb">
              {behaviourFields(l, (label, patch) => runSeq(label, (q) => setLoopBehaviour(q, l.id, patch)), hold)}
              {!hold && l.exit === "crossfade" && l.active !== "always" && (
                <Fld label="Exit shape" title="The shape of the exit crossfade (both sides)">
                  <FadeShapeSelect label="Loop exit shape" out value={l.exitShape ?? "equalPower"} disabled={!writable} onValue={(v) => runSeq("Loop exit shape", (q) => setLoopMusic(q, l.id, { exitShape: v }))} />
                </Fld>
              )}
              {!hold && (
                <Fld label="Tail" title="At each wrap, the audio from the loop's end to the next Exit marker after it rings on over the next pass">
                  <Checkbox checked={!!l.tail} label="Ring the tail" disabled={!writable} onChange={() => runSeq(l.tail ? "Loop tail off" : "Loop tail on", (q) => setLoopMusic(q, l.id, { tail: !l.tail }))} />
                  {l.tail && !s.markers.some((m) => m.type === "exit" && m.at > l.end + 1e-9) && <span class="sq-warn-icon" title="No Exit marker after the loop's end: add one where the tail ends"><Icon name="warning" size={14} label="No Exit marker after the loop's end" /></span>}
                </Fld>
              )}
            </div>
          </div>
        </div>
      );
    }
  }

  // --- a marker ---
  if (sel.focus === "marker" && sel.marker) {
    const m = s.markers.find((x) => x.id === sel.marker);
    if (m) {
      return (
        <div class="sq-inspector">
          <Header color={m.colour ? markColourCss(m.colour) : markerTypeCss(m.type)} kind="Marker" title={m.name} />
          <div class="sq-isec">
            <Fld label="Name"><NameField value={m.name} label="Marker name" disabled={!writable} onValue={(v) => runSeq("Rename marker", (q) => renameMarker(q, m.id, v))} /></Fld>
            <Fld label="At">{tc("Marker time", m.at, (v) => runSeq("Move marker", (q) => moveMarker(q, m.id, v)))}</Fld>
            <Fld label="Type">
              <SegmentedControl<"note" | "cue" | "exit" | "entry"> size="small" label="Marker type" value={m.type ?? "note"} onChange={(v) => writable && runSeq("Marker type", (q) => setMarkerType(q, m.id, v))}
                options={[
                  { value: "note", label: "Note", title: "A note for you; the runtime ignores it" }, { value: "cue", label: "Cue", title: "Reported to the game when the playhead passes it" },
                  { value: "exit", label: "Exit", title: "Music may leave here; what follows the first Exit marker is the tail that rings on" },
                  { value: "entry", label: "Entry", title: "A Switch lands this point on its beat or bar; the audio before it starts early" },
                ]} />
            </Fld>
            <Fld label="Colour" title="The flag's colour on the timeline (the first swatch: its type's colour)">
              <ColourPicker label="Marker colour" value={m.colour ? markColourCss(m.colour) : markerTypeCss(m.type)} presets={[{ name: "Its type's colour", color: markerTypeCss(m.type) }, ...MARKER_COLOURS]} saved={savedColours.value} disabled={!writable}
                onChange={(css) => runSeq("Marker colour", (q) => setMarkerColour(q, m.id, css === markerTypeCss(m.type) ? null : markColourOf(css)))} onSavedChange={saveColours} />
            </Fld>
            <Fld label="Note" title="A note for the team; the runtime ignores it">
              <textarea class="sq-note" aria-label="Marker note" rows={3} placeholder="Add a note" value={m.note ?? ""} disabled={!writable}
                onChange={(e) => { const v = (e.currentTarget as HTMLTextAreaElement).value; if (v !== (m.note ?? "")) runSeq("Marker note", (q) => setMarkerNote(q, m.id, v)); }} />
            </Fld>
          </div>
        </div>
      );
    }
  }

  // --- track points ---
  if (sel.focus === "points" && sel.points) {
    return <div class="sq-inspector"><PointsSection {...props} s={s} runSeq={runSeq} curves={curves} /></div>;
  }

  // --- the sequence ---
  const length = sequenceLength(s, props.sourceOf);
  const tap = () => {
    const next = keepTaps(taps, performance.now());
    setTaps(next);
    const bpm = tapTempo(next);
    if (bpm !== null) runSeq("Tap tempo", (q) => setTempo(q, bpm));
    else props.onNotify("Tap again on the next beat");
  };
  return (
    <div class="sq-inspector">
      <Header color="var(--accent)" kind="Sequence" title={props.title} />
      <div class="sq-isec">
        <Fld label="Name" title="Rename it in the Playlist panel's header (the pencil) or the Playlists tree"><span class="sq-readonly">{props.title}</span></Fld>
        <Fld label="Length" title={s.length === 0 ? "To the end of the longest clip until set" : undefined}>{tc("Sequence length", length, (v) => runSeq("Sequence length", (q) => setSequenceLength(q, Math.max(0.1, v))), "The sequence's end · type a timecode or seconds · Enter to apply, Esc to cancel")}</Fld>
        <Fld label="Tempo" title="The grid, the bars display and the musical clock (Switch rules timed to beats and bars)">
          <input class="sq-num tempo" aria-label="Tempo" placeholder="none" disabled={!writable} value={s.tempo?.bpm ?? ""}
            onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()}
            onChange={(e) => {
              const raw = (e.currentTarget as HTMLInputElement).value.trim();
              if (raw === "") return s.tempo && runSeq("No tempo", (q) => setTempo(q, null));
              const v = Number(raw);
              if (Number.isFinite(v) && v >= 20 && v <= 400) runSeq("Tempo", (q) => setTempo(q, v));
              else props.onNotify("Not a valid tempo (20–400 BPM)");
            }} />
          <span class="sq-unit">BPM</span>
          <button type="button" class="sq-btn" disabled={!writable} title="Tap on the beat two or more times; averages the last 8 taps, a pause over 2.5 s starts a new count" onClick={tap}>Tap</button>
        </Fld>
        {s.tempo && (
          <Fld label="Meter">
            <SelectBox label="Meter" value={s.tempo.meter} disabled={!writable} options={[...new Set([...METERS, s.tempo.meter])].map((m) => ({ value: m, label: m }))} onValue={(v) => runSeq("Meter", (q) => setMeter(q, v))} />
          </Fld>
        )}
      </div>
      {props.children}
    </div>
  );
}

/** Selected automation points: their shape and values, delete, and the curve editor. */
function PointsSection(props: SequenceInspectorProps & { readonly s: SequenceSettings; runSeq(label: string, edit: SeqEdit): void; curves(owner: AutomationOwner, length: number, name: string, lane?: string): void }) {
  const p = seqSelection.value.points!;
  const v = ownerOf(props.s, p.owner);
  const lane = v?.automation.find((a) => a.id === p.automation);
  if (!v || !lane) return null;
  const spec = targetSpec(lane.target, v.effects);
  const keys = p.keys.filter((k) => k < lane.curve.length);
  const owner = p.owner;
  const name = "clip" in owner ? clipName(findClip(props.s, owner.clip)!.clip) : props.s.tracks.find((t) => t.id === owner.track)?.name ?? "";
  const length = "clip" in owner ? clipLength(findClip(props.s, owner.clip)!.clip, props.sourceOf(findClip(props.s, owner.clip)!.clip)) : sequenceLength(props.s, props.sourceOf);
  const one = keys.length === 1 ? lane.curve[keys[0]!]! : null;
  return (
    <Section title={`${keys.length === 1 ? "Point" : `${keys.length} points`} · ${spec?.name ?? lane.target}`} hint={`On ${name}. Drag points on the timeline; double-click deletes one; Delete removes the selection.`}>
      {one && (
        <>
          <FieldRow label="Time" unit="s"><span class="pl-num-text">{one[0].toFixed(3)}</span></FieldRow>
          <FieldRow label="Value" unit={spec?.unit}><span class="pl-num-text">{one[1].toFixed(2)}</span></FieldRow>
        </>
      )}
      <FieldRow label="Shape">
        <SelectBox label="Curve shape" value={one && one.length >= 3 && one[2] !== "bezier" ? (one[2] as string) : "linear"} disabled={!props.writable}
          options={SHAPES.map((x) => ({ value: x.shape, label: x.label }))} onValue={(sh) => props.runSeq(`Curve shape: ${SHAPES.find((x) => x.shape === sh)?.label ?? sh}`, (q) => setPointShape(q, owner, lane.id, keys, sh as never))} />
      </FieldRow>
      <div class="sq-actions">
        <button type="button" class="sq-btn" onClick={() => props.curves(owner, length, name, lane.target)}>Open in curve editor…</button>
        <button type="button" class="sq-btn del" disabled={!props.writable} onClick={() => props.runSeq(keys.length > 1 ? "Delete automation points" : "Delete automation point", (q) => deletePointsOf(q, owner, lane.id, keys))}>Delete</button>
      </div>
    </Section>
  );
}
