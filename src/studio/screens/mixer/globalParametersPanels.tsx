// The Global parameters panel as a screen panel: over the Mixer's session on the Mixer (`index.tsx`), or over
// `audio.json`'s document on any other screen (the Playlists screen's catalog). A rename reaches the playlists and
// events naming the parameter through the editor's project file module, as a bus rename does.
import { audioProject } from "../../shell/audioProject";
import type { PanelDock } from "../../../editor/sdk/contributions";
import { editProjectFiles } from "../../../editor/projectFileEdits";
import { status } from "../../../editor/state";
import { EmptyState } from "../../../editor/ui/EmptyState";
import { Panel } from "../../../editor/ui/panel/Panel";
import { AUDIO_PROJECT_FILE } from "../../../engine/audio/project/types";
import type { StudioPanel } from "../../shell/studioPanels";
import { parameterRenameEdit } from "./globalParameters";
import { documentParametersHost } from "./globalParametersHost";
import { GlobalParametersPanel } from "./GlobalParametersPanel";
import { openMixDocument } from "./mixerDocument";
import "./mixer.css";

/** Rename global parameter `from` to `to` in the open project's playlists and events (`audio.json` has its own edit). */
export function renameParameterOutside(from: string, to: string): void {
  const project = audioProject.peek();
  if (!project) return;
  void editProjectFiles(project, parameterRenameEdit(from, to), `Rename parameter ${from} to ${to}`).then((changed) => {
    if (changed.length > 0) status.value = { kind: "info", text: `Renamed ${from} to ${to} in ${changed.length} file${changed.length === 1 ? "" : "s"}.` };
  });
}

export interface GlobalParametersPanelOptions {
  readonly id: string;
  readonly dock: PanelDock;
  readonly onDemand?: boolean;
  /** After a rename: the screen's own follow-up (its test values). */
  renamed?(from: string, to: string): void;
}

/** The panel over `audio.json`'s document, for a screen other than the Mixer. */
export function globalParametersPanel(o: GlobalParametersPanelOptions): StudioPanel {
  return {
    id: o.id,
    title: "Global parameters",
    dock: o.dock,
    onDemand: o.onDemand,
    view: () => {
      const doc = openMixDocument(audioProject.value);
      return (
        <Panel bodyClass="mx-panel-body">
          {doc ? (
            <GlobalParametersPanel host={documentParametersHost(doc, AUDIO_PROJECT_FILE, (from, to) => { o.renamed?.(from, to); renameParameterOutside(from, to); })} />
          ) : (
            <EmptyState compact title="No project open" body="Open a project to edit the game's global parameters." />
          )}
        </Panel>
      );
    },
  };
}
