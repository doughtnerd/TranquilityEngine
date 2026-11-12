// The Event editor panel (ADR 0158 §7): edits an `*.audioevent.json` through its asset document (undo, redo, the
// History panel, writes after a slider's pause, changes made elsewhere). The container tree and the parameters on the
// left, the selected node's properties (or the event's own) on the right, and Audition (E6.4) under the parameters
// with the sliders' values.
import { useEffect, useMemo, useState } from "preact/hooks";
import { editor, openAssetDocument } from "../../../../editor/sdk";
import type { AudioEventAsset, EventNode } from "../../../../engine/audio/eventFormat";
import type { MusicNode } from "../../../../engine/audio/musicFormat";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { Audition } from "./Audition";
import { activeAudition, stingerAuditionFor } from "./auditionHost";
import { auditionValues } from "./eventParameters";
import { getMusicNode, getNode, musicIdProblem, parentPath, pathKey, renameMusicId, setMusicNode, setNode, type NodePath, type SustainSlot } from "./EventTree";
import { EventTree } from "./EventTree";
import { EventProperties, MusicNodeProperties, NodeProperties, type FieldContext } from "./NodeProperties";
import { openRulesTable, openSegmentView } from "../music";
import { ParametersPane } from "./ParametersPane";
import { openEvent } from "./openEventEditor";
import "./eventEditor.css";

export function EventEditorPanel() {
  const path = openEvent.value;
  const project = editor.project.current;
  editor.project.version; // the file list changes with it
  if (!project || !path) return <p class="empty">Double-click an audio event (.audioevent.json) in the Assets panel, or create one with New Event.</p>;
  if (!project.files.includes(path)) return <p class="empty">{path} isn't in the project any more.</p>;
  return <EventEditor key={path} path={path} />;
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
  const selected = picked && (music ? getMusicNode(music, picked) : getNode(event.root, picked)) ? picked : null;
  const [audition, setAudition] = useState<Record<string, number | string>>({});
  const values = auditionValues(event.parameters, audition);
  const [voices, setVoices] = useState(0);

  const audioSettings = useMemo(() => parseAudioSettings((project.settings as { audio?: unknown }).audio).settings, [project.settings]);
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
  const musicNode = selected && music ? getMusicNode(music, selected) : undefined;
  const parent = selected ? parentPath(selected) : null;
  const parentNode = parent && !music ? getNode(event.root, parent) ?? null : null;
  const musicParent = parent && music ? getMusicNode(music, parent) ?? null : null;
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
            onAudition={(name, value) => setAudition((a) => ({ ...a, [name]: value }))}
            readOnly={readOnly}
          />
          <section class="ev-audition" aria-label="Audition" data-testid="event-audition">
            <Audition path={doc.path} parameters={values} onVoices={setVoices} />
            {voices > 0 && <span class="ev-voices">{voices} voice{voices === 1 ? "" : "s"}</span>}
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
              onChange={(next, drag, label) => change({ ...event, musicRoot: setMusicNode(music, selected!, next) }, drag, label ? `Edit ${label.toLowerCase()}` : undefined)}
              onRename={(id) => !musicIdProblem(music, selected!, id) && change({ ...event, musicRoot: renameMusicId(music, selected!, id) }, false, "Rename node")}
              onOpenSegment={(id) => openSegmentView(path, id)}
              onOpenRules={(id) => openRulesTable(path, id)}
              audition={stingerAuditionFor(path, activeAudition.value)}
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

