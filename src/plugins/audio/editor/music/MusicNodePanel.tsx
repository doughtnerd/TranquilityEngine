// The one shell of the music panels (ADR 0313): the node a panel shows (`openSegment` or `openRules`), the messages for
// no project, a file that's gone and a node the event doesn't have, the event's asset document (flushed when the panel
// closes) and the node's handle (`musicNodeHandle.ts`), handed to the panel's view.
import type { ComponentChildren } from "preact";
import { useEffect, useMemo } from "preact/hooks";
import { editor, openAssetDocument, Panel } from "../../../../editor/sdk";
import type { AudioEventAsset } from "../../../../engine/audio/eventFormat";
import { musicNodeHandle, type MusicNodeHandle, type MusicNodeKind } from "./musicNodeHandle";
import type { MusicContainerNode, SegmentNode } from "../../../../engine/audio/musicFormat";
import { peaksFor } from "./peaksHost";

type NodeOf<K extends MusicNodeKind> = K extends "segment" ? SegmentNode : MusicContainerNode;

export interface MusicNodePanelProps<K extends MusicNodeKind> {
  /** The open node: its event's path and its id, or null when none is open. */
  readonly open: { readonly event: string; readonly id: string } | null;
  readonly kind: K;
  /** What the panel says when nothing is open. */
  readonly idle: string;
  /** The view, given the handle and its node. */
  readonly view: (handle: MusicNodeHandle<NodeOf<K>>, node: NodeOf<K>) => ComponentChildren;
}

export function MusicNodePanel<K extends MusicNodeKind>(props: MusicNodePanelProps<K>) {
  const { open } = props;
  const project = editor.project.current;
  editor.project.version; // the file list changes with it
  if (!project || !open) return <Panel><p class="empty">{props.idle}</p></Panel>;
  if (!project.files.includes(open.event)) return <Panel><p class="empty">{open.event} isn't in the project any more.</p></Panel>;
  return (
    <Panel>
      <OpenNode key={`${open.event}#${open.id}`} event={open.event} id={open.id} kind={props.kind} view={props.view} />
    </Panel>
  );
}

function OpenNode<K extends MusicNodeKind>(props: { event: string; id: string; kind: K; view: MusicNodePanelProps<K>["view"] }) {
  const project = editor.project.current!;
  const doc = openAssetDocument<AudioEventAsset>(project, props.event, "audioEvent");
  const handle = useMemo(() => musicNodeHandle(doc, peaksFor(project), props.kind, props.id), [doc, project, props.kind, props.id]);
  useEffect(() => () => void handle.flush(), [handle]);
  const node = handle.node;
  if (!node) return <p class="empty">{props.event} has no {props.kind === "segment" ? "segment" : "playlist or music switch"} “{props.id}”.</p>;
  return <>{props.view(handle, node)}</>;
}
