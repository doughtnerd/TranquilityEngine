// The Event editor panel (ADR 0158 §7): edits an `*.audioevent.json` through its asset document (undo, redo, the
// History panel, writes after a slider's pause, changes made elsewhere). The container tree and the parameters on the
// left, the selected node's properties (or the event's own) on the right, and Audition (E6.4) under the parameters
// with the sliders' values.
import { useComputed } from "@preact/signals";
import { useEffect, useMemo, useState } from "preact/hooks";
import { editor, openAssetDocument, Panel } from "../../../../editor/sdk";
import type { AudioEventAsset, EventNode } from "../../../../engine/audio/eventFormat";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import { audioSection } from "../../../../engine/audio/audioSection";
import { Audition } from "./Audition";
import { editorAudition } from "../audition/editorAudition";
import { auditionValues } from "./eventParameters";
import { getNode, musicIdProblem, parentPath, pathKey, renameMusicId, setNode, type NodePath, type SustainSlot } from "./eventTreeModel";
import { musicNodeAt, replaceMusicNodeAt } from "../../../../engine/audio/musicTree";
import { EventTree } from "./EventTree";
import { EventProperties, MusicNodeProperties, NodeProperties, type FieldContext } from "./NodeProperties";
import { openRulesTable, openSegmentView } from "../music";
import { ParametersPane } from "./ParametersPane";
import { EVENT_EDITOR_PANEL } from "./openEventEditor";
import "./eventEditor.css";

export function EventEditorPanel() {
  const path = editor.assets.openIn(EVENT_EDITOR_PANEL);
  const project = editor.project.current;
  editor.project.version; // the file list changes with it
  if (!project || !path) return <Panel><p class="empty">Double-click an audio event (.audioevent.json) in the Assets panel, or create one with New Event.</p></Panel>;
  if (!project.files.includes(path)) return <Panel><p class="empty">{path} isn't in the project any more.</p></Panel>;
  return <Panel><EventEditor key={path} path={path} /></Panel>;
}

function EventEditor({ path }: { path: string }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<AudioEventAsset>(project, path, "audioEvent");
  const readOnly = doc.readOnly;
  const event = doc.value.value;
  const problems = doc.problems.value;
  useEffect(() => () => void doc.flush(), [doc]); // write a pending slider change when the panel closes

  /** The selected node (null: the event row). A path that no longer leads anywhere (after an undo, say) falls back to the event. */
  const [picked, setPicked] = useState<NodePath | null>([]);
  // A music event's tree is its `musicRoot` (D6): `root` is then the empty layer, and every edit goes to `musicRoot`.
  const music = event.musicRoot;
  const selected = picked && (music ? musicNodeAt(music, picked) : getNode(event.root, picked)) ? picked : null;
  const values = auditionValues(event.parameters, editorAudition.overrides.value[path] ?? {});
  // The stinger buttons' target changes only when this event starts or stops playing (a stable object), so the panel
  // doesn't re-render on every audition tick.
  const stingerTarget = useComputed(() => editorAudition.stingerTarget(path));

  const audioSettings = audioSection((project.settings as { audio?: unknown }).audio).settings;
  const clips = useMemo(() => editor.assets.listed(project.files).filter((f) => editor.assets.kindOf(f) === "audio"), [project.files]);
  const context: FieldContext = {
    clips,
    buses: audioSettings.buses.map((b) => b.name),
    local: event.parameters,
    global: audioSettings.parameters,
    readOnly,
  };

  /** `drag`: a slider or curve drag, whose quick changes in a row make one undo step and one write. */
  const change = (next: AudioEventAsset, drag = false, label = "Edit event") => doc.edit(next, drag ? { coalesce: true, label } : { label });
  const changeRoot = (root: EventNode, select: NodePath | null, label: string) => {
    change({ ...event, root }, false, label);
    setPicked(select);
  };

  const changeMusicRoot = (musicRoot: MusicNode, select: NodePath | null, label: string) => {
    change({ ...event, musicRoot }, false, label);
    setPicked(select);
  };

  const node = selected && !music ? getNode(event.root, selected) : undefined;
  const musicNode = selected && music ? musicNodeAt(music, selected) : undefined;
  const parent = selected ? parentPath(selected) : null;
  const parentNode = parent && !music ? getNode(event.root, parent) ?? null : null;
  const musicParent = parent && music ? musicNodeAt(music, parent) ?? null : null;
  const last = selected?.[selected.length - 1];
  const slot = typeof last === "string" ? (last as SustainSlot) : undefined;

  return (
    <div
      class="event-editor"
      aria-label="Audio Event"
      data-testid="event-editor"
      data-asset-document={doc.path} // focused, Undo / Redo (Ctrl+Z…, the Edit menu) act on the event's document (ADR 0145)
    >
      <div class="event-editor-head">
        <span class="asset-inspector-kind">Audio Event</span>
        <span class="asset-inspector-name" title={path}>{editor.assets.fileName(path)}</span>
        <span class="event-editor-actions">
          <button onClick={() => doc.undo()} disabled={readOnly || !doc.canUndo.value} title={doc.undoLabel.value ? `Undo ${doc.undoLabel.value} (Ctrl+Z)` : "Undo (Ctrl+Z)"}>Undo</button>
          <button onClick={() => doc.redo()} disabled={readOnly || !doc.canRedo.value} title={doc.redoLabel.value ? `Redo ${doc.redoLabel.value} (Ctrl+Shift+Z)` : "Redo (Ctrl+Shift+Z)"}>Redo</button>
        </span>
        {readOnly && <span class="event-editor-note">{project.name} is read-only: changes aren't saved.</span>}
      </div>
      {problems.length > 0 && (
        <ul class="asset-inspector-problems event-editor-problems" aria-label="Problems">
          {problems.map((p, i) => <li key={i}>{p.message}</li>)}
        </ul>
      )}
      <div class="event-editor-body">
        <div class="event-editor-left">
          <EventTree
            root={event.root}
            selected={selected}
            onSelect={setPicked}
            onEdit={changeRoot}
            music={music ? { root: music, onEdit: changeMusicRoot, onOpenSegment: (id) => openSegmentView(path, id), onOpenRules: (id) => openRulesTable(path, id) } : undefined}
            onProblem={(text) => editor.messages.info(text)}
            readOnly={readOnly}
          />
          <ParametersPane
            event={event}
            onChange={change}
            values={values}
            onAudition={(name, value) => editorAudition.setParameter(path, name, value)}
            readOnly={readOnly}
          />
          <section class="ev-audition" aria-label="Audition" data-testid="event-audition">
            <Audition audition={editorAudition} path={doc.path} parameters={values} />
          </section>
        </div>
        <div class="event-editor-right" data-testid="event-properties">
          {musicNode && music ? (
            <MusicNodeProperties
              key={`${pathKey(selected!)}:${musicNode.id}`}
              root={music}
              node={musicNode}
              path={selected!}
              parent={musicParent}
              context={context}
              onChange={(next, drag, label) => change({ ...event, musicRoot: replaceMusicNodeAt(music, selected!, next) }, drag, label ? `Edit ${label.toLowerCase()}` : undefined)}
              onRename={(id) => !musicIdProblem(music, selected!, id) && change({ ...event, musicRoot: renameMusicId(music, selected!, id) }, false, "Rename node")}
              onOpenSegment={(id) => openSegmentView(path, id)}
              onOpenRules={(id) => openRulesTable(path, id)}
              audition={stingerTarget.value}
            />
          ) : node ? (
            <NodeProperties
              key={pathKey(selected!)}
              node={node}
              parent={parentNode}
              slot={slot}
              context={context}
              onChange={(next, drag, label) => change({ ...event, root: setNode(event.root, selected!, next) }, drag, label ? `Edit ${label.toLowerCase()}` : undefined)}
            />
          ) : (
            <EventProperties event={event} context={context} onChange={(next, drag, label) => change(next, drag, label ? `Edit ${label.toLowerCase()}` : undefined)} />
          )}
        </div>
      </div>
    </div>
  );
}

