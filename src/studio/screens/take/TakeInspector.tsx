// The Take screen's Inspector (ADR 0334; the prototype's Inspector): the selected instance (its playlist, time range,
// emitter, and its parameters at the playhead as recorded beside the replaying instance's live values), or the selected
// note (its text, colour and time, editable; Delete), or with nothing selected the global parameters at the playhead.
// And the Mixer strip: each bus's authored and live level with its meter while the take replays. Views over props.
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { TAKE_NOTE_COLOURS, type TakeNoteMarker, type TakeNoteRegion } from "../../../engine/audio/take/notes";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Fader } from "../../components/Fader";
import { Meter } from "../../components/Meter";
import { formatTime } from "../../components/timeAxis";
import type { ReplayPose } from "../../runtime/takeReplay";
import { noteColourCss } from "./notesEdits";
import { valueText, type BusStrip, type ParameterRow } from "./takeInspectorModel";
import { pathLabel, type TakeInstance } from "./takeTimeline";

export interface InstanceDetailsProps {
  readonly instance: TakeInstance;
  readonly emitterName: string | null;
  readonly emitterPose: ReplayPose | null;
  readonly rows: readonly ParameterRow[];
  /** The replaying instance is sounding now. */
  readonly live: boolean;
  onGoToStart(): void;
  onOpenSource(): void;
}

const vec = (v: { x: number; y: number; z: number }) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;

export function InstanceDetails(props: InstanceDetailsProps) {
  const { instance: i } = props;
  const o = i.options;
  return (
    <div class="tk-inspector">
      <div class="tk-ins-head">
        <span class="tk-badge">Playlist</span>
        <strong class="tk-ins-title" title={i.path}>{pathLabel(i.path)}</strong>
        <button type="button" class="tk-link" onClick={props.onOpenSource} title={`Open ${i.path}`}>Open playlist ›</button>
      </div>
      <dl class="tk-facts">
        <dt>Path</dt>
        <dd title={i.path}>{i.path}</dd>
        <dt>Instance</dt>
        <dd>
          {formatTime(i.start)} – {i.end === null ? "end of take" : formatTime(i.end)}
          {i.release !== null && <> · released {formatTime(i.release)}</>}
        </dd>
        <dt>Emitter</dt>
        <dd>{i.emitter === null ? "None (flat)" : `${props.emitterName ?? `#${i.emitter}`}${props.emitterPose ? ` at ${vec(props.emitterPose.position)}` : ""}`}</dd>
        {(o.volume !== undefined || o.pitch !== undefined || o.bus !== undefined || o.priority !== undefined) && (
          <>
            <dt>Options</dt>
            <dd>{[o.volume !== undefined && `volume ${valueText(o.volume)}`, o.pitch !== undefined && `pitch ${valueText(o.pitch)}`, o.bus && `bus ${o.bus}`, o.priority !== undefined && `priority ${o.priority}`].filter(Boolean).join(" · ")}</dd>
          </>
        )}
      </dl>
      <button type="button" onClick={props.onGoToStart}>Go to start</button>
      <h4 class="tk-ins-sub">Parameters at the playhead</h4>
      {props.rows.length === 0 ? (
        <p class="tk-note">The game set no parameters on this instance.</p>
      ) : (
        <table class="tk-params">
          <thead>
            <tr>
              <th scope="col">Parameter</th>
              <th scope="col">Recorded</th>
              <th scope="col" title="What the replaying instance reports now, in the current project">Live</th>
            </tr>
          </thead>
          <tbody>
            {props.rows.map((r) => (
              <tr key={r.name} class={r.differs ? "differs" : undefined}>
                <th scope="row">{r.name}</th>
                <td>{valueText(r.recorded)}</td>
                <td>{props.live ? valueText(r.live) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {!props.live && <p class="tk-note">Replay the take through this instance to see its live values.</p>}
    </div>
  );
}

export interface NoteDetailsProps {
  readonly note: ({ kind: "marker" } & TakeNoteMarker) | ({ kind: "region" } & TakeNoteRegion);
  readonly writable: boolean;
  onText(text: string): void;
  onColour(color: number): void;
  onTime(at: number): void;
  onSpan(from: number, to: number): void;
  onDelete(): void;
  onGoTo(): void;
}

/** A time field in seconds, committed on change. */
function SecondsField(props: { label: string; value: number; disabled: boolean; onCommit(v: number): void }) {
  return (
    <label class="tk-field">
      <span>{props.label}</span>
      <input
        type="number"
        min={0}
        step={0.01}
        value={Math.round(props.value * 1000) / 1000}
        disabled={props.disabled}
        aria-label={`${props.label}, seconds`}
        onChange={(e) => {
          const v = Number((e.currentTarget as HTMLInputElement).value);
          if (Number.isFinite(v)) props.onCommit(v);
        }}
      />
      <span class="tk-unit">s</span>
    </label>
  );
}

export function NoteDetails(props: NoteDetailsProps) {
  const { note } = props;
  const [text, setText] = useState(note.text);
  useEffect(() => setText(note.text), [note.id, note.text]);
  const commit = () => {
    if (text !== note.text) props.onText(text);
  };
  return (
    <div class="tk-inspector">
      <div class="tk-ins-head">
        <span class="tk-badge">{note.kind === "marker" ? "Note marker" : "Note region"}</span>
        <button type="button" class="tk-link" onClick={props.onGoTo}>Go to</button>
      </div>
      <label class="tk-field tk-field-text">
        <span>Note</span>
        <textarea rows={4} value={text} disabled={!props.writable} placeholder="What to look at here" aria-label="Note text" onInput={(e) => setText((e.currentTarget as HTMLTextAreaElement).value)} onBlur={commit} />
      </label>
      <div class="tk-swatches" role="radiogroup" aria-label="Note colour">
        {TAKE_NOTE_COLOURS.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={c === note.color} aria-label={`Colour ${noteColourCss(c)}`} class={`tk-swatch${c === note.color ? " on" : ""}`} style={{ "--tk-note": noteColourCss(c) }} disabled={!props.writable} onClick={() => props.onColour(c)} />
        ))}
      </div>
      {note.kind === "marker" ? (
        <SecondsField label="At" value={note.at} disabled={!props.writable} onCommit={props.onTime} />
      ) : (
        <div class="tk-span-fields">
          <SecondsField label="From" value={note.from} disabled={!props.writable} onCommit={(v) => props.onSpan(v, note.to)} />
          <SecondsField label="To" value={note.to} disabled={!props.writable} onCommit={(v) => props.onSpan(note.from, v)} />
        </div>
      )}
      <button type="button" class="danger" disabled={!props.writable} onClick={props.onDelete}>
        Delete {note.kind === "marker" ? "marker" : "region"}
      </button>
      {!props.writable && <p class="tk-note">This project is read-only: notes can't be changed.</p>}
    </div>
  );
}

/** Nothing selected: the global parameters at the playhead. */
export function PlayheadValues(props: { readonly open: boolean; readonly time: number; readonly values: readonly { name: string; text: string }[] }) {
  if (!props.open) return <EmptyState compact title="Nothing selected" body="Open a take, then select an instance or a note on its timeline." />;
  return (
    <div class="tk-inspector">
      <div class="tk-ins-head">
        <span class="tk-badge">Take</span>
        <strong class="tk-ins-title">Values at {formatTime(props.time)}</strong>
      </div>
      {props.values.length === 0 ? (
        <p class="tk-note">The game set no global parameters in this take. Select an instance to see its own.</p>
      ) : (
        <dl class="tk-facts">
          {props.values.map((v) => (
            <Fragment key={v.name}>
              <dt>{v.name}</dt>
              <dd>{v.text}</dd>
            </Fragment>
          ))}
        </dl>
      )}
    </div>
  );
}

export interface MixerStripProps {
  readonly strips: readonly BusStrip[];
  /** The runtime is up (readings are live). */
  readonly running: boolean;
  onOpenMixer(): void;
}

export function MixerStrip(props: MixerStripProps) {
  if (!props.running) return <EmptyState compact title="No live mix" body="The Studio's audio runtime isn't running, so there are no bus readings." />;
  if (props.strips.length === 0) return <EmptyState compact title="No buses" body="This project's mix has no buses yet." />;
  return (
    <div class="tk-mixer">
      <div class="tk-mixer-tools">
        <span class="tk-note">Authored level (handle) and live level (tick) of each bus while the take replays.</span>
        <button type="button" class="tk-link" onClick={props.onOpenMixer}>Open Mixer ›</button>
      </div>
      <div class="tk-strips" role="list" aria-label="Buses">
        {props.strips.map((s) => (
          <div class="tk-strip" role="listitem" key={s.name}>
            <Fader orientation="vertical" label={`${s.name} level`} value={s.authoredDb} ghostDb={s.liveDb} ghostTitle={`Live: ${s.text}`} disabled title="Levels are edited on the Mixer" onValue={() => {}}>
              <Meter orientation="vertical" label={`${s.name} meter`} peakDb={s.peakDb} />
            </Fader>
            <span class="tk-strip-name" title={s.name}>{s.name}</span>
            <span class="tk-strip-db">{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
