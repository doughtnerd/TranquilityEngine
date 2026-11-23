// The Inspector on the Samples screen (the prototype's): the selected marker, loop, trim, snippet or the sample itself.
// Markers: type, name, time or range, colour (notes), note, and the Source block (file vs project per field with a
// revert each, Detach). Loops: Repeats, Active, Exit and its fade, Re-entry, Direction, Crossfade. The sample: Load,
// kind, Stinger, measured loudness, lineage, the whole sample's Source block, its Encoding per platform (ADR 0351 §6:
// where each setting comes from, overrides, sizes and memory) and the playlists that use it.
import { useState } from "preact/hooks";
import type { SampleEdits, SampleLoop, SampleMarker, SampleKind } from "../../../engine/audio/sample/types";
import { parentChangedSincePin, sampleEditsHash, sampleEditsFromSidecar } from "../../../engine/audio/sample/format";
import { readAsset } from "../../../editor/assetDocuments";
import { Chip } from "../../../editor/ui/Chip";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { SampleEncoding } from "./SampleEncoding";
import { sidecarPath, type ImportSettings } from "../../../engine/scene/importSettings";
import { formatTime, parseTime, type TimeContext } from "../../components/timeRulerModel";
import { openRoute, toasts } from "../../shell/studioServices";
import { LipsyncField } from "./LipsyncField";
import * as act from "./sampleActions";
import {
  convertMarker, deleteMarker, DIRECTION_NAMES, hasFixedName, isHold, loopName, MARKER_TYPE_NAMES, MARKER_TYPE_ORDER, moveLoop, moveMarker, removeLoop, resetTrim, setStinger, setTrim, snippets,
  tapeSnippet, toggleSnippet, updateLoop, updateMarker, viewTime, type SampleEdit,
} from "./sampleEditing";
import { changedCount, detachAll, detachMarker, fileOrigin, loopDiff, markerDiff, revertLoop, revertMarker, type DiffRow } from "./sampleFile";
import { nameOf, usesOf } from "./sampleLibrary";
import { lengthOf, loudnessOf, SIDECAR_KIND, wavMetadataOf, type SampleSession } from "./sampleSession";
import { trimOf } from "./sampleTime";
import { liveSelection, trimHoldingMarkers } from "./sampleView";
import { dialog, openSample, openSession, select, selection, timeFormat } from "./samplesState";

const COLOURS: { value: number; label: string }[] = [1, 2, 3, 4, 5, 6, 7, 8].map((n) => ({ value: n, label: `Colour ${n}` }));

function TimeField(props: { label: string; value: number; ctx: TimeContext; disabled?: boolean; onCommit(t: number): void }) {
  const fmt = timeFormat.value;
  const shown = formatTime(props.value, fmt, props.ctx);
  const [text, setText] = useState<string | null>(null);
  return (
    <input
      class="smp-time"
      aria-label={props.label}
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

const fmtDiff = (v: string | number | null, ctx: TimeContext): string => (typeof v === "number" ? formatTime(v, timeFormat.value, ctx) : v === null ? "none" : String(v));

function SourceBlock<F extends string>(props: { origin: string | null; rows: DiffRow<F>[]; names: Record<F, string>; ctx: TimeContext; numeric?: readonly F[]; onRevert(f: F): void; onDetach?(): void }) {
  if (!props.origin) return null;
  return (
    <div class="smp-source">
      <div class="smp-source-head">
        <Chip tone={props.rows.length ? "warning" : "success"} title="The file isn't changed unless you use Write to file">
          From file · {props.origin}
          {props.rows.length ? ` · ${props.rows.length} changed` : ""}
        </Chip>
        {props.onDetach && <button class="smp-link" onClick={props.onDetach}>Detach</button>}
      </div>
      {props.rows.map((r) => (
        <div key={r.field} class="smp-diff">
          <span class="smp-muted">{props.names[r.field]}</span>
          <span>
            {props.numeric && !props.numeric.includes(r.field) ? String(r.file) : fmtDiff(r.file, props.ctx)} → <b>{props.numeric && !props.numeric.includes(r.field) ? String(r.project) : fmtDiff(r.project, props.ctx)}</b>
          </span>
          <button class="smp-link" title="Put back what the file says" onClick={() => props.onRevert(r.field)}>Revert</button>
        </div>
      ))}
    </div>
  );
}

export function InspectorPanel() {
  const session = openSession.value;
  if (!session) {
    return (
      <Panel bodyClass="studio-panel-body">
        <EmptyState compact title="Nothing selected" body="The selected sample's settings, markers and source file." />
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
  let body;
  if (sel.kind === "marker") body = <MarkerInspector e={e} m={e.markers.find((m) => m.id === sel.id)!} length={length} ctx={ctx} commit={commit} ro={ro} />;
  else if (sel.kind === "loop") body = <LoopInspector e={e} l={e.loops.find((l) => l.id === sel.id)!} length={length} ctx={ctx} commit={commit} ro={ro} />;
  else if (sel.kind === "trim") {
    const [a, b] = trimOf(e, length);
    body = (
      <>
        <h3 class="smp-insp-title">Trim</h3>
        <p class="smp-muted">Non-destructive: audio outside never plays.</p>
        <div class="fld">
          <span>Range</span>
          <span class="smp-range-fields">
            <TimeField label="Trim start" value={viewTime(e, a)} ctx={ctx} disabled={ro} onCommit={(t) => commit(setTrim(e, t, b, length))} />–
            <TimeField label="Trim end" value={viewTime(e, b)} ctx={ctx} disabled={ro} onCommit={(t) => commit(setTrim(e, a, t, length))} />
          </span>
        </div>
        <button disabled={ro || !e.trim} onClick={() => commit(resetTrim(e))}>Reset to the whole file</button>
      </>
    );
  } else if (sel.kind === "snippet") {
    const all = snippets(e, length);
    const s = all.find((x) => x.index === sel.index)!;
    body = (
      <>
        <h3 class="smp-insp-title">{s.name}{s.deleted ? " · deleted" : ""}</h3>
        <p class="smp-muted">{formatTime(viewTime(e, s.start), timeFormat.value, ctx)} – {formatTime(viewTime(e, s.end), timeFormat.value, ctx)}</p>
        <div class="smp-actions">
          <button disabled={ro} onClick={() => (dialog.value = { kind: "snippet", index: s.index })}>Save as sample…</button>
          <button disabled={ro || s.index === 1} onClick={() => commit(tapeSnippet(e, s.index, "left", length))}>Tape to left</button>
          <button disabled={ro || s.index === all.length} onClick={() => commit(tapeSnippet(e, s.index, "right", length))}>Tape to right</button>
          <button disabled={ro} onClick={() => commit(toggleSnippet(e, s.index, length))}>{s.deleted ? "Restore" : "Delete"}</button>
          <button disabled={ro} onClick={() => act.closeSnippetGap(s.index)}>{s.deleted ? "Close gap" : "Delete and close gap"}</button>
        </div>
      </>
    );
  } else if (sel.kind === "pickup" || sel.kind === "tail" || sel.kind === "link") {
    const what = { pickup: ["Pickup", "Plays once, from the trim start to the first loop."], tail: ["Tail", "Plays once after the last loop, to the trim end."], link: ["Link", "Plays once between two loops."] }[sel.kind];
    body = (
      <>
        <h3 class="smp-insp-title">{what[0]}</h3>
        <p class="smp-muted">{what[1]} Double-click it on the loop row to add a loop there.</p>
        <button onClick={() => act.togglePlay()}>Play {what[0].toLowerCase()}</button>
      </>
    );
  } else body = <SampleInspector session={session} e={e} length={length} ctx={ctx} commit={commit} ro={ro} />;
  return (
    <Panel class="smp-inspector" bodyClass="smp-insp-body">
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
  return (
    <>
      <div class="smp-insp-head">
        <h3 class="smp-insp-title">{MARKER_TYPE_NAMES[m.type]} · {m.name}</h3>
        {m.type === "note" && <button class="smp-link" disabled={ro} onClick={() => commit(convertMarker(e, m.id, length))}>{m.end !== undefined ? "Make point" : "Make range"}</button>}
        <button class="smp-link danger" disabled={ro} onClick={() => (commit(deleteMarker(e, m.id)), select({ kind: "sample" }))}>Delete</button>
      </div>
      {outside && (
        <p class="smp-warning">
          Outside the trim · won't play <button class="smp-link" disabled={ro} onClick={() => commit({ next: { ...e, trim: trimHoldingMarkers(e, length) }, label: "Trim" })}>Extend trim</button>
        </p>
      )}
      <SourceBlock origin={fileOrigin(m)} rows={markerDiff(m)} names={{ type: "Type", name: "Name", at: m.end !== undefined ? "Start" : "Position", end: "End" }} ctx={ctx} numeric={["at", "end"]}
        onRevert={(f) => commit(revertMarker(e, m.id, f))} onDetach={() => commit(detachMarker(e, m.id))} />
      <div class="fld">
        <span>Type</span>
        <SegmentedControl size="small" label="Marker type" value={m.type} options={MARKER_TYPE_ORDER.map((t) => ({ value: t, label: MARKER_TYPE_NAMES[t] }))} onChange={(t) => !ro && commit(updateMarker(e, m.id, { type: t }))} />
      </div>
      <p class="smp-muted smp-type-help">
        {{ note: "Annotation only; can be a range.", exit: "Music may leave here for a transition; the audio after it rings out as the tail.", entry: "Music enters here: a Switch change at a beat or bar starts the sample early, so this point lands on it.", hit: "Stinger: this beat lands on the change.", cue: "Sends this cue name to the game when playback passes it." }[m.type]}
      </p>
      <label class="fld">
        <span>{m.type === "cue" ? "Cue name" : "Name"}</span>
        <input value={m.name} disabled={ro || hasFixedName(m.type)} title={hasFixedName(m.type) ? `${MARKER_TYPE_NAMES[m.type]} has a fixed name` : undefined} aria-label={m.type === "cue" ? "Cue name" : "Name"}
          onChange={(ev) => commit(updateMarker(e, m.id, { name: (ev.currentTarget as HTMLInputElement).value }))} />
      </label>
      <div class="fld">
        <span>{m.end !== undefined ? "Range" : "At"}</span>
        <span class="smp-range-fields">
          <TimeField label={m.end !== undefined ? "Range start" : "At"} value={viewTime(e, m.at)} ctx={ctx} disabled={ro} onCommit={(t) => commit(moveMarker(e, m.id, t, length, m.end))} />
          {m.end !== undefined && (
            <>
              –<TimeField label="Range end" value={viewTime(e, m.end)} ctx={ctx} disabled={ro} onCommit={(t) => commit(moveMarker(e, m.id, m.at, length, t))} />
            </>
          )}
        </span>
      </div>
      {m.type === "note" && (
        <div class="fld">
          <span>Colour</span>
          <span class="smp-swatches" role="radiogroup" aria-label="Colour">
            {COLOURS.map((c) => (
              <button key={c.value} role="radio" aria-checked={m.color === c.value} aria-label={c.label} class={`smp-swatch${m.color === c.value ? " on" : ""}`} style={{ background: `var(--series-${c.value})` }} disabled={ro}
                onClick={() => commit(updateMarker(e, m.id, { color: c.value }))} />
            ))}
            <button class="smp-link" disabled={ro || m.color === undefined} onClick={() => commit(updateMarker(e, m.id, { color: null }))}>Default</button>
          </span>
        </div>
      )}
      <label class="fld">
        <span>Note</span>
        <textarea rows={3} value={m.note ?? ""} placeholder="Shown on hover" disabled={ro} aria-label="Note" onChange={(ev) => commit(updateMarker(e, m.id, { note: (ev.currentTarget as HTMLTextAreaElement).value }))} />
      </label>
    </>
  );
}

function LoopInspector(props: Part & { l: SampleLoop }) {
  const { e, l, length, ctx, commit, ro } = props;
  const set = (patch: Parameters<typeof updateLoop>[2]) => commit(updateLoop(e, l.id, patch));
  return (
    <>
      <div class="smp-insp-head">
        <h3 class="smp-insp-title">{loopName(e, l.id)}</h3>
        <button class="smp-link" onClick={() => act.togglePlay({ kind: "loop", id: l.id })}>Play</button>
        <button class="smp-link danger" disabled={ro} onClick={() => (commit(removeLoop(e, l.id)), select({ kind: "sample" }))}>Remove loop</button>
      </div>
      {isHold(l) && <p class="smp-muted">A hold point: the playhead parks here while the loop is active.</p>}
      <SourceBlock origin={fileOrigin(l)} rows={loopDiff(l)} names={{ start: "Start", end: "End", direction: "Direction", count: "Repeats" }} ctx={ctx} numeric={["start", "end"]} onRevert={(f) => commit(revertLoop(e, l.id, f))} />
      <div class="fld">
        <span>Range</span>
        <span class="smp-range-fields">
          <TimeField label="Loop start" value={viewTime(e, l.start)} ctx={ctx} disabled={ro} onCommit={(t) => commit(moveLoop(e, l.id, t, l.end, length))} />–
          <TimeField label="Loop end" value={viewTime(e, l.end)} ctx={ctx} disabled={ro} onCommit={(t) => commit(moveLoop(e, l.id, l.start, t, length))} />
        </span>
      </div>
      <div class="fld">
        <span>Repeats</span>
        <span class="smp-range-fields">
          <SegmentedControl size="small" label="Repeats" value={l.count === 0 ? "endless" : "count"} options={[{ value: "endless", label: "∞ Endless" }, { value: "count", label: "Set count" }]}
            onChange={(v) => !ro && set({ count: v === "endless" ? 0 : Math.max(1, l.count || 2), active: v === "endless" ? l.active : l.active === "held" ? "always" : l.active })} />
          {l.count > 0 && <input type="number" min={1} max={999} value={l.count} aria-label="Repeat count" disabled={ro} onChange={(ev) => set({ count: Number((ev.currentTarget as HTMLInputElement).value) })} />}
        </span>
      </div>
      <div class="fld">
        <span>Active</span>
        <SegmentedControl size="small" label="Active" value={l.active} options={[{ value: "always", label: "Always" }, { value: "held", label: "While held" }, { value: "parameter", label: "Parameter" }]} onChange={(v) => !ro && set({ active: v })} />
      </div>
      {l.active === "parameter" && <p class="smp-muted">Binding: per clip, in its sequence or playlist.</p>}
      {l.active !== "always" && (
        <>
          <div class="fld">
            <span>Exit</span>
            <SegmentedControl size="small" label="Exit" value={l.exit} options={[{ value: "jump", label: "Jump now" }, { value: "finish", label: "Finish pass" }, { value: "crossfade", label: "Crossfade" }]} onChange={(v) => !ro && set({ exit: v })} />
          </div>
          <label class="fld">
            <span>Exit fade</span>
            <span><input type="number" min={1} max={2000} value={l.exitFadeMs} aria-label="Exit fade in ms" disabled={ro} onChange={(ev) => set({ exitFadeMs: Number((ev.currentTarget as HTMLInputElement).value) })} /> ms</span>
          </label>
          <div class="fld">
            <span>Re-entry</span>
            <SegmentedControl size="small" label="Re-entry" value={l.reentry} options={[{ value: "ignore", label: "Ignore" }, { value: "reenter", label: "Re-enter" }]} onChange={(v) => !ro && set({ reentry: v })} />
          </div>
        </>
      )}
      <div class="fld">
        <span>Direction</span>
        <SegmentedControl size="small" label="Direction" value={l.direction} options={(["forward", "pingPong", "backward"] as const).map((d) => ({ value: d, label: DIRECTION_NAMES[d] }))} onChange={(v) => !ro && set({ direction: v })} />
      </div>
      <label class="fld">
        <span>Crossfade</span>
        <span><input type="number" min={0} max={500} value={l.crossfadeMs} aria-label="Crossfade in ms" disabled={ro} onChange={(ev) => set({ crossfadeMs: Number((ev.currentTarget as HTMLInputElement).value) })} /> ms</span>
      </label>
      <label class="fld">
        <span>Note</span>
        <textarea rows={2} value={l.note ?? ""} disabled={ro} aria-label="Loop note" onChange={(ev) => set({ note: (ev.currentTarget as HTMLTextAreaElement).value })} />
      </label>
    </>
  );
}

const KIND_OPTIONS: { value: SampleKind; label: string }[] = [
  { value: "oneshot", label: "One-shot" },
  { value: "loop", label: "Loop" },
  { value: "sustain", label: "Sustain" },
  { value: "music", label: "Music" },
];

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
    const parent = derived.lineage.parent;
    const parentEdits = sampleEditsFromSidecar(readAsset<ImportSettings>(project, sidecarPath(parent), SIDECAR_KIND).value);
    parentChanged = parentChangedSincePin(derived, parentEdits);
  }
  const db = (v: number) => (Number.isFinite(v) ? v.toFixed(1) : "−∞");
  return (
    <>
      <h3 class="smp-insp-title">{nameOf(session.path)}</h3>
      <p class="smp-muted">{session.path}</p>
      <div class="fld">
        <span>Kind</span>
        <SegmentedControl size="small" label="Kind" value={e.kind} options={KIND_OPTIONS} onChange={(k) => !ro && commit({ next: { ...e, kind: k }, label: `Make it ${KIND_OPTIONS.find((o) => o.value === k)!.label.toLowerCase()}` })} />
      </div>
      {e.tempo && (
        <label class="fld smp-check">
          <span>Stinger</span>
          <input type="checkbox" checked={e.stinger} disabled={ro} onChange={(ev) => commit(setStinger(e, (ev.currentTarget as HTMLInputElement).checked))} />
        </label>
      )}
      <h4 class="smp-insp-section">Sample</h4>
      <div class="fld">
        <span>Loudness</span>
        <span>{loud ? `${db(loud.integrated)} LUFS · peak ${db(loud.peak)} dBFS` : "Measuring…"}</span>
      </div>
      <LipsyncField e={e} ro={ro} commit={commit} onProblem={(text) => toasts.show({ text })} />
      {wav?.bext && (
        <div class="fld">
          <span>Timecode</span>
          <span>{wav.sampleRate ? formatTime(wav.bext.timeReference / wav.sampleRate, "timecode", ctx) : String(wav.bext.timeReference)} (bext origin)</span>
        </div>
      )}
      <div class="fld">
        <span>Lineage</span>
        <span>
          {derived ? `${derived.lineage.kind === "fork" ? "Fork" : derived.lineage.kind === "snippet" ? "Snippet" : "Duplicate"} of ` : "Root"}
          {derived && <button class="smp-link" onClick={() => openSample(derived.lineage.parent)}>{nameOf(derived.lineage.parent)}</button>}
          {derived?.lineage.kind === "fork" && ` · ${derived.lineage.mode === "follow" ? "follows the parent" : "pinned"}`}
          {forks.length > 0 && ` · ${forks.length} fork${forks.length === 1 ? "" : "s"}`}
        </span>
      </div>
      {parentChanged && derived && (
        <p class="smp-warning">
          Parent changed{" "}
          <button class="smp-link" disabled={ro} onClick={() => {
            const parentEdits = sampleEditsFromSidecar(readAsset<ImportSettings>(project, sidecarPath(derived.lineage.parent), SIDECAR_KIND).value);
            session.editDerived({ ...derived, sample: parentEdits, lineage: { ...derived.lineage, pinnedHash: sampleEditsHash(parentEdits) } }, "Update from parent");
          }}>Update</button>
        </p>
      )}
      {linked && (
        <div class="smp-source">
          <div class="smp-source-head">
            <Chip tone={changed ? "warning" : "success"} title="The file isn't changed unless you use Write to file">From file{changed ? ` · ${changed} changed` : ""}</Chip>
            <button class="smp-link" disabled={ro} onClick={() => commit(detachAll(e))}>Detach</button>
          </div>
        </div>
      )}
      <SampleEncoding session={session} />
      <h4 class="smp-insp-section">Used by</h4>
      {uses.length === 0 ? (
        <p class="smp-muted">Not used by any playlist or sequence yet.</p>
      ) : (
        <ul class="smp-uses">
          {uses.map((u) => (
            <li key={u.path}>
              <button class="smp-link" onClick={() => (u.path.endsWith(".playlist.json") ? openRoute({ screen: "playlists", asset: u.path }) : openSample(u.path))}>{u.path}</button>
              {u.count > 1 && <span class="smp-muted"> · {u.count} uses</span>}
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
