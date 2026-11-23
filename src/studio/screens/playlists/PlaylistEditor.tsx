// The Playlist panel's view (the prototype's centre panel): the breadcrumb (only when nested deeper than one level),
// the header row (the name, renamed by double-click or F2 when the playlist is a file, the link mark, the type pill,
// Undo / Redo / History of the playlist, Add, "N entries"), "Used in …", the type row (`ModeToolbar.tsx`: the six type
// icons and the type's own settings), the lint lines, and the type's own view: a Queue's or Layer's entry list, the
// Switch view, the Blend view, the Clip editor, the Sequence view. Samples dragged from the Library drop here. A view
// over props.
import type { PlaylistLint } from "../../../engine/audio/playlist/lint";
import type { Entry, PlaylistBody } from "../../../engine/audio/playlist/types";
import { HistoryPopover } from "../../../editor/ui/HistoryPopover";
import { RenameField } from "../../../editor/ui/RenameField";
import { useState } from "preact/hooks";
import type { TimeFormat } from "../../components/timeRulerModel";
import { Icon } from "../../components/Icon";
import { playlistBadge } from "../../components/typeBadgeModel";
import { BlendView } from "./BlendView";
import { ClipEditor, type ClipSource } from "./ClipEditor";
import { EntryList, type EntryActions } from "./EntryList";
import { Glyph, LINK_GLYPH } from "./glyphs";
import { sampleFromDrag } from "./libraryModel";
import { ModeToolbar } from "./ModeToolbar";
import type { EditContext } from "./playlistEdits";
import type { Crumb, PlaylistPath } from "./playlistPaths";
import type { PlaylistFacts } from "./playlistTree";
import { contentCount } from "./liveModel";
import { SwitchView } from "./SwitchView";
import { SequencePanel } from "./sequence/SequencePanel";
import { warningLines } from "./sequence/sequenceLints";

export interface PlaylistEditorProps extends EntryActions {
  readonly body: PlaylistBody;
  readonly crumbs: readonly Crumb[];
  readonly title: string;
  /** A shared playlist (its file) can be renamed here; an embedded one can't. */
  readonly renamable: boolean;
  /** The name is being edited (a new playlist opens so), and its change. */
  readonly renaming?: boolean;
  onRenaming?(on: boolean): void;
  /** It is linked (a file other playlists link), and from where. */
  readonly linkedIn?: readonly string[];
  /** Playlists that use it ("Used in Bike crash, Explosion"). */
  readonly usedIn?: readonly string[];
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
  bodyOf?(e: Entry): PlaylistBody | null;
  lengthOf?(sample: string): number | null;
  /** Live level per entry, 0..1 (what the audition plays now). */
  readonly levels?: readonly number[];
  /** The Switch rule that fired at the last label change (-1: the default), null for none. */
  readonly fired?: number | null;
  /** The open Clip's sample, for its lanes. */
  readonly clipSource?: ClipSource | null;
  readonly timeFormat?: TimeFormat;
  onTimeFormat?(f: TimeFormat): void;
  /** The open playlist is embedded in its parent (Make shared). */
  readonly embedded?: boolean;
  onMakeSharedOpen?(): void;
  onCrumb(path: PlaylistPath): void;
  onRename(name: string): void;
  onAdd(): void;
  onDropSample(path: string): void;
  onTestValue(name: string, value: number): void;
  onOpenSamples(sample: string): void;
  /** ADR 0350: open a Blend entry's weight curve in the curve editor. */
  onEditWeightCurve?(index: number): void;
}

/** The type pill's words ("Blend 1D", "Queue"). */
function typePill(b: PlaylistBody): string {
  if (b.type === "blend") return `Blend ${b.blend?.axes.length === 2 ? "2D" : "1D"}`;
  return b.type.charAt(0).toUpperCase() + b.type.slice(1);
}

export function PlaylistEditor(props: PlaylistEditorProps) {
  const { body, writable, onEdit } = props;
  const [ownRenaming, setOwnRenaming] = useState(false);
  const renaming = props.renaming ?? ownRenaming;
  const setRenaming = (on: boolean) => (props.onRenaming ? props.onRenaming(on) : setOwnRenaming(on));
  const [dropping, setDropping] = useState(false);
  const join = (k: string) => (props.where ? `${props.where}.${k}` : k);
  const general = warningLines(props.lints.filter((l) => !l.where.startsWith(join("switch.rules"))), body);
  const canAdd = body.type !== "sequence";
  const badge = playlistBadge(body.type, body.blend?.axes.length === 2 ? 2 : 1);
  const n = body.entries.length;
  const addTitle = body.type === "clip" ? (n ? "Replace the sample" : "Choose a sample") : "Add entries: a sample becomes a new clip; a playlist is linked or copied";

  const entries = <EntryList {...props} body={body} weights={props.levels} />;
  let view;
  switch (body.type) {
    case "clip":
      view = (
        <ClipEditor body={body} writable={writable} source={props.clipSource ?? null} format={props.timeFormat ?? "timecode"} onFormat={(f) => props.onTimeFormat?.(f)} embedded={!!props.embedded}
          onEdit={onEdit} onReplace={props.onAdd} onOpenSamples={props.onOpenSamples} onEditCurves={props.onEditCurves} onMakeShared={props.onMakeSharedOpen} />
      );
      break;
    case "queue":
    case "layer":
      view = entries;
      break;
    case "switch":
      view = <SwitchView {...props} weights={props.levels} testValue={body.switch ? props.values[body.switch.parameter] : undefined} rulePrefix={join("switch.rules")} />;
      break;
    case "blend":
      view = (
        <>
          <BlendView body={body} ctx={props.ctx} writable={writable} values={props.values} selected={props.selected} onEdit={onEdit} onSelect={props.onSelect} onOpen={props.onOpen} onTestValue={props.onTestValue} onEditWeightCurve={props.onEditWeightCurve} />
          {entries}
        </>
      );
      break;
    case "sequence":
      view = <SequencePanel body={body} writable={writable} lints={props.lints} where={props.where} crumbs={props.crumbs} onEdit={(label, edit) => onEdit(label, edit)} onCrumb={props.onCrumb} />;
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
      {props.crumbs.length > 1 && (
        <nav class="pl-crumbs" aria-label="Playlist path">
          {props.crumbs.map((c, i) => (
            <span key={i} class="pl-crumb">
              {i > 0 && <span class="pl-crumb-sep" aria-hidden="true">›</span>}
              {i === props.crumbs.length - 1 ? <span aria-current="page">{c.name}</span> : <button type="button" class="pl-link" onClick={() => props.onCrumb(c.path)}>{c.name}</button>}
            </span>
          ))}
        </nav>
      )}
      <div class="pl-tb" role="toolbar" aria-label="Playlist">
        {renaming && props.renamable ? (
          <RenameField value={props.title} label="Playlist name" onCommit={(v) => { setRenaming(false); if (v.trim() && v !== props.title) props.onRename(v.trim()); }} onCancel={() => setRenaming(false)} />
        ) : (
          <b class="pl-pname" role="heading" aria-level={2} title={body.note ?? (props.renamable ? "Double-click or F2 to rename" : "An embedded playlist is named by what it plays; Make shared gives it a file and a name")}
            tabIndex={0} onDblClick={() => props.renamable && writable && setRenaming(true)} onKeyDown={(e) => e.key === "F2" && props.renamable && writable && (e.preventDefault(), setRenaming(true))}>
            {props.title}
          </b>
        )}
        {props.linkedIn && props.linkedIn.length > 0 && (
          <span class="pl-lnk" title={`Original (solid): linked in ${props.linkedIn.join(", ")}`}><Glyph paths={LINK_GLYPH} size={12} width={1.4} /></span>
        )}
        <span class={`pl-mbw studio-tone-${badge.tone}`} title="Playlist type">{typePill(body)}</span>
        <span class="pl-vs" />
        <HistoryPopover none="Click into the playlist to undo its edits" />
        <span class="pl-flex" />
        {canAdd && (
          <button type="button" class="pl-ib" aria-haspopup="dialog" aria-label={body.type === "clip" ? (n ? "Replace sample…" : "Choose sample…") : "Add…"} title={addTitle} disabled={!writable} onClick={props.onAdd}>
            <Icon name="plus" size={13} />
          </button>
        )}
        <span class="pl-vs" />
        <span class="pl-u">{contentCount(body)}</span>
      </div>
      {props.usedIn && props.usedIn.length > 0 && <div class="pl-used-in">Used in {props.usedIn.join(", ")}</div>}
      <ModeToolbar body={body} ctx={props.ctx} writable={writable} playlists={props.playlists} onEdit={onEdit} />
      {general.length > 0 && (
        <ul class="pl-lints" aria-label="Warnings">
          {general.map((text, i) => <li key={i} class="pl-lint"><Icon name="warning" size={14} /> {text}</li>)}
        </ul>
      )}
      <div class="pl-view">{view}</div>
    </div>
  );
}
