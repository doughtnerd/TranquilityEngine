// The Playlist panel's view (the prototype's centre panel): the breadcrumb, the title (a shared playlist renames its
// file; an embedded one is named by its content), the type control (Clip / Queue / Switch / Blend / Layer / Sequence,
// `typeConversion.ts`), the lint lines, and the type's own view: the Queue's pick settings and entry list, the Switch
// view, the Blend view, the Layer's entries, the Clip view (sample, trim, loop, random level), and for a Sequence an
// empty state until the timeline arrives (M5). Samples dragged from the Library drop here. A view over props.
import { useState } from "preact/hooks";
import type { PlaylistLint } from "../../../engine/audio/playlist/lint";
import type { Entry, PlaylistBody, PlaylistType, SampleEntry } from "../../../engine/audio/playlist/types";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { RenameField } from "../../../editor/ui/RenameField";
import { SegmentedControl } from "../../../editor/ui/SegmentedControl";
import { BlendView } from "./BlendView";
import { EntryList, type BodyEdit, type EntryActions } from "./EntryList";
import { FieldRow, NumberBox, Section } from "./fields";
import { sampleFromDrag } from "./libraryModel";
import { setClipSampleFields, setLevels, setQueue, type EditContext } from "./playlistEdits";
import { sampleTitle, typeName, type Crumb, type PlaylistPath } from "./playlistPaths";
import type { PlaylistFacts } from "./playlistTree";
import { SwitchView } from "./SwitchView";
import { convertType, typeOptions } from "./typeConversion";
import { liveWeights } from "./blendViewModel";

export interface PlaylistEditorProps extends EntryActions {
  readonly body: PlaylistBody;
  readonly crumbs: readonly Crumb[];
  readonly title: string;
  /** A shared playlist (its file) can be renamed here; an embedded one can't. */
  readonly renamable: boolean;
  readonly writable: boolean;
  readonly ctx: EditContext;
  readonly lints: readonly PlaylistLint[];
  /** Where this body sits in its file, for matching lints (`entries[2].embedded`, "" for the file). */
  readonly where: string;
  readonly selected: number | null;
  readonly values: Readonly<Record<string, number>>;
  /** Playlist files (a Switch's transitions). */
  readonly playlists: readonly string[];
  facts(e: Entry): PlaylistFacts | null;
  onCrumb(path: PlaylistPath): void;
  onRename(name: string): void;
  onAdd(): void;
  onDropSample(path: string): void;
  onTestValue(name: string, value: number): void;
  onOpenSamples(sample: string): void;
}

const PICKS = [
  { value: "random" as const, label: "Random", title: "Independent draw each time" },
  { value: "shuffle" as const, label: "Shuffle", title: "Every entry once, then reshuffle" },
  { value: "roundRobin" as const, label: "Round robin", title: "In order, wrapping" },
];

export function PlaylistEditor(props: PlaylistEditorProps) {
  const { body, writable, onEdit } = props;
  const [renaming, setRenaming] = useState(false);
  const [dropping, setDropping] = useState(false);
  const join = (k: string) => (props.where ? `${props.where}.${k}` : k);
  const general = props.lints.filter((l) => !l.where.startsWith(join("switch.rules")));
  const canAdd = body.type !== "sequence";
  const weights = body.type === "blend" ? liveWeights(body, props.ctx.parameters, props.values, 0) : undefined;

  const entries = <EntryList {...props} body={body} weights={weights} />;
  let view;
  switch (body.type) {
    case "clip":
      view = <ClipView body={body} writable={writable} onEdit={onEdit} onReplace={props.onAdd} onOpenSamples={props.onOpenSamples} />;
      break;
    case "queue": {
      const q = body.queue!;
      view = (
        <>
          <div class="pl-queue">
            <div class="pl-kv"><span class="pl-field-label">Pick</span><SegmentedControl size="small" label="Pick" value={q.pick} options={PICKS} onChange={(v) => writable && onEdit("Change setting", (b) => setQueue(b, { pick: v }))} /></div>
            <FieldRow label="Avoid last" title="Never pick any of the last N picks again (Random)">
              <NumberBox label="Avoid last" value={q.avoidRepeat} min={0} max={5} step={1} digits={0} disabled={!writable || q.pick !== "random"} onValue={(v) => onEdit("Change setting", (b) => setQueue(b, { avoidRepeat: v }))} />
            </FieldRow>
            <FieldRow label="Continuous" title="Play entries back to back until stopped">
              <input type="checkbox" aria-label="Continuous" checked={!!q.continuous} disabled={!writable} onChange={(e) => onEdit("Change setting", (b) => setQueue(b, { continuous: (e.currentTarget as HTMLInputElement).checked ? { gapMs: 0 } : null }))} />
              {q.continuous && (
                <>
                  <span class="pl-faint">gap</span>
                  <NumberBox label="Gap between entries" value={q.continuous.gapMs} min={-10000} max={60000} step={10} digits={0} disabled={!writable} title="A negative gap overlaps entries with an equal-power crossfade" onValue={(v) => onEdit("Change setting", (b) => setQueue(b, { continuous: { gapMs: v } }))} />
                  <span class="pl-unit">ms</span>
                </>
              )}
            </FieldRow>
          </div>
          {entries}
        </>
      );
      break;
    }
    case "switch":
      view = (
        <>
          {entries}
          <SwitchView body={body} ctx={props.ctx} writable={writable} testValue={body.switch ? props.values[body.switch.parameter] : undefined} lints={props.lints} rulePrefix={join("switch.rules")} playlists={props.playlists} onEdit={onEdit} />
        </>
      );
      break;
    case "blend":
      view = (
        <>
          <BlendView body={body} ctx={props.ctx} writable={writable} values={props.values} selected={props.selected} onEdit={onEdit} onSelect={props.onSelect} onTestValue={props.onTestValue} />
          {entries}
        </>
      );
      break;
    case "layer":
      view = (
        <>
          <p class="pl-note">A Layer plays every entry at once.</p>
          {entries}
        </>
      );
      break;
    case "sequence":
      view = <EmptyState title="The Sequence view arrives with M5" icon="▤" body="A Sequence is a timeline of audio and playlist tracks. Its timeline editor comes with the musical clock; until then you can change its type, playback rules, output and effects here." />;
      break;
  }

  return (
    <div
      class={`pl-editor${dropping ? " pl-dropping" : ""}`}
      onDragOver={(e) => {
        if (!canAdd || !writable) return;
        if ([...(e.dataTransfer?.types ?? [])].includes("text/plain")) {
          e.preventDefault();
          setDropping(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDropping(false)}
      onDrop={(e) => {
        setDropping(false);
        const s = sampleFromDrag(e.dataTransfer?.getData("text/plain"));
        if (s && canAdd && writable) {
          e.preventDefault();
          props.onDropSample(s);
        }
      }}
    >
      <nav class="pl-crumbs" aria-label="Playlist path">
        {props.crumbs.map((c, i) => (
          <span key={i} class="pl-crumb">
            {i > 0 && <span class="pl-crumb-sep" aria-hidden="true">›</span>}
            {i === props.crumbs.length - 1 ? <span aria-current="page">{c.name}</span> : <button type="button" class="pl-link" onClick={() => props.onCrumb(c.path)}>{c.name}</button>}
          </span>
        ))}
      </nav>
      <div class="pl-head">
        {renaming ? (
          <RenameField value={props.title} label="Playlist name" onCommit={(v) => { setRenaming(false); if (v.trim() && v !== props.title) props.onRename(v.trim()); }} onCancel={() => setRenaming(false)} />
        ) : (
          <h2 class="pl-title" title={body.note ?? (props.renamable ? "Double-click or F2 to rename" : "An embedded playlist is named by what it plays; Make shared gives it a file and a name")}
            tabIndex={0} onDblClick={() => props.renamable && writable && setRenaming(true)} onKeyDown={(e) => e.key === "F2" && props.renamable && writable && setRenaming(true)}>
            {props.title}
          </h2>
        )}
        <SegmentedControl<PlaylistType> label="Playlist type" value={body.type} options={typeOptions(body)}
          onChange={(t) => writable && onEdit(`Mode: ${typeName(t)}`, (b) => convertType(b, t, props.ctx))} />
        {canAdd && (
          <button type="button" class="pl-primary pl-add-btn" disabled={!writable} onClick={props.onAdd}>
            {body.type === "clip" ? (body.entries.length ? "Replace sample…" : "Choose sample…") : "Add…"}
          </button>
        )}
      </div>
      {general.length > 0 && (
        <ul class="pl-lints" aria-label="Warnings">
          {general.map((l, i) => <li key={i} class="pl-lint">⚠ {l.message}</li>)}
        </ul>
      )}
      <div class="pl-view">{view}</div>
    </div>
  );
}

/** A Clip's sample, trim, loop and random level per trigger. */
export function ClipView(props: { readonly body: PlaylistBody; readonly writable: boolean; onEdit(label: string, edit: BodyEdit, drag?: boolean): void; onReplace(): void; onOpenSamples(sample: string): void }) {
  const { body, writable, onEdit } = props;
  const s = body.entries[0] as SampleEntry | undefined;
  if (!s) return <EmptyState compact title="No sample yet" body="A Clip plays one sample." action={{ label: "Choose sample…", disabled: !writable, run: props.onReplace }} />;
  const trim = s.trim;
  return (
    <div class="pl-clip">
      <Section title="Sample">
        <div class="pl-kv">
          <span class="pl-field-label">Plays</span>
          <span class="pl-inline">
            <strong title={s.sample}>{sampleTitle(s.sample)}</strong>
            <button type="button" class="pl-link" onClick={() => props.onOpenSamples(s.sample)} title="Edit its loops, markers and trim in Samples">Open in Samples ›</button>
          </span>
        </div>
        {body.entries.length > 1 && <p class="pl-note">A Clip plays its first sample; the {body.entries.length - 1} after it are kept but not played.</p>}
        <FieldRow label="Trim" title="Seconds in the sample; off: the sample's own trim">
          <input type="checkbox" aria-label="Trim this clip" checked={!!trim} disabled={!writable} onChange={(e) => onEdit("Change setting", (b) => setClipSampleFields(b, { trim: (e.currentTarget as HTMLInputElement).checked ? [0, 1] : null }))} />
          {trim ? (
            <>
              <NumberBox label="Trim start" value={trim[0]} min={0} step={0.01} digits={3} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setClipSampleFields(b, { trim: [v, trim[1]] }))} />
              <span class="pl-faint">to</span>
              <NumberBox label="Trim end" value={trim[1]} min={0.02} step={0.01} digits={3} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setClipSampleFields(b, { trim: [trim[0], v] }))} />
              <span class="pl-unit">s</span>
            </>
          ) : (
            <span class="pl-faint">From the sample</span>
          )}
        </FieldRow>
        <div class="pl-kv">
          <span class="pl-field-label">Loop</span>
          <SegmentedControl<SampleEntry["loop"]> size="small" label="Loop" value={s.loop} onChange={(v) => writable && onEdit("Change setting", (b) => setClipSampleFields(b, { loop: v }))}
            options={[{ value: "inherit", label: "From sample", title: "The sample's own loops (edit them in Samples)" }, { value: "off", label: "Off" }, { value: "on", label: "On", title: "Loop the trimmed region" }]} />
        </div>
      </Section>
      <Section title="Level" note="Random variation is drawn again on every trigger, between the two values.">
        <FieldRow label="Volume" unit="dB"><NumberBox label="Clip volume" value={body.volume} min={-96} max={24} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setLevels(b, { volume: v }))} /></FieldRow>
        <FieldRow label="Pitch" unit="st"><NumberBox label="Clip pitch" value={body.pitch} min={-48} max={48} step={1} digits={2} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setLevels(b, { pitch: v }))} /></FieldRow>
        <FieldRow label="Random volume" unit="dB">
          <NumberBox label="Random volume, low" value={body.volumeRandom[0]} min={-48} max={48} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setLevels(b, { volumeRandom: [v, body.volumeRandom[1]] }))} />
          <span class="pl-faint">to</span>
          <NumberBox label="Random volume, high" value={body.volumeRandom[1]} min={-48} max={48} step={0.5} digits={1} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setLevels(b, { volumeRandom: [body.volumeRandom[0], v] }))} />
        </FieldRow>
        <FieldRow label="Random pitch" unit="st">
          <NumberBox label="Random pitch, low" value={body.pitchRandom[0]} min={-24} max={24} step={0.5} digits={2} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setLevels(b, { pitchRandom: [v, body.pitchRandom[1]] }))} />
          <span class="pl-faint">to</span>
          <NumberBox label="Random pitch, high" value={body.pitchRandom[1]} min={-24} max={24} step={0.5} digits={2} disabled={!writable} onValue={(v) => onEdit("Change setting", (b) => setLevels(b, { pitchRandom: [body.pitchRandom[0], v] }))} />
        </FieldRow>
      </Section>
    </div>
  );
}
