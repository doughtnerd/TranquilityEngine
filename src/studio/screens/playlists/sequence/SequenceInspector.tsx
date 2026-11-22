// The Inspector while a sequence is open (proto §4; the Sequencer's inspector): what the timeline's selection focuses.
// A clip: gain, pitch, pan, start, length (0 = to the end), offset, reverse, Sync/Async (with the lint's "Make Async"),
// the sample's loops with this clip's overrides ("Override" / "Inherited", "Use sample loop settings"), its sample
// markers (use or ignore here), effects at voice level, and its automation. A track: name, colour, volume, pan,
// output, mute, solo, enabled, effects at instance level, automation. A loop or a marker of the sequence, selected
// points, and with nothing selected the sequence itself (length, tempo, meter) above the playlist's own Inspector
// (playback rules, output, effects), which the screen passes as children. A view over props and the shared selection.
import type { ComponentChildren } from "preact";
import type { ParameterDef } from "../../../../engine/audio/eventFormat";
import { isLabelled } from "../../../../engine/audio/eventFormat";
import type { PlaylistLint } from "../../../../engine/audio/playlist/lint";
import type { Automation, LoopBehaviour, PlaylistBody, SequenceSettings } from "../../../../engine/audio/playlist/types";
import { SegmentedControl } from "../../../../editor/ui/SegmentedControl";
import { accept, type EditResult } from "../../../../plugins/audio/editor/editResult";
import { EffectChain } from "../../../components/EffectChain";
import { FieldRow, NumberBox, SelectBox, Section } from "../fields";
import { addAutomation, deletePoints as deletePointsOf, isTimeInput, ownerOf, removeAutomation, setAutomation, setPointShape, SHAPES, targetSpec, targetSpecs, type AutomationOwner } from "./automationEdits";
import { clipFollows, clipLoops } from "./clipGeometry";
import { clearLoopOverride, deleteLoops, deleteMarkers, makeHoldPoint, moveLoop, moveMarker, renameMarker, setLoopBehaviour, setLoopEdge, setLoopOverride, setMarkerHidden, setMarkerType } from "./loopMarkerEdits";
import { openSequenceCurves } from "./openSequenceCurves";
import { makeAsync, setClip, setClipEffects, setMeter, setSequenceLength, setTempo, setTrack, setTrackEffects } from "./sequenceEdits";
import { METERS } from "./sequenceGrid";
import { clipLength, findClip, onSequence, sequenceLength, type BodyEdit, type SeqEdit, type SourceOf } from "./sequenceModel";
import { seqPlayhead, seqSelection, seqShownCurve } from "./sequenceState";
import { clipName } from "./TimelineClip";
import "./sequence.css";

export interface SequenceInspectorProps {
  readonly body: PlaylistBody;
  readonly writable: boolean;
  readonly title: string;
  readonly where: string;
  readonly lints: readonly PlaylistLint[];
  readonly sourceOf: SourceOf;
  readonly buses: readonly string[];
  readonly parameters: readonly ParameterDef[];
  onEdit(label: string, edit: BodyEdit): void;
  onNotify(text: string): void;
  onOpenSamples?(sample: string): void;
  /** The playlist's own Inspector, shown under the Sequence section when nothing is selected. */
  readonly children?: ComponentChildren;
}

const ACTIVE = [
  { value: "always" as const, label: "Always", title: "Repeats for as long as the voice plays" },
  { value: "held" as const, label: "While held", title: "Repeats while held; on release it leaves by its exit" },
  { value: "parameter" as const, label: "Parameter", title: "Active while a parameter condition holds" },
];
const EXIT: { value: LoopBehaviour["exit"]; label: string }[] = [
  { value: "finish", label: "Finish pass" },
  { value: "jump", label: "Jump now" },
  { value: "crossfade", label: "Crossfade" },
];
const REENTRY: { value: LoopBehaviour["reentry"]; label: string }[] = [
  { value: "ignore", label: "Ignore" },
  { value: "reenter", label: "Re-enter" },
];
const ACTIVE_NAME: Record<LoopBehaviour["active"], string> = { always: "Always", held: "While held", parameter: "Parameter" };

export function SequenceInspector(props: SequenceInspectorProps) {
  const s = props.body.sequence!;
  const sel = seqSelection.value;
  const { writable } = props;

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

  const curves = (owner: AutomationOwner, length: number, name: string, lane?: string) =>
    openSequenceCurves({ doc: document, seq: s, owner, length, name, context: props.title, parameters: props.parameters, lane, playhead: seqPlayhead.peek(), commit: runSeq });

  const automationList = (owner: AutomationOwner, list: readonly Automation[], effects: Parameters<typeof targetSpecs>[0], length: number, name: string, clipId?: string) => {
    const specs = targetSpecs(effects);
    const free = specs.filter((t) => !list.some((a) => a.target === t.target));
    return (
      <Section title="Automation" note={"clip" in owner ? "Time curves read clip time; a curve may be driven by a parameter instead." : "Time curves read the sequence's time."}>
        {list.length === 0 && <p class="pl-note">None yet.</p>}
        <ul class="sq-auto-list">
          {list.map((a) => {
            const spec = targetSpec(a.target, effects);
            const nm = spec?.name ?? a.target;
            return (
              <li key={a.id}>
                <span title={a.target}>{nm} <span class="sq-faint">{isTimeInput(a.input) ? "· time" : `· by ${(a.input as { parameter: string }).parameter}`}</span></span>
                {clipId && isTimeInput(a.input) && <button type="button" class="sq-icon" title="Show this curve on the clip" aria-label={`Show ${nm} on the clip`} onClick={() => (seqShownCurve.value = { ...seqShownCurve.peek(), [clipId]: a.id })}>👁</button>}
                <button type="button" class={`sq-icon${a.bypass ? "" : " on"}`} aria-pressed={!a.bypass} aria-label={`${nm} automation on`} disabled={!writable} title={a.bypass ? "Bypassed (click to turn on)" : "On (click to bypass)"}
                  onClick={() => runSeq(`${nm} automation ${a.bypass ? "on" : "off"}`, (q) => setAutomation(q, owner, a.id, { bypass: !a.bypass }))}>●</button>
                <button type="button" class="sq-icon" aria-label={`Edit ${nm} curve`} title="Open in the curve editor" onClick={() => curves(owner, length, name, a.target)}>✎</button>
                <button type="button" class="sq-icon" aria-label={`Remove ${nm} automation`} title="Remove automation" disabled={!writable} onClick={() => runSeq("Remove automation", (q) => removeAutomation(q, owner, a.id))}>×</button>
              </li>
            );
          })}
        </ul>
        <div class="pl-kv">
          <span class="pl-field-label">Automate</span>
          <select class="pl-select" aria-label="Automate" disabled={!writable || !free.length} value="" onChange={(e) => {
            const target = (e.currentTarget as HTMLSelectElement).value;
            const t = specs.find((x) => x.target === target);
            if (t) run(`Automate ${t.name}`, (q) => addAutomation(q, owner, t.target, length), (x) => x.seq);
          }}>
            <option value="">Choose a property…</option>
            {free.map((t) => <option key={t.target} value={t.target}>{t.name}</option>)}
          </select>
        </div>
        <button type="button" class="pl-small" onClick={() => curves(owner, length, name)}>Edit curves…</button>
      </Section>
    );
  };

  const behaviourFields = (b: LoopBehaviour, set: (label: string, patch: Partial<LoopBehaviour>) => void) => {
    const scalars = props.parameters.filter((p) => !isLabelled(p));
    return (
      <>
        <div class="pl-kv">
          <span class="pl-field-label">Active</span>
          <SegmentedControl<LoopBehaviour["active"]> size="small" label="Loop active" value={b.active} options={ACTIVE}
            onChange={(v) => set(`Loop active: ${ACTIVE_NAME[v]}`, v === "parameter" && !b.binding && scalars[0] ? { active: v, binding: { parameter: scalars[0].name, op: ">", value: 0.1 } } : { active: v })} />
        </div>
        {b.active === "parameter" && (
          <FieldRow label="While" title="The loop is active while this holds">
            <SelectBox label="Bind parameter" value={b.binding?.parameter ?? ""} disabled={!writable} options={[{ value: "", label: "⚠ none" }, ...props.parameters.map((p) => ({ value: p.name, label: p.name }))]}
              onValue={(v) => set("Bind parameter", { binding: v ? { parameter: v, op: b.binding?.op ?? ">", value: b.binding?.value ?? 0 } : undefined })} />
            <SelectBox<">" | "<"> label="Parameter condition" value={b.binding?.op ?? ">"} disabled={!writable || !b.binding} options={[{ value: ">", label: ">" }, { value: "<", label: "<" }]}
              onValue={(v) => b.binding && set("Parameter condition", { binding: { ...b.binding, op: v } })} />
            <NumberBox label="Threshold" value={b.binding?.value ?? 0} step={0.01} digits={3} disabled={!writable || !b.binding} onValue={(v) => b.binding && set("Threshold", { binding: { ...b.binding, value: v } })} />
          </FieldRow>
        )}
        <FieldRow label="Exit" title="When it stops being active: finish the pass, leave at once, or crossfade out">
          <SelectBox label="Loop exit" value={b.exit} options={EXIT} disabled={!writable} onValue={(v) => set("Loop exit", { exit: v })} />
          {b.exit === "crossfade" && <><NumberBox label="Exit fade" value={b.exitFadeMs} min={0} max={2000} step={10} digits={0} disabled={!writable} onValue={(v) => set("Exit fade", { exitFadeMs: v })} /><span class="pl-unit">ms</span></>}
        </FieldRow>
        <FieldRow label="Re-entry" title="Turning active again after the playhead left: ignore, or jump back in">
          <SelectBox label="Loop re-entry" value={b.reentry} options={REENTRY} disabled={!writable} onValue={(v) => set("Loop re-entry", { reentry: v })} />
        </FieldRow>
      </>
    );
  };

  // --- clips ---
  if (sel.focus === "clips" && sel.clips.length > 1) {
    return (
      <div class="sq-inspector">
        <Section title={`${sel.clips.length} clips selected`} note="Drag one to move them together; E enables or disables them; Del deletes them.">
          <p class="pl-note">Select one clip to edit its settings.</p>
        </Section>
      </div>
    );
  }
  if ((sel.focus === "clips" || sel.focus === "points") && sel.clips.length === 1) {
    const f = findClip(s, sel.clips[0]!);
    if (f) {
      const c = f.clip;
      const src = props.sourceOf(c);
      const len = clipLength(c, src);
      const set = (label: string, patch: Parameters<typeof setClip>[2]) => runSeq(label, (q) => setClip(q, c.id, patch));
      const follows = clipFollows(props.lints, `${props.where ? `${props.where}.` : ""}sequence.tracks[${f.ti}]`, f.track, c);
      const loops = clipLoops(c, src);
      const name = clipName(c);
      return (
        <div class="sq-inspector">
          {sel.focus === "points" && sel.points && <PointsSection {...props} s={s} runSeq={runSeq} curves={curves} />}
          <Section title={`Clip · ${name}`} note={c.sample !== undefined ? `Plays ${c.sample} on ${f.track.name}.` : `Plays ${typeof c.playlist === "string" ? c.playlist : "an embedded playlist"} on ${f.track.name}; it resolves once when the playhead enters.`}>
            {c.sample !== undefined && props.onOpenSamples && <button type="button" class="pl-link" style={{ margin: "0 8px" }} onClick={() => props.onOpenSamples!(c.sample!)}>Edit its loops and markers in Samples ›</button>}
            <FieldRow label="Gain" unit="dB"><NumberBox label="Clip gain" value={c.gain} min={-96} max={24} step={0.5} digits={1} disabled={!writable} onValue={(v) => set("Clip gain", { gain: v })} /></FieldRow>
            <FieldRow label="Pitch" unit="st"><NumberBox label="Clip pitch" value={c.pitch} min={-48} max={48} step={1} digits={2} disabled={!writable} onValue={(v) => set("Clip pitch", { pitch: v })} /></FieldRow>
            <FieldRow label="Pan" unit="%"><NumberBox label="Clip pan" value={Math.round(c.pan * 100)} min={-100} max={100} step={1} digits={0} disabled={!writable} onValue={(v) => set("Clip pan", { pan: v / 100 })} /></FieldRow>
            <FieldRow label="Start" unit="s"><NumberBox label="Clip start" value={c.at} min={0} step={0.01} digits={3} disabled={!writable} onValue={(v) => set("Clip start", { at: v })} /></FieldRow>
            <FieldRow label="Length" unit="s" title="0: to the end of its source">
              <NumberBox label="Clip length" value={c.length} min={0} step={0.01} digits={3} disabled={!writable} onValue={(v) => set("Clip length", { length: v })} />
              {c.length === 0 && <span class="pl-faint">to the end ({len.toFixed(2)} s)</span>}
            </FieldRow>
            <FieldRow label="Offset" unit="s" title="Where in the source it starts"><NumberBox label="Clip offset" value={c.offset} min={0} step={0.01} digits={3} disabled={!writable} onValue={(v) => set("Clip offset", { offset: v })} /></FieldRow>
            <FieldRow label="Reverse"><input type="checkbox" aria-label="Reverse" checked={c.reverse} disabled={!writable} onChange={() => set(c.reverse ? "Forward clip" : "Reverse clip", { reverse: !c.reverse })} /></FieldRow>
            <div class="pl-kv">
              <span class="pl-field-label">Timing</span>
              <SegmentedControl<"sync" | "async"> size="small" label="Clip timing" value={c.sync ? "sync" : "async"}
                options={[{ value: "sync", label: "Sync", title: "Locked to the sequence playhead: its loops move the playhead and it leaves at the next Exit marker" }, { value: "async", label: "Async", title: "Its own voice clock: not cut when the playhead leaves; keeps looping while its loop is active" }]}
                onChange={(v) => writable && set(v === "sync" ? "Clip sync" : "Clip async", { sync: v === "sync" })} />
            </div>
            {follows && (
              <p class="pl-lint" style={{ margin: "2px 8px" }}>
                ⚠ Overlaps a sync clip on a higher track, which drives the playhead; this clip's loop is ignored.{" "}
                <button type="button" class="pl-small" disabled={!writable} onClick={() => runSeq("Clip async", (q) => makeAsync(q, c.id))}>Make Async</button>
              </p>
            )}
            <FieldRow label="Enabled"><input type="checkbox" aria-label="Clip enabled" checked={c.enabled} disabled={!writable} onChange={() => set(c.enabled ? "Disable clip" : "Enable clip", { enabled: !c.enabled })} /></FieldRow>
          </Section>
          {c.sample !== undefined && (
            <Section title="Loops" note={loops.length ? "The sample's loops. Changing one here overrides it in this clip only." : "The sample has no loops (add them in Samples)."}>
              {loops.map((l) => (
                <div key={l.id} class="sq-loop-card">
                  <div class="sq-loop-card-head">
                    <span>{l.start === l.end ? `Hold at ${l.start.toFixed(3)} s` : `Loop ${l.start.toFixed(3)}–${l.end.toFixed(3)} s`}</span>
                    <span class={`sq-badge${l.overridden ? " override" : ""}`}>{l.overridden ? "Override" : "Inherited"}</span>
                    {l.overridden && <button type="button" class="pl-link" disabled={!writable} onClick={() => runSeq("Use sample loop settings", (q) => clearLoopOverride(q, c.id, l.id))}>Use sample loop settings</button>}
                  </div>
                  {behaviourFields(l, (label, patch) => runSeq(label, (q) => setLoopOverride(q, c.id, l.id, patch)))}
                </div>
              ))}
            </Section>
          )}
          {c.sample !== undefined && (src?.markers.length ?? 0) > 0 && (
            <Section title="Sample markers" note="Ignore a marker in this clip only (an ignored Exit marker isn't a way out here).">
              {src!.markers.map((m) => (
                <FieldRow key={m.id} label={m.name} title={`${m.type} at ${m.at.toFixed(3)} s`}>
                  <input type="checkbox" aria-label={`Use ${m.name} in this clip`} checked={!c.hiddenMarkers.includes(m.id)} disabled={!writable}
                    onChange={(e) => {
                      const use = (e.currentTarget as HTMLInputElement).checked;
                      runSeq(use ? "Use marker in clip" : "Ignore marker in clip", (q) => setMarkerHidden(q, c.id, m.id, !use));
                    }} />
                  <span class="pl-faint">{m.type}</span>
                </FieldRow>
              ))}
            </Section>
          )}
          <Section title="Clip effects">
            <EffectChain effects={c.effects} level="voice" readOnly={!writable} note="Run on this clip's voice, once per playing clip."
              onEdit={(r, label) => run(label, (q) => ("refused" in r ? r : setClipEffects(q, c.id, r.next)), (x) => x)}
              onAutomate={(fxId) => curves({ clip: c.id }, len, name, `fx:${fxId}:on`)} />
          </Section>
          {automationList({ clip: c.id }, c.automation, c.effects, len, name, c.id)}
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
      return (
        <div class="sq-inspector">
          <Section title={`Track · ${t.name}`} note={t.kind === "audio" ? "An audio track: its clips play samples." : "A playlist track: its clips play playlists."}>
            <FieldRow label="Name"><input class="pl-text" aria-label="Track name" value={t.name} disabled={!writable} onChange={(e) => set("Rename track", { name: (e.currentTarget as HTMLInputElement).value })} /></FieldRow>
            <FieldRow label="Colour">
              <SelectBox label="Track colour" value={String(typeof t.color === "number" ? t.color : 1)} disabled={!writable} options={[1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: String(n), label: `Series ${n}` }))} onValue={(v) => set("Track colour", { color: Number(v) })} />
            </FieldRow>
            <FieldRow label="Volume" unit="dB"><NumberBox label="Track volume" value={t.volume} min={-96} max={24} step={0.5} digits={1} disabled={!writable} onValue={(v) => set("Track volume", { volume: v })} /></FieldRow>
            <FieldRow label="Pan" unit="%"><NumberBox label="Track pan" value={Math.round(t.pan * 100)} min={-100} max={100} step={1} digits={0} disabled={!writable} onValue={(v) => set("Track pan", { pan: v / 100 })} /></FieldRow>
            <FieldRow label="Output">
              <SelectBox label="Track output" value={t.output ?? ""} disabled={!writable} options={[{ value: "", label: "The sequence's output" }, ...props.buses.map((b) => ({ value: b, label: b }))]} onValue={(v) => set("Track output", { output: v || null })} />
            </FieldRow>
            <FieldRow label="Mute"><input type="checkbox" aria-label="Track mute" checked={t.mute} disabled={!writable} onChange={() => set(t.mute ? "Unmute" : "Mute", { mute: !t.mute })} /></FieldRow>
            <FieldRow label="Solo"><input type="checkbox" aria-label="Track solo" checked={t.solo} disabled={!writable} onChange={() => set(t.solo ? "Unsolo" : "Solo", { solo: !t.solo })} /></FieldRow>
            <FieldRow label="Enabled" title="A disabled track disables all its clips"><input type="checkbox" aria-label="Track enabled" checked={t.enabled} disabled={!writable} onChange={() => set(t.enabled ? "Disable track" : "Enable track", { enabled: !t.enabled })} /></FieldRow>
          </Section>
          <Section title="Track effects">
            <EffectChain effects={t.effects} level="instance" readOnly={!writable} note="Run once on the track's mix, one instance per playing sequence."
              onEdit={(r, label) => run(label, (q) => ("refused" in r ? r : setTrackEffects(q, t.id, r.next)), (x) => x)}
              onAutomate={(fxId) => curves({ track: t.id }, length, t.name, `fx:${fxId}:on`)} />
          </Section>
          {automationList({ track: t.id }, t.automation, t.effects, length, t.name)}
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
          <Section title={hold ? "Hold point" : "Loop"} note={hold ? "The playhead parks here while it is active." : "The playhead wraps from its end to its start while it is active."}>
            <FieldRow label={hold ? "At" : "Start"} unit="s"><NumberBox label="Loop start" value={l.start} min={0} step={0.01} digits={3} disabled={!writable} onValue={(v) => runSeq("Loop start", (q) => (hold ? moveLoop(q, l.id, v - l.start) : setLoopEdge(q, l.id, "start", v)))} /></FieldRow>
            {!hold && <FieldRow label="End" unit="s"><NumberBox label="Loop end" value={l.end} min={0} step={0.01} digits={3} disabled={!writable} onValue={(v) => runSeq("Loop end", (q) => setLoopEdge(q, l.id, "end", v))} /></FieldRow>}
            {behaviourFields(l, (label, patch) => runSeq(label, (q) => setLoopBehaviour(q, l.id, patch)))}
            {!hold && <button type="button" class="pl-small" disabled={!writable} onClick={() => runSeq("Make hold point", (q) => makeHoldPoint(q, l.id))}>Make hold point</button>}
            <button type="button" class="pl-small pl-danger" disabled={!writable} onClick={() => runSeq("Delete loop", (q) => deleteLoops(q, [l.id]))}>Delete</button>
          </Section>
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
          <Section title={`Marker · ${m.name}`} note="Exit markers are where Switch rules timed to Exit and sync clips may leave; Cue markers are reported to the game.">
            <FieldRow label="Name"><input class="pl-text" aria-label="Marker name" value={m.name} disabled={!writable} onChange={(e) => runSeq("Rename marker", (q) => renameMarker(q, m.id, (e.currentTarget as HTMLInputElement).value))} /></FieldRow>
            <FieldRow label="At" unit="s"><NumberBox label="Marker time" value={m.at} min={0} step={0.01} digits={3} disabled={!writable} onValue={(v) => runSeq("Move marker", (q) => moveMarker(q, m.id, v))} /></FieldRow>
            <div class="pl-kv">
              <span class="pl-field-label">Type</span>
              <SegmentedControl<"note" | "cue" | "exit"> size="small" label="Marker type" value={m.type ?? "note"} onChange={(v) => writable && runSeq("Marker type", (q) => setMarkerType(q, m.id, v))}
                options={[{ value: "note", label: "Note" }, { value: "cue", label: "Cue", title: "Reported to the game when the playhead passes it" }, { value: "exit", label: "Exit", title: "Music may leave here" }]} />
            </div>
            <button type="button" class="pl-small pl-danger" disabled={!writable} onClick={() => runSeq("Delete marker", (q) => deleteMarkers(q, [m.id]))}>Delete</button>
          </Section>
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
  return (
    <div class="sq-inspector">
      <Section title="Sequence" note="A timeline of audio and playlist tracks. Select a clip, track, loop or marker to edit it.">
        <FieldRow label="Length" unit="s" title="0: to the end of the longest clip">
          <NumberBox label="Sequence length" value={s.length} min={0} step={0.1} digits={3} disabled={!writable} onValue={(v) => runSeq("Sequence length", (q) => setSequenceLength(q, v))} />
          {s.length === 0 && <span class="pl-faint">to the end ({length.toFixed(2)} s)</span>}
        </FieldRow>
        <FieldRow label="Tempo" unit="BPM" title="The grid, the bars display and the musical clock (Switch rules timed to beats and bars)">
          <input type="checkbox" aria-label="Has a tempo" checked={!!s.tempo} disabled={!writable} onChange={(e) => runSeq((e.currentTarget as HTMLInputElement).checked ? "Tempo" : "No tempo", (q) => setTempo(q, (e.currentTarget as HTMLInputElement).checked ? 120 : null))} />
          {s.tempo ? <NumberBox label="Tempo" value={s.tempo.bpm} min={20} max={400} step={1} digits={2} disabled={!writable} onValue={(v) => runSeq("Tempo", (q) => setTempo(q, v))} /> : <span class="pl-faint">No tempo (a beat is 0.5 s on the grid)</span>}
        </FieldRow>
        {s.tempo && (
          <FieldRow label="Meter">
            <SelectBox label="Meter" value={s.tempo.meter} disabled={!writable} options={[...new Set([...METERS, s.tempo.meter])].map((m) => ({ value: m, label: m }))} onValue={(v) => runSeq("Meter", (q) => setMeter(q, v))} />
          </FieldRow>
        )}
        <FieldRow label="Contents"><span class="pl-faint">{s.tracks.length} tracks · {s.tracks.reduce((n, t) => n + t.clips.length, 0)} clips · {s.loops.length} loops · {s.markers.length} markers</span></FieldRow>
      </Section>
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
    <Section title={`${keys.length === 1 ? "Point" : `${keys.length} points`} · ${spec?.name ?? lane.target}`} note={`On ${name}. Drag points on the timeline; double-click deletes one.`}>
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
      <button type="button" class="pl-small" onClick={() => props.curves(owner, length, name, lane.target)}>Open in curve editor…</button>
      <button type="button" class="pl-small pl-danger" disabled={!props.writable} onClick={() => props.runSeq(keys.length > 1 ? "Delete automation points" : "Delete automation point", (q) => deletePointsOf(q, owner, lane.id, keys))}>Delete</button>
    </Section>
  );
}
