// The Sequence view and Inspector wired to the Playlists screen (ADR 0343): the open file and path, the project's
// samples (`sequenceSources.ts`), linked playlists, buses and parameters, edits through the screen's `editOpen` path
// (one labelled undo step on the playlist's document each), refusals as toasts. `PlaylistEditor`'s Sequence case and
// the Inspector panel render these.
import type { ComponentChildren } from "preact";
import type { PlaylistLint } from "../../../../engine/audio/playlist/lint";
import type { PlaylistBody } from "../../../../engine/audio/playlist/types";
import { openRoute, toasts } from "../../../shell/studioServices";
import type { Crumb, PlaylistPath } from "../playlistPaths";
import { allParameters, busNames, loadPlaylist, setTestValue, target, testValues } from "../playlistsScreen";
import { newPlaylistParameter } from "../newParameter";
import { SequenceInspector } from "./SequenceInspector";
import type { BodyEdit } from "./sequenceModel";
import { SequenceParameters } from "./SequenceParameters";
import { projectPcm, projectPeaks, projectSources } from "./sequenceSources";
import { SequenceView } from "./SequenceView";

const notify = (text: string) => void toasts.show({ text, kind: text.startsWith("Can't") ? "error" : "info" });

export interface SequencePanelProps {
  readonly body: PlaylistBody;
  readonly writable: boolean;
  readonly lints: readonly PlaylistLint[];
  readonly where: string;
  readonly crumbs: readonly Crumb[];
  onEdit(label: string, edit: BodyEdit): void;
  onCrumb(path: PlaylistPath): void;
}

/** The timeline in the Playlist panel. */
export function SequencePanel(props: SequencePanelProps) {
  const t = target.value;
  const crumbs = props.crumbs;
  const parent = crumbs.length > 1 ? crumbs[crumbs.length - 2]! : null;
  return (
    <SequenceView
      body={props.body}
      writable={props.writable}
      file={t?.file ?? null}
      embedded={!!t && t.indices.length > 0}
      stateKey={t ? `${t.file}#${t.indices.join(".")}` : ""}
      title={crumbs[crumbs.length - 1]?.name ?? "Sequence"}
      where={props.where}
      lints={props.lints}
      sourceOf={projectSources()}
      peaksOf={projectPeaks}
      pcmOf={projectPcm}
      loadPlaylist={loadPlaylist}
      parameters={allParameters.value}
      parameterValues={testValues.value}
      onNewParameter={newPlaylistParameter}
      buses={busNames.value}
      back={parent ? { name: parent.name, open: () => props.onCrumb(parent.path) } : undefined}
      onOpenSample={(sample) => openRoute({ screen: "samples", asset: sample })}
      onOpenPlaylist={(path) => openRoute({ screen: "playlists", asset: path })}
      onEdit={props.onEdit}
      onNotify={notify}
    />
  );
}

/** The Parameters panel while a sequence is open: the parameters it uses, their test values, and Held. */
export function SequenceParametersPanel(props: { readonly body: PlaylistBody; readonly writable: boolean }) {
  return (
    <SequenceParameters
      seq={props.body.sequence!}
      sourceOf={projectSources()}
      parameters={allParameters.value}
      values={testValues.value}
      onValue={(name, v) => setTestValue(name, v)}
      onNewParameter={props.writable ? () => void newPlaylistParameter() : undefined}
    />
  );
}

export interface SequenceInspectorPanelProps {
  readonly body: PlaylistBody;
  readonly writable: boolean;
  readonly lints: readonly PlaylistLint[];
  readonly where: string;
  readonly title: string;
  onEdit(label: string, edit: BodyEdit): void;
  /** The playlist's own Inspector (playback rules, output, effects), under the Sequence section. */
  readonly children?: ComponentChildren;
}

/** The Inspector while a sequence is open. */
export function SequenceInspectorPanel(props: SequenceInspectorPanelProps) {
  return (
    <SequenceInspector
      body={props.body}
      writable={props.writable}
      title={props.title}
      where={props.where}
      lints={props.lints}
      sourceOf={projectSources()}
      buses={busNames.value}
      parameters={allParameters.value}
      onNewParameter={newPlaylistParameter}
      onEdit={props.onEdit}
      onNotify={notify}
      onOpenSamples={(sample) => openRoute({ screen: "samples", asset: sample })}
    >
      {props.children}
    </SequenceInspector>
  );
}

