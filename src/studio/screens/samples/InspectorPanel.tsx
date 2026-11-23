// The Inspector on the Samples screen (spec §4.1.9, the prototype's): a title bar (colour square, kind badge, name, icon
// actions) over what is selected. Markers: Type, Name, At or Range (one row of timecode fields), Colour (the shared
// colour picker: presets, saved colours, Custom colour…), Note, and the Source block (file vs project per field, revert
// each, Detach). Loops: Range, Repeats, Active, Binding, Exit and its fade, Re-entry, Direction (icon segments named in
// tooltips), Crossfade. Pickup, Link, Tail and Trim: their range. A snippet: its bar of actions. The sample: Kind, then
// Sample (Tempo, Root note, Loudness, Normalize, Lip-sync, Lineage with its forks, a baked sample's generator), Music
// (the Stinger tag and the Exit, Hit point and Cue lists, when it has a tempo), the whole sample's Source block, its
// Encoding per platform (ADR 0351 §6) and Used by. Explanations live in tooltips (§1.3).
import type { ComponentChildren } from "preact";
import { useRef, useState } from "preact/hooks";
import type { DerivedSampleAsset, SampleEdits, SampleLoop, SampleMarker, SampleKind, ReservedRange } from "../../../engine/audio/sample/types";
import { parentChangedSincePin, sampleEditsHash, sampleEditsFromSidecar } from "../../../engine/audio/sample/format";
import { readAsset } from "../../../editor/assetDocuments";
import { Chip } from "../../../editor/ui/Chip";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { ColourPicker } from "../../components/ColourPicker";
import { NumberField } from "../../components/NumberField";
import { SampleEncoding } from "./SampleEncoding";
import { SampleProvenance } from "../playlists/generator/GeneratedProvenance";
import { sidecarPath, type ImportSettings } from "../../../engine/scene/importSettings";
import { formatTime, parseTime, type TimeContext } from "../../components/timeRulerModel";
import { openRoute, toasts } from "../../shell/studioServices";
import { LipsyncField } from "./LipsyncField";
import * as act from "./sampleActions";
import {
  convertMarker, deleteMarker, hasFixedName, isHold, loopName, MARKER_TYPE_NAMES, MARKER_TYPE_ORDER, moveLoop, moveMarker, removeLoop, resetTrim, setStinger, setTrim, snippets,
  tapeSnippet, toggleSnippet, updateLoop, updateMarker, viewTime, type SampleEdit,
  setRangeLook,
} from "./sampleEditing";
import { changedCount, detachAll, detachMarker, fileOrigin, loopDiff, markerDiff, revertLoop, revertMarker, type DiffRow } from "./sampleFile";
import { SampleIcon, type SampleIconName } from "./sampleIcons";
import { nameOf, usesOf } from "./sampleLibrary";
import { DERIVED_KIND, lengthOf, loudnessOf, SIDECAR_KIND, wavMetadataOf, type SampleSession } from "./sampleSession";
import { trimOf } from "./sampleTime";
import { colourCss, colourValue, liveSelection, loopRegions, MARKER_PRESETS, markerColour, RANGE_PRESETS, rangeLook, trimHoldingMarkers } from "./sampleView";
import { markColourOf } from "../../../engine/audio/markColour";
import { dialog, openSample, openSession, savedColours, select, selection, timeFormat } from "./samplesState";

const PRESETS = MARKER_PRESETS.map((p) => ({ name: p.name, color: colourCss(p.series) }));

const TYPE_TIPS: Record<SampleMarker["type"], string> = {
  note: "Note: an annotation only; can be a range",
  exit: "Exit: music may leave here for a transition; the audio after it rings out as the tail",
  entry: "Entry: music enters here; a Switch change at a beat or bar starts the sample early so this point lands on it",
  hit: "Hit point: a stinger's beat lands on the change",
  cue: "Cue: sends this cue name to the game when playback passes it",
};

function TimeField(props: { label: string; value: number; ctx: TimeContext; disabled?: boolean; onCommit(t: number): void }) {
  const fmt = timeFormat.value;
  const shown = formatTime(props.value, fmt, props.ctx);
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      class="smp-tcin"
      aria-label={props.label}
      title="Type a time"
      value={text ?? shown}
      disabled={props.disabled}
      onFocus={() => setText(shown)}
      onInput={(e) => setText((e.currentTarget as HTMLInputElement).value)}
      onBlur={() => setText(null)}
      onKeyDown={(e) => {
        if (e.key === "Enter") (e.currentTarget as HTMLInputElement).blur();
        if (e.key === "Escape") {
          setText(null);
          (e.currentTarget as HTMLInputElement).blur();
        }
      }}
      onChange={(e) => {
        const t = parseTime((e.currentTarget as HTMLInputElement).value, fmt, props.ctx);
        if (t !== null) props.onCommit(t);
        setText(null); // invalid input reverts
      }}
    />
  );
}

/** A text field that commits on change (Enter or leaving it); a textarea keeps Enter for a new line, Ctrl+Enter keeps. */
function TextField(props: { label: string; value: string; multiline?: boolean; disabled?: boolean; placeholder?: string; title?: string; onCommit(v: string): void }) {
  const common = {
    value: props.value,
    disabled: props.disabled,
    "aria-label": props.label,
    placeholder: props.placeholder,
    title: props.title,
    onChange: (e: Event) => props.onCommit((e.currentTarget as HTMLInputElement).value),
  };
  return props.multiline ? (
    <textarea rows={3} {...common} onKeyDown={(e) => e.key === "Enter" && (e.ctrlKey || e.metaKey) && (e.currentTarget as HTMLTextAreaElement).blur()} />
  ) : (
    <input {...common} onKeyDown={(e) => e.key === "Enter" && (e.currentTarget as HTMLInputElement).blur()} />
  );
}

/** A radio group of icon segments (the prototype's loop options), each named in its tooltip and for assistive tech. */
function IconSegments<T extends string>(props: { label: string; value: T; options: readonly { value: T; icon: SampleIconName; name: string; tip: string }[]; disabled?: boolean; onChange(v: T): void }) {
  const ref = useRef<HTMLDivElement>(null);
  return (
    <div ref={ref} class="kit-segmented small smp-iconseg" role="radiogroup" aria-label={props.label}
      onKeyDown={(e) => {
        const i = props.options.findIndex((o) => o.value === props.value);
        const d = e.key === "ArrowRight" || e.key === "ArrowDown" ? 1 : e.key === "ArrowLeft" || e.key === "ArrowUp" ? -1 : 0;
        if (!d || props.disabled) return;
        e.preventDefault();
        const next = props.options[(i + d + props.options.length) % props.options.length];
        props.onChange(next.value);
        queueMicrotask(() => ref.current?.querySelector<HTMLButtonElement>(`[data-value="${next.value}"]`)?.focus());
      }}>
      {props.options.map((o) => {
        const on = o.value === props.value;
        return (
          <button key={o.value} type="button" role="radio" aria-checked={on} aria-label={o.name} data-value={o.value} class={on ? "on" : undefined} tabIndex={on ? 0 : -1} disabled={props.disabled} title={`${o.name}: ${o.tip}`} onClick={() => !on && props.onChange(o.value)}>
            <SampleIcon name={o.icon} size={12} />
          </button>
        );
      })}
    </div>
  );
}

const fmtDiff = (v: string | number | null, ctx: TimeContext): string => (typeof v === "number" ? formatTime(v, timeFormat.value, ctx) : v === null ? "none" : String(v));

function SourceBlock<F extends string>(props: { origin: string | null; rows: DiffRow<F>[]; names: Record<F, string>; ctx: TimeContext; numeric?: readonly F[]; ro: boolean; onRevert(f: F): void; onDetach?(): void }) {
  if (!props.origin) return null;
  const show = (f: F, v: string | number | null) => (props.numeric && !props.numeric.includes(f) ? String(v) : fmtDiff(v, props.ctx));
  return (
    <div class="smp-source">
      <div class="smp-source-head">
        <span>Source</span>
        <Chip tone={props.rows.length ? "warning" : "success"} title="The file isn't changed unless you use Write to file">
          From file · {props.origin}
          {props.rows.length ? ` · ${props.rows.length} changed` : ""}
        </Chip>
        <span class="smp-flex" />
        {props.onDetach && (
          <button type="button" class="smp-ibtn smp-plain" aria-label="Detach from file" title="Detach from file: stop tracking the WAV for this item; it keeps its values as project-only ones" disabled={props.ro} onClick={props.onDetach}>
            <SampleIcon name="detach" size={14} />
          </button>
        )}
      </div>
      {props.rows.map((r) => (
        <div key={r.field} class="smp-diff">
          <span class="smp-muted">{props.names[r.field]}</span>
          <span>
            <span class="smp-muted">{show(r.field, r.file)}</span> <span class="smp-faint">→</span> <span class="smp-warning">{show(r.field, r.project)}</span>
          </span>
          <button type="button" class="smp-ibtn smp-plain" aria-label={`Revert ${props.names[r.field]} to ${show(r.field, r.file)}`} title={`Revert ${props.names[r.field]} to the file's value (${show(r.field, r.file)})`} disabled={props.ro} onClick={() => props.onRevert(r.field)}>
            <SampleIcon name="revert" size={13} />
          </button>
        </div>
      ))}
    </div>
  );
}

/** The title bar: a colour square, the kind badge, the name, and icon actions at the right. */
function TitleBar(props: { color?: string; kind: string; name: string; children?: ComponentChildren }) {
  return (
    <div class="smp-insp-tb">
      {props.color && <span class="smp-insp-sq" style={{ background: props.color }} aria-hidden="true" />}
      <span class="smp-badge">{props.kind}</span>
      <h3 class="smp-insp-title">{props.name}</h3>
      {props.children}
    </div>
  );
}

const Row = (props: { label: string; title?: string; children: ComponentChildren }) => (
  <div class="fld">
    <span title={props.title}>{props.label}</span>
    <div class="smp-fld-v">{props.children}</div>
  </div>
);

export function InspectorPanel() {
  const session = openSession.value;
  if (!session) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="Nothing selected" body="Pick a sample to see its settings." />
      </Panel>
    );
  }
  const length = lengthOf(session.project, session.source.value);
  if (length === null) return <Panel bodyClass="studio-panel-body"><p class="smp-muted smp-pad">Reading the audio…</p></Panel>;
  const e = session.edits.value;
  const sel = liveSelection(selection.value, e, length);
  const ctx: TimeContext = { rate: 48000, bpm: e.tempo?.bpm, meter: e.tempo?.meter };
  const commit = (r: SampleEdit) => session.commit(r);
  const ro = session.readOnly;
  const t = (s: number) => formatTime(viewTime(e, s), timeFormat.value, ctx);
  let body;
  if (sel.kind === "marker") body = <MarkerInspector e={e} m={e.markers.find((m) => m.id === sel.id)!} length={length} ctx={ctx} commit={commit} ro={ro} />;
  else if (sel.kind === "loop") body = <LoopInspector e={e} l={e.loops.find((l) => l.id === sel.id)!} length={length} ctx={ctx} commit={commit} ro={ro} />;
  else if (sel.kind === "trim") {
    const [a, b] = trimOf(e, length);
    body = (
      <>
        <TitleBar color={rangeLook(e, "trim").css} kind="Reserved range" name="Trim" />
        <div class="smp-insp-body">
          <Row label="Range" title="Non-destructive: audio outside never plays">
            <span class="smp-range-fields">
              <TimeField label="Trim start" value={viewTime(e, a)} ctx={ctx} disabled={ro} onCommit={(v) => commit(setTrim(e, v, b, length))} />
              <span class="smp-faint">–</span>
              <TimeField label="Trim end" value={viewTime(e, b)} ctx={ctx} disabled={ro} onCommit={(v) => commit(setTrim(e, a, v, length))} />
              <button type="button" class="smp-ibtn smp-plain" aria-label="Reset to full length" title="Reset to full length" disabled={ro || !e.trim} onClick={() => commit(resetTrim(e))}>
                <SampleIcon name="reset" size={12} />
              </button>
            </span>
          </Row>
          <RangeLookRows e={e} range="trim" commit={commit} ro={ro} />
        </div>
      </>
    );
  } else if (sel.kind === "snippet") {
    const all = snippets(e, length);
    const s = all.find((x) => x.index === sel.index)!;
    const ms = Math.round((s.end - s.start) * 1000);
    body = (
      <>
        <TitleBar color="var(--text-strong)" kind="Snippet" name={s.name} />
        <div class="smp-snipbar">
          <span class={s.deleted ? "smp-muted" : undefined}>{s.deleted ? "Deleted · plays as silence" : `${ms >= 1000 ? `${(ms / 1000).toFixed(2)} s` : `${ms} ms`} long`}</span>
          <span class="smp-flex" />
          <button type="button" class="smp-sm2" disabled={ro} title="Save this snippet as a new sample (it references the source; no audio is copied)" onClick={() => (dialog.value = { kind: "snippet", index: s.index })}>Save as…</button>
          <button type="button" class="smp-sm2" disabled={ro} title={s.deleted ? "Restore the snippet's audio" : "Delete: leaves silence in its place (Del)"} onClick={() => commit(toggleSnippet(e, s.index, length))}>{s.deleted ? "Restore" : "Delete"}</button>
          <button type="button" class="smp-sm2" disabled={ro} title="Remove it and slide what follows up" onClick={() => act.closeSnippetGap(s.index)}>{s.deleted ? "Close gap" : "Delete + close gap"}</button>
          <button type="button" class="smp-ibtn" aria-label="Tape to left" title="Tape to left: join it to the snippet before" disabled={ro || s.index === 1} onClick={() => commit(tapeSnippet(e, s.index, "left", length))}>←</button>
          <button type="button" class="smp-ibtn" aria-label="Tape to right" title="Tape to right: join it to the snippet after" disabled={ro || s.index === all.length} onClick={() => commit(tapeSnippet(e, s.index, "right", length))}>→</button>
        </div>
        <div class="smp-insp-body">
          <Row label="Range"><span class="smp-tabular">{t(s.start)} – {t(s.end)}</span></Row>
        </div>
      </>
    );
  } else if (sel.kind === "pickup" || sel.kind === "tail" || sel.kind === "link") {
    const r = loopRegions(e, length).find((x) => x.kind === sel.kind && (sel.kind !== "link" || (x.selection.kind === "link" && x.selection.after === sel.after)));
    const name = { pickup: "Pickup", tail: "Tail", link: "Link" }[sel.kind];
    const tip = { pickup: "Plays once, from the trim start to the first loop; it follows the trim and the loops", tail: "Plays once after the last loop, to the trim end", link: "Plays once between two loops" }[sel.kind];
    body = (
      <>
        <TitleBar color={sel.kind === "link" ? "var(--range-pickup)" : rangeLook(e, sel.kind).css} kind="Reserved range" name={name}>
          <button type="button" class="smp-ibtn smp-plain" aria-label={`Play ${name.toLowerCase()}`} title={`Play the ${name.toLowerCase()}`} onClick={() => act.togglePlay()}>
            <SampleIcon name="play" size={14} />
          </button>
        </TitleBar>
        <div class="smp-insp-body">
          {r && (
            <Row label="Range" title={tip}>
              <span class="smp-range-fields smp-tabular">
                <span class="smp-tcin ro">{t(r.start)}</span>
                <span class="smp-faint">–</span>
                <span class="smp-tcin ro">{t(r.end)}</span>
              </span>
            </Row>
          )}
          <Row label="" title="Double-click it on the loop row to add a loop there">
            <button type="button" class="smp-sm2" disabled={ro || !r} onClick={() => r && act.addLoopHere((r.start + r.end) / 2)}>Add a loop here</button>
          </Row>
          {sel.kind !== "link" && <RangeLookRows e={e} range={sel.kind} commit={commit} ro={ro} />}
        </div>
      </>
    );
  } else body = <SampleInspector session={session} e={e} length={length} ctx={ctx} commit={commit} ro={ro} />;
  return (
    <Panel class="smp-inspector" bodyClass="smp-insp">
      {body}
    </Panel>
  );
}

interface Part {
  readonly e: SampleEdits;
  readonly length: number;
  readonly ctx: TimeContext;
  readonly ro: boolean;
  commit(r: SampleEdit): void;
}

function MarkerInspector(props: Part & { m: SampleMarker }) {
  const { e, m, length, ctx, commit, ro } = props;
  const [ta, tb] = trimOf(e, length);
  const outside = m.at < ta || m.at > tb;
  const fixed = hasFixedName(m.type);
  return (
    <>
      <TitleBar color={markerColour(m)} kind={`${MARKER_TYPE_NAMES[m.type]} marker`} name={fixed ? MARKER_TYPE_NAMES[m.type] : m.name}>
        {m.type === "note" && (
          <button type="button" class="smp-ibtn smp-plain" aria-label={m.end !== undefined ? "Convert to point" : "Convert to range"} title={m.end !== undefined ? "Convert to a point" : "Convert to a range"} disabled={ro} onClick={() => commit(convertMarker(e, m.id, length))}>
            <SampleIcon name={m.end !== undefined ? "convertPoint" : "convertRange"} size={13} />
          </button>
        )}
        <button type="button" class="smp-ibtn smp-plain danger" aria-label="Delete marker" title="Delete this marker (Del)" disabled={ro} onClick={() => (commit(deleteMarker(e, m.id)), select({ kind: "sample" }))}>
          <SampleIcon name="trash" size={13} />
        </button>
      </TitleBar>
      {outside && (
        <div class="smp-insp-warn">
          <span class="smp-warning">⚠ Outside the trim · won't play</span>
          <button type="button" class="smp-sm2" disabled={ro} onClick={() => commit({ next: { ...e, trim: trimHoldingMarkers(e, length) }, label: "Trim" })}>Extend trim</button>
        </div>
      )}
      <SourceBlock origin={fileOrigin(m)} rows={markerDiff(m)} names={{ type: "Type", name: "Name", at: m.end !== undefined ? "Start" : "Position", end: "End" }} ctx={ctx} numeric={["at", "end"]} ro={ro}
        onRevert={(f) => commit(revertMarker(e, m.id, f))} onDetach={() => commit(detachMarker(e, m.id))} />
      <div class="smp-insp-body">
        <Row label="Type" title={TYPE_TIPS[m.type]}>
          <SegmentedControl size="small" fit="menu" label="Marker type" value={m.type} options={MARKER_TYPE_ORDER.map((tp) => ({ value: tp, label: MARKER_TYPE_NAMES[tp], title: TYPE_TIPS[tp] }))} onChange={(tp) => !ro && commit(updateMarker(e, m.id, { type: tp }))} />
        </Row>
        {!fixed && (
          <Row label={m.type === "cue" ? "Cue name" : "Name"}>
            <TextField label={m.type === "cue" ? "Cue name" : "Name"} value={m.name} disabled={ro} onCommit={(v) => v.trim() && commit(updateMarker(e, m.id, { name: v.trim() }))} />
          </Row>
        )}
        <Row label={m.end !== undefined ? "Range" : "At"}>
          <span class="smp-range-fields">
            <TimeField label={m.end !== undefined ? "Range start" : "At"} value={viewTime(e, m.at)} ctx={ctx} disabled={ro} onCommit={(v) => commit(moveMarker(e, m.id, v, length, m.end))} />
            {m.end !== undefined && (
              <>
                <span class="smp-faint">–</span>
                <TimeField label="Range end" value={viewTime(e, m.end)} ctx={ctx} disabled={ro} onCommit={(v) => commit(moveMarker(e, m.id, m.at, length, v))} />
              </>
            )}
          </span>
        </Row>
        {m.type === "note" && (
          <Row label="Colour">
            <ColourPicker
              label="Marker colour"
              value={m.color !== undefined ? colourCss(m.color) : null}
              presets={PRESETS}
              saved={savedColours.value}
              disabled={ro}
              onChange={(c) => {
                const v = colourValue(c);
                if (v !== null) commit(updateMarker(e, m.id, { color: v }));
              }}
              onSavedChange={(s) => (savedColours.value = s)}
            />
          </Row>
        )}
        <Row label="Note">
          <TextField label="Note" multiline value={m.note ?? ""} placeholder="Shown on hover" title="Enter for a new line; Ctrl+Enter keeps it" disabled={ro} onCommit={(v) => commit(updateMarker(e, m.id, { note: v }))} />
        </Row>
      </div>
    </>
  );
}

/** ADR 0362 item 4: a reserved range's Colour (its default first) and Note, kept in the sidecar's `ranges`. */
function RangeLookRows(props: { e: SampleEdits; range: ReservedRange; commit: (r: SampleEdit) => void; ro: boolean }) {
  const { e, range, commit, ro } = props;
  const look = rangeLook(e, range);
  const name = { trim: "Trim", pickup: "Pickup", tail: "Tail" }[range];
  const defaultCss = rangeLook({}, range).css;
  return (
    <>
      <Row label="Colour" title={`How the ${name.toLowerCase()} is drawn on the loop row (the first swatch: the default)`}>
        <ColourPicker
          label={`${name} colour`}
          value={look.css}
          presets={[{ name: "Default", color: defaultCss }, ...RANGE_PRESETS]}
          saved={savedColours.value}
          disabled={ro}
          onChange={(c) => commit(setRangeLook(e, range, { colour: c === defaultCss ? null : markColourOf(c) }))}
          onSavedChange={(s) => (savedColours.value = s)}
        />
      </Row>
      <Row label="Note">
        <TextField label={`${name} note`} multiline value={look.note ?? ""} placeholder="Shown on hover" title="Enter for a new line; Ctrl+Enter keeps it" disabled={ro} onCommit={(v) => commit(setRangeLook(e, range, { note: v }))} />
      </Row>
    </>
  );
}

function LoopInspector(props: Part & { l: SampleLoop }) {
  const { e, l, length, ctx, commit, ro } = props;
  const set = (patch: Parameters<typeof updateLoop>[2]) => commit(updateLoop(e, l.id, patch));
  const hold = isHold(l);
  return (
    <>
      <TitleBar color="var(--range-loop)" kind={hold ? "Hold point" : l.count === 0 ? (l.active === "held" ? "Loop · holds" : "Loop · repeats") : `Loop · plays ${l.count}×`} name={loopName(e, l.id)}>
        <button type="button" class="smp-ibtn smp-plain" aria-label={`Play ${loopName(e, l.id)}`} title="Play the loop" onClick={() => act.togglePlay({ kind: "loop", id: l.id })}>
          <SampleIcon name="play" size={14} />
        </button>
        <button type="button" class="smp-ibtn smp-plain danger" aria-label={`Remove ${loopName(e, l.id)}`} title={`Remove ${loopName(e, l.id)}: with no loops the file plays once from trim start to trim end`} disabled={ro} onClick={() => (commit(removeLoop(e, l.id)), select({ kind: "sample" }))}>
          <SampleIcon name="trash" size={13} />
        </button>
      </TitleBar>
      <SourceBlock origin={fileOrigin(l)} rows={loopDiff(l)} names={{ start: "Start", end: "End", direction: "Direction", count: "Repeats" }} ctx={ctx} numeric={["start", "end"]} ro={ro} onRevert={(f) => commit(revertLoop(e, l.id, f))} />
      <div class="smp-insp-body">
        <Row label="Range" title={hold ? "A hold point: the playhead parks here while the loop is active" : undefined}>
          <span class="smp-range-fields">
            <TimeField label="Loop start" value={viewTime(e, l.start)} ctx={ctx} disabled={ro} onCommit={(v) => commit(moveLoop(e, l.id, v, l.end, length))} />
            <span class="smp-faint">–</span>
            <TimeField label="Loop end" value={viewTime(e, l.end)} ctx={ctx} disabled={ro} onCommit={(v) => commit(moveLoop(e, l.id, l.start, v, length))} />
          </span>
        </Row>
        <Row label="Repeats">
          <span class="smp-range-fields">
            <IconSegments label="Repeats" value={l.count === 0 ? "endless" : "count"} disabled={ro}
              options={[{ value: "endless", icon: "endless", name: "Endless", tip: "Repeats for as long as the loop is active (smpl play count 0)" }, { value: "count", icon: "count", name: "Set count", tip: "Plays a set number of times, then moves on to the next link, loop or the tail" }]}
              onChange={(v) => set({ count: v === "endless" ? 0 : Math.max(1, l.count || 2), active: v === "endless" ? l.active : l.active === "held" ? "always" : l.active })} />
            {l.count > 0 && <NumberField label="Times" hideLabel ariaLabel="Repeat count" value={l.count} min={1} max={999} step={1} unit="×" size="narrow" disabled={ro} onValue={(v) => set({ count: Math.round(v) })} />}
          </span>
        </Row>
        <Row label="Active">
          <IconSegments label="Active" value={l.active} disabled={ro}
            options={[
              { value: "always", icon: "endless", name: "Always", tip: "Repeats until the voice is stopped" },
              { value: "held", icon: "held", name: "While held", tip: "Repeats while the voice is held (key or Play held); on release it leaves by its Exit setting" },
              { value: "parameter", icon: "parameter", name: "Parameter", tip: "Active while a parameter says so; the parameter is bound per clip in its sequence" },
            ]}
            onChange={(v) => set({ active: v })} />
        </Row>
        {l.active === "parameter" && (
          <Row label="Binding" title="Bound per clip in its sequence (Playlists)">
            <select disabled aria-label="Binding"><option>Per clip</option></select>
          </Row>
        )}
        {l.active !== "always" && (
          <>
            <Row label="Exit">
              <IconSegments label="Exit" value={l.exit} disabled={ro}
                options={[
                  { value: "jump", icon: "jump", name: "Jump now", tip: "Leave the loop at once, from wherever the playhead is" },
                  { value: "finish", icon: "finish", name: "Finish pass", tip: "Play on to the loop end, then carry on" },
                  { value: "crossfade", icon: "crossfade", name: "Crossfade", tip: "Crossfade out of the loop into what follows" },
                ]}
                onChange={(v) => set({ exit: v })} />
            </Row>
            {l.exit === "crossfade" && (
              <Row label="Exit fade">
                <NumberField label="Exit fade" hideLabel value={l.exitFadeMs} min={1} max={2000} step={1} unit="ms" size="narrow" disabled={ro} onValue={(v) => set({ exitFadeMs: Math.round(v) })} />
              </Row>
            )}
            <Row label="Re-entry">
              <IconSegments label="Re-entry" value={l.reentry} disabled={ro}
                options={[{ value: "ignore", icon: "ignore", name: "Ignore", tip: "Once it has left, it doesn't come back" }, { value: "reenter", icon: "reenter", name: "Re-enter", tip: "Comes back if it becomes active again" }]}
                onChange={(v) => set({ reentry: v })} />
            </Row>
          </>
        )}
        <Row label="Direction">
          <IconSegments label="Direction" value={l.direction} disabled={ro}
            options={[
              { value: "forward", icon: "forward", name: "Forward", tip: "Forward (smpl: forward)" },
              { value: "pingPong", icon: "pingPong", name: "Ping-pong", tip: "Back and forth (smpl: alternating)" },
              { value: "backward", icon: "backward", name: "Backward", tip: "Backward (smpl: backward)" },
            ]}
            onChange={(v) => set({ direction: v })} />
        </Row>
        <Row label="Crossfade" title="Smooths the seam where the loop's end meets its start (see Loop seam)">
          <NumberField label="Crossfade" hideLabel value={l.crossfadeMs} min={0} max={500} step={1} unit="ms" size="narrow" disabled={ro} onValue={(v) => set({ crossfadeMs: Math.round(v) })} />
        </Row>
        <Row label="Note">
          <TextField label="Loop note" multiline value={l.note ?? ""} placeholder="Shown on hover" disabled={ro} onCommit={(v) => set({ note: v })} />
        </Row>
      </div>
    </>
  );
}

const KIND_OPTIONS: { value: SampleKind; label: string }[] = [
  { value: "oneshot", label: "One-shot" },
  { value: "loop", label: "Loop" },
  { value: "sustain", label: "Sustain" },
  { value: "music", label: "Music" },
];

/** A used-by row's badge and friendly name: "Playlist" + "Vehicles › HoverBike › Brake". */
function useName(path: string): { badge: string; name: string } {
  const badge = path.endsWith(".playlist.json") ? "Playlist" : path.endsWith(".sample.json") ? "Sample" : "File";
  const stem = path.replace(/\.(playlist|sample)\.json$/i, "").replace(/\.[^./]+$/, "");
  return { badge, name: stem.split("/").join(" › ") };
}

function SampleInspector(props: Part & { session: SampleSession }) {
  const { session, e, ctx, commit, ro } = props;
  const project = session.project;
  const source = session.source.value;
  const derived = session.derived.value;
  const loud = loudnessOf(project, source);
  const wav = wavMetadataOf(project, source);
  const uses = usesOf(session.path, project.files, (p) => project.assets.get(p));
  const changed = changedCount(e);
  const linked = e.markers.some((m) => m.file) || e.loops.some((l) => l.file);
  const forks = project.files.filter((f) => f.toLowerCase().endsWith(".sample.json") && f !== session.path && (project.assets.get(f) as { lineage?: { parent?: string } } | undefined)?.lineage?.parent === session.path);
  let parentChanged = false;
  if (derived?.lineage.kind === "fork" && derived.lineage.mode === "pin") {
    const parentEdits = sampleEditsFromSidecar(readAsset<ImportSettings>(project, sidecarPath(derived.lineage.parent), SIDECAR_KIND).value);
    parentChanged = parentChangedSincePin(derived, parentEdits);
  }
  const db = (v: number) => (Number.isFinite(v) ? v.toFixed(1).replace("-", "−") : "−∞");
  const n = e.normalize;
  const list = (type: SampleMarker["type"]) => e.markers.filter((m) => m.type === type);
  return (
    <>
      <TitleBar kind="Sample" name={nameOf(session.path)} />
      <div class="smp-insp-body">
        <Row label="Kind">
          <SegmentedControl size="small" fit="menu" label="Kind" value={e.kind} options={KIND_OPTIONS} onChange={(k) => !ro && commit({ next: { ...e, kind: k }, label: `Make it ${KIND_OPTIONS.find((o) => o.value === k)!.label.toLowerCase()}` })} />
        </Row>
      </div>
      <h4 class="smp-ph">Sample</h4>
      <div class="smp-insp-body">
        <Row label="Tempo" title="Set it with the tempo button under the playhead readout">
          <span class="smp-tabular">{e.tempo ? `${e.tempo.bpm} BPM · ${e.tempo.meter}` : <span class="smp-muted">none</span>}</span>
          {e.tempo && <Chip tone={e.tempo.source === "file" ? "success" : e.tempo.source === "set" ? "warning" : "neutral"}>{{ file: "From file", detected: "Detected", set: "Set by you" }[e.tempo.source]}</Chip>}
        </Row>
        <Row label="Root note" title="Set it with the Root note button in the toolbar">
          <span class="smp-tabular">{e.root ? `${e.root.note}${e.root.cents ? ` ${e.root.cents > 0 ? "+" : ""}${e.root.cents} ct` : ""}` : <span class="smp-muted">none</span>}</span>
          {e.root && <Chip tone={e.root.source === "file" ? "success" : e.root.source === "set" ? "warning" : "neutral"}>{{ file: "From file", detected: "Detected", set: "Set by you" }[e.root.source]}</Chip>}
        </Row>
        <Row label="Loudness" title={wav?.bext?.loudnessValue != null ? `The file's bext says ${db(wav.bext.loudnessValue)} LUFS` : "Integrated loudness (BS.1770) and sample peak"}>
          <span class="smp-tabular">{loud ? `${db(loud.integrated)} LUFS · peak ${db(loud.peak)} dBFS` : "Measuring…"}</span>
          {loud && <Chip title="Measured from the audio">Measured</Chip>}
        </Row>
        <Row label="Normalize" title="Set it with the Normalize button in the toolbar">
          <span class="smp-tabular">{n.mode === "off" ? <span class="smp-muted">off</span> : `${n.target} ${n.mode === "loudness" ? "LUFS" : "dBFS"} → ${n.gainDb > 0 ? "+" : ""}${n.gainDb.toFixed(1)} dB`}</span>
        </Row>
        <LipsyncField e={e} ro={ro} commit={commit} onProblem={(text) => toasts.show({ text })} />
        {wav?.bext && (
          <Row label="Timecode" title="The bext chunk's timecode origin">
            <span class="smp-tabular">{wav.sampleRate ? formatTime(wav.bext.timeReference / wav.sampleRate, "timecode", ctx) : String(wav.bext.timeReference)}</span>
          </Row>
        )}
        <Row label="Lineage">
          {derived ? (
            <button type="button" class="smp-sm2" title={`Open ${nameOf(derived.lineage.parent)}`} onClick={() => openSample(derived.lineage.parent)}>
              {derived.lineage.kind === "fork" ? "Fork" : derived.lineage.kind === "snippet" ? "Snippet" : "Duplicate"} of {nameOf(derived.lineage.parent)}
            </button>
          ) : (
            <span>Root</span>
          )}
          <span class="smp-flex" />
          <Chip title="Samples forked or saved from this one">{forks.length} fork{forks.length === 1 ? "" : "s"}</Chip>
        </Row>
        {derived?.lineage.kind === "fork" && (
          <Row label="" title="When the parent changes">
            <SegmentedControl size="small" label="When the parent changes" value={derived.lineage.mode} options={[{ value: "follow", label: "Follow", title: "Take the parent's changes" }, { value: "pin", label: "Pin", title: "Keep it as it is now" }]}
              onChange={(mode) => {
                if (ro) return;
                // The fork keeps what it plays now: pinned, as its own block (with the parent's hash); following, with the
                // parent's block as the baseline, so the fields it shares with the parent follow it from here on.
                const parent = derived.lineage.parent;
                const parentEdits = parent.toLowerCase().endsWith(".sample.json")
                  ? readAsset<DerivedSampleAsset>(project, parent, DERIVED_KIND).value.sample
                  : sampleEditsFromSidecar(readAsset<ImportSettings>(project, sidecarPath(parent), SIDECAR_KIND).value);
                const lineage = mode === "pin" ? { kind: "fork" as const, parent, mode, pinnedHash: sampleEditsHash(parentEdits) } : { kind: "fork" as const, parent, mode, baseline: parentEdits };
                session.editDerived({ ...derived, sample: e, lineage }, mode === "pin" ? "Pin to the parent" : "Follow the parent");
              }} />
          </Row>
        )}
        {parentChanged && derived && (
          <div class="smp-insp-warn">
            <span class="smp-warning">Parent changed</span>
            <button type="button" class="smp-sm2" disabled={ro} onClick={() => {
              const parentEdits = sampleEditsFromSidecar(readAsset<ImportSettings>(project, sidecarPath(derived.lineage.parent), SIDECAR_KIND).value);
              session.editDerived({ ...derived, sample: parentEdits, lineage: { ...derived.lineage, pinnedHash: sampleEditsHash(parentEdits) } }, "Update from parent");
            }}>Update</button>
          </div>
        )}
        {forks.length > 0 && (
          <ul class="smp-forks">
            {forks.map((f) => {
              const d = project.assets.get(f) as { lineage?: { kind?: string; mode?: string } } | undefined;
              const badge = d?.lineage?.kind === "snippet" ? "Snippet" : d?.lineage?.mode === "pin" ? "Pinned" : "Follows";
              return (
                <li key={f}>
                  <span class="smp-badge">{badge}</span>
                  <button type="button" class="smp-link" onClick={() => openSample(f)}>{nameOf(f)}</button>
                </li>
              );
            })}
          </ul>
        )}
        <SampleProvenance project={project} sample={session.path} generated={session.settings.value?.generated} writable={!ro} />
      </div>
      {e.tempo && (
        <>
          <h4 class="smp-ph">Music</h4>
          <div class="smp-insp-body">
            <Row label="Exits" title="Music may leave at an Exit marker (decision log D38: the post-exit tail rings out)">
              <span class="smp-tabular">{list("exit").map((m) => formatTime(viewTime(e, m.at), timeFormat.value, ctx)).join(", ") || <span class="smp-muted">none · set a marker's Type to Exit</span>}</span>
            </Row>
            <Row label="Hit points"><span class="smp-tabular">{list("hit").map((m) => formatTime(viewTime(e, m.at), timeFormat.value, ctx)).join(", ") || <span class="smp-muted">none</span>}</span></Row>
            <Row label="Cues"><span>{list("cue").map((m) => m.name).join(", ") || <span class="smp-muted">none</span>}</span></Row>
            <Row label="Tags" title="A stinger plays over the music on a change">
              <label class="smp-check">
                <input type="checkbox" checked={e.stinger} disabled={ro} onChange={(ev) => commit(setStinger(e, (ev.currentTarget as HTMLInputElement).checked))} />
                Stinger
              </label>
            </Row>
          </div>
        </>
      )}
      {linked && (
        <div class="smp-source">
          <div class="smp-source-head">
            <span>Source</span>
            <Chip tone={changed ? "warning" : "success"} title="The file isn't changed unless you use Write to file">From file{changed ? ` · ${changed} changed` : ""}</Chip>
            <span class="smp-flex" />
            <button type="button" class="smp-ibtn smp-plain" aria-label="Detach sample from file" title="Detach from file: stop tracking the WAV for this whole sample. Its markers, loops, tempo and root note stay as they are now, as project-only values." disabled={ro} onClick={() => commit(detachAll(e))}>
              <SampleIcon name="detach" size={14} />
            </button>
          </div>
        </div>
      )}
      <div class="smp-insp-body">
        <SampleEncoding session={session} />
      </div>
      <h4 class="smp-ph">Used by</h4>
      <div class="smp-insp-body">
        {uses.length === 0 ? (
          <p class="smp-muted">Not used by any playlist or sequence yet</p>
        ) : (
          <ul class="smp-uses">
            {uses.map((u) => {
              const { badge, name } = useName(u.path);
              return (
                <li key={u.path} title={`${u.path}${u.count > 1 ? ` · ${u.count} entries use it` : badge === "Playlist" ? " · an entry or a sequence clip plays it" : " · made from this sample"}`}>
                  <span class="smp-badge">{badge}</span>
                  <button type="button" class="smp-link" onClick={() => (u.path.endsWith(".playlist.json") ? openRoute({ screen: "playlists", asset: u.path }) : openSample(u.path))}>{name}</button>
                  {u.count > 1 && <span class="smp-muted"> ×{u.count}</span>}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </>
  );
}
