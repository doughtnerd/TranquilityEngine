// The Take screen's Inspector (ADR 0348; spec §4.5.5; the prototype's Inspector): the selected instance (its playlist's
// property cards, authored value against live value with the game parameter driving each, its parameters at the playhead
// as recorded beside the replaying instance's live values, its emitter), or the selected note (its text, colour and time,
// editable; Delete), or with nothing selected the focused track's cards and the game's values at the playhead.
// And the Mixer strip: each bus's authored and live level with its meter while the take replays, and the levels the take
// recorded at the playhead while it is paused. Views over props.
import { Fragment } from "preact";
import { useEffect, useState } from "preact/hooks";
import { TAKE_NOTE_COLOURS, type TakeNoteMarker, type TakeNoteRegion } from "../../../engine/audio/take/notes";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { InfoTip } from "../../../editor/ui/InfoTip";
import { Fader } from "../../components/Fader";
import { Icon } from "../../components/Icon";
import { Meter } from "../../components/Meter";
import { formatTime } from "../../components/timeAxis";
import type { ReplayPose } from "../../runtime/takeReplay";
import type { TakeFrame } from "../../../engine/audio/take/types";
import { noteColourCss } from "./notesEdits";
import { PlayheadPicture } from "./TakePicture";
import { valueText, type BusStrip, type ParameterRow, type PlayheadSummary } from "./takeInspectorModel";
import { pathLabel, type TakeInstance } from "./takeTimeline";
import { unitText, type PropertyCard } from "./takePlaylists";
import { playheadText } from "../run/RunRuler";

/** The cards of driven and static properties (spec §4.5.5): authored tick, live fill, and the mapping from its parameter. */
export function PropertyCards(props: { readonly cards: readonly PropertyCard[]; readonly hovered?: string | null; onHover?(parameter: string | null): void }) {
  if (props.cards.length === 0) return null;
  return (
    <div class="tk-cards" role="list" aria-label="Values at the playhead">
      {props.cards.map((c) => (
        <div key={c.key} role="listitem" class={`tk-card${c.driver ? " driven" : ""}`} aria-label={`${c.label} ${c.text}, authored ${unitText(c.authored, c.unit)}`}>
          <div class="tk-card-top">
            <span class="tk-card-label">{c.label}</span>
            <span class="tk-card-value">{c.text}</span>
          </div>
          <div class="tk-card-bar" aria-hidden="true">
            <span class="tk-card-fill" style={{ width: `${c.liveAt * 100}%` }} />
            <span class="tk-card-tick" style={{ left: `${c.authoredAt * 100}%` }} title={`Authored value: ${unitText(c.authored, c.unit)}`} />
          </div>
          {c.driver ? (
            <div class="tk-card-map">
              <span
                class={`tk-chip${props.hovered === c.driver.parameter ? " linked" : ""}`}
                title={`Driven by the game parameter ${c.driver.parameter}`}
                onMouseEnter={props.onHover ? () => props.onHover!(c.driver!.parameter) : undefined}
                onMouseLeave={props.onHover ? () => props.onHover!(null) : undefined}
              >
                ← {c.driver.parameter}
              </span>
              <span> · {c.driver.mapping}</span>
            </div>
          ) : (
            c.note && <div class="tk-card-map">{c.note}</div>
          )}
        </div>
      ))}
    </div>
  );
}

export interface InstanceDetailsProps {
  readonly instance: TakeInstance;
  /** The playlist's type as the badge says it ("Switch"), or null when the path isn't a playlist. */
  readonly kind: string | null;
  readonly emitterName: string | null;
  readonly emitterPose: ReplayPose | null;
  readonly cards: readonly PropertyCard[];
  readonly rows: readonly ParameterRow[];
  /** The replaying instance is sounding now. */
  readonly live: boolean;
  readonly hovered?: string | null;
  onHover?(parameter: string | null): void;
  onOpenSource(): void;
}

const vec = (v: { x: number; y: number; z: number }) => `${v.x.toFixed(1)}, ${v.y.toFixed(1)}, ${v.z.toFixed(1)}`;

/** The Inspector's header: badge, name, sub line and the link to the playlist. */
function InspectorHead(props: { badge: string; name: string; title: string; sub: string; tip?: string; onOpen?(): void }) {
  return (
    <div class="tk-ins-head">
      <span class="tk-badge">{props.badge}</span>
      <strong class="tk-ins-title" title={props.title}>{props.name}</strong>
      <span class="tk-ins-subline">{props.sub}</span>
      {props.tip && <InfoTip text={props.tip} />}
      {props.onOpen && (
        <button type="button" class="tk-ins-open" aria-label={`Open ${props.name} in Playlists`} title={`Open ${props.name} in Playlists`} onClick={props.onOpen}>
          <Icon name="external" size={14} />
        </button>
      )}
    </div>
  );
}

export function InstanceDetails(props: InstanceDetailsProps) {
  const { instance: i } = props;
  const o = i.options;
  const options = [o.volume !== undefined && `volume ${valueText(o.volume)}`, o.pitch !== undefined && `pitch ${valueText(o.pitch)}`, o.bus && `bus ${o.bus}`, o.priority !== undefined && `priority ${o.priority}`].filter(Boolean).join(" · ");
  return (
    <div class="tk-inspector">
      <InspectorHead
        badge={props.kind ?? "Sound"}
        name={pathLabel(i.path)}
        title={i.path}
        sub={`Instance ${playheadText(i.start)} – ${i.end === null ? "end" : playheadText(i.end)}`}
        tip="Values show this playlist as it sounds here: the game's values at the playhead through your current curves. The tick is the authored value."
        onOpen={props.onOpenSource}
      />
      {props.onOpenSource && (
        <button type="button" class="tk-btn tk-ins-open-text" title={`Open ${i.path} on the Playlists screen`} onClick={props.onOpenSource}>
          Open {props.kind === "Sequence" ? "sequence" : "playlist"} ›
        </button>
      )}
      <PropertyCards cards={props.cards} hovered={props.hovered} onHover={props.onHover} />
      {props.rows.length > 0 && (
        <>
          <h4 class="tk-ins-sub">Parameters at the playhead</h4>
          <div class="tk-scroll">
            <table class="tk-params">
              <thead>
                <tr>
                  <th scope="col">Parameter</th>
                  <th scope="col">Recorded</th>
                  <th scope="col" title="What the replaying instance reports now, in the current project (replay the take through this instance to see it)">Live</th>
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
          </div>
        </>
      )}
      <dl class="tk-facts">
        {i.release !== null && (
          <>
            <dt>Held</dt>
            <dd>
              {formatTime(i.start)} – {formatTime(i.release)}
            </dd>
          </>
        )}
        <dt>Emitter</dt>
        <dd>{i.emitter === null ? "None (flat)" : `${props.emitterName ?? `#${i.emitter}`}${props.emitterPose ? ` at ${vec(props.emitterPose.position)}` : ""}`}</dd>
        {options && (
          <>
            <dt>Options</dt>
            <dd>{options}</dd>
          </>
        )}
      </dl>
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

/** Nothing selected: the focused lane's cards ("Track values at the playhead"), the picture on screen and the game's values. */
export function PlayheadValues(props: {
  readonly open: boolean;
  readonly time: number;
  readonly picture?: TakeFrame | null;
  readonly values: readonly { name: string; text: string }[];
  /** The lane the cards are for (the last one picked, else the first): its path, badge and cards. */
  readonly track?: { readonly path: string; readonly kind: string | null; readonly cards: readonly PropertyCard[] } | null;
  readonly hovered?: string | null;
  /** Under a selected instance's details: no head and no track cards, just the picture and the take at the playhead. */
  readonly below?: boolean;
  /** ADR 0408: the take at the playhead (what sounds, the markers either side, the time of day). */
  readonly summary?: PlayheadSummary | null;
  /** Where the take was recorded: its project, engine and device. */
  readonly recorded?: { readonly project: string; readonly engine: string; readonly device: string } | null;
  onHover?(parameter: string | null): void;
  onOpenSource?(path: string): void;
  /** Select an instance sounding now (its timeline key). */
  onSelectInstance?(key: string): void;
  /** Move the playhead (a marker's time). */
  onSeek?(t: number): void;
}) {
  if (!props.open) return <EmptyState compact title="Nothing selected" body="Open a take, then select an instance or a note on its timeline." />;
  const t = props.track;
  const sum = props.summary;
  return (
    <div class="tk-inspector">
      {props.below ? (
        <h4 class="tk-ins-sub">Game at the playhead · {formatTime(props.time)}</h4>
      ) : t ? (
        <InspectorHead badge={t.kind ?? "Sound"} name={pathLabel(t.path)} title={t.path} sub="Track values at the playhead" tip="Select a playlist instance to inspect it. Values below: this track at the playhead." onOpen={props.onOpenSource ? () => props.onOpenSource!(t.path) : undefined} />
      ) : (
        <InspectorHead badge="Take" name={`Values at ${formatTime(props.time)}`} title="" sub="" tip="Select a playlist instance to inspect it." />
      )}
      <PlayheadPicture frame={props.picture ?? null} />
      {sum && (
        <>
          <h4 class="tk-ins-sub">At the playhead</h4>
          <dl class="tk-facts">
            <dt>Take time</dt>
            <dd>{formatTime(props.time)}</dd>
            {sum.wallClock && (
              <>
                <dt>In the game</dt>
                <dd title={sum.wallClock.toLocaleString()}>{sum.wallClock.toLocaleTimeString()}</dd>
              </>
            )}
            <dt>Sounding</dt>
            <dd>{sum.playing.length === 1 ? "1 instance" : `${sum.playing.length} instances`}</dd>
            <dt>Started so far</dt>
            <dd>
              {sum.started} of {sum.total}
            </dd>
            {sum.lastMark && (
              <>
                <dt>Last marker</dt>
                <dd>
                  <MarkLink mark={sum.lastMark} onSeek={props.onSeek} />
                </dd>
              </>
            )}
            {sum.nextMark && (
              <>
                <dt>Next marker</dt>
                <dd>
                  <MarkLink mark={sum.nextMark} onSeek={props.onSeek} />
                </dd>
              </>
            )}
          </dl>
          {sum.playing.length > 0 && (
            <>
              <h4 class="tk-ins-sub">Playing now</h4>
              <ul class="tk-playing" aria-label="Playing now">
                {sum.playing.map((p) => (
                  <li key={p.key}>
                    <button type="button" class="tk-playing-row" title={`${p.path}: select this instance`} onClick={() => props.onSelectInstance?.(p.key)}>
                      <span class="tk-playing-name">{p.label}</span>
                      <span class="tk-playing-sub">
                        {p.emitter ? `${p.emitter} · ` : ""}
                        {formatTime(p.playingFor)}
                        {p.releasing ? " · releasing" : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            </>
          )}
        </>
      )}
      {t && <PropertyCards cards={t.cards} hovered={props.hovered} onHover={props.onHover} />}
      {props.values.length > 0 && (
        <>
          <h4 class="tk-ins-sub">Game values</h4>
          <dl class="tk-facts">
            {props.values.map((v) => (
              <Fragment key={v.name}>
                <dt>{v.name}</dt>
                <dd>{v.text}</dd>
              </Fragment>
            ))}
          </dl>
        </>
      )}
      {props.recorded && (
        <>
          <h4 class="tk-ins-sub">Recorded</h4>
          <dl class="tk-facts">
            <dt>Project</dt>
            <dd title={props.recorded.project}>{props.recorded.project}</dd>
            <dt>Engine</dt>
            <dd title={props.recorded.engine}>{props.recorded.engine}</dd>
            <dt>Device</dt>
            <dd title={props.recorded.device}>{props.recorded.device}</dd>
          </dl>
        </>
      )}
    </div>
  );
}

/** A marker's time and text; a click moves the playhead there. */
function MarkLink(props: { readonly mark: { readonly t: number; readonly text: string }; onSeek?(t: number): void }) {
  const m = props.mark;
  return (
    <button type="button" class="tk-link" title={`Move the playhead to ${formatTime(m.t)}`} onClick={() => props.onSeek?.(m.t)}>
      {formatTime(m.t)} {m.text}
    </button>
  );
}

export interface MixerStripProps {
  readonly strips: readonly (BusStrip & { readonly fx?: string; readonly recorded?: boolean })[];
  /** The snapshot in force, for the link's tooltip. */
  readonly snapshot?: string | null;
  /** The runtime is up (readings are live). */
  readonly running: boolean;
  /** The playhead, seconds, when strips show the take's recorded levels there (null or absent: live readings only). */
  readonly at?: number | null;
  onOpenMixer(): void;
}

export function MixerStrip(props: MixerStripProps) {
  const at = props.at ?? null;
  if (!props.running && at === null) return <EmptyState compact title="No live mix" body="The Studio's audio runtime isn't running, so there are no bus readings." />;
  if (props.strips.length === 0) return <EmptyState compact title="No buses" body="This project's mix has no buses yet." />;
  return (
    <div class="tk-mixer">
      <div class="tk-mixer-tools">
        <InfoTip text="Each bus's authored level (the handle) and its level in the take (the tick): live while the take replays, as recorded at the playhead while it is paused. Levels are edited on the Mixer." />
        {at !== null && <span class="tk-mixer-at">Recorded at {formatTime(at)}</span>}
        <span class="tk-toolbar-gap" />
        <button type="button" class="tk-btn" title={`Open the Mixer${props.snapshot ? ` (snapshot: ${props.snapshot})` : ""}`} onClick={props.onOpenMixer}>Open Mixer</button>
      </div>
      <div class="tk-strips" role="list" aria-label="Buses">
        {props.strips.map((s) => (
          <div class="tk-strip" role="listitem" key={s.name} title={s.fx ? `${s.name}: ${s.fx}` : s.name}>
            <Fader orientation="vertical" label={`${s.name} level`} value={s.authoredDb} ghostDb={s.liveDb} ghostTitle={`${s.recorded ? "At the playhead" : "Live"}: ${s.text}`} disabled title="Levels are edited on the Mixer" onValue={() => {}}>
              <Meter orientation="vertical" label={`${s.name} meter`} peakDb={s.peakDb} />
            </Fader>
            <span class="tk-strip-name" title={s.name}>{s.name}</span>
            <span class="tk-strip-fx">{s.fx || "—"}</span>
            <span class="tk-strip-db">{s.text}</span>
          </div>
        ))}
      </div>
    </div>
  );
}
