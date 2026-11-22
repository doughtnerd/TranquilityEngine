// Opening a project in the Studio (ADR 0327, 0318): the start screen's intents go through the editor's project-opening
// module, and the project opens here: read with `openFolderProject` (or a sample, read-only), its assets made the
// page's asset source (`useProjectAssets`), made the current project, remembered in the recent projects (shared with
// the editor), and the Studio's audio runtime started on its settings.
import { FsaFileSystem } from "../../editor/fsaFileSystem";
import { errorStatus } from "../../editor/messages";
import { NO_FOLDERS_NOTE, projectFileSystem } from "../../editor/projectFs";
import { projectOpening, type LocationOutcome, type OpenIntent, type OpenOutcome, type OpenResult, type ProjectSource } from "../../editor/projectOpening";
import { editorSettings, openFolderProject, useProjectAssets, type EditorProject } from "../../editor/projects";
import { recentProjects } from "../../editor/recentProjects";
import { findSample, openSampleProject } from "../../editor/samples";
import { currentProject, status } from "../../editor/state";
import type { StudioAudioRuntime } from "../runtime/studioAudioHost";
import type { StartRequest } from "./startQuery";

/** Add an opened folder project to the recent projects (a browser folder by its handle), as the editor does. */
async function remember(project: EditorProject): Promise<void> {
  const fs = project.fileSystem, root = project.root;
  if (!fs || !root) return;
  try {
    if (fs instanceof FsaFileSystem) {
      const handle = await fs.directoryHandle(root);
      await recentProjects().add({ name: project.name, path: handle.name, handle });
    } else await recentProjects().add({ name: project.name, path: root });
  } catch (err) {
    console.warn(`[studio] couldn't add ${root} to the recent projects: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export interface StudioProjects {
  open(intent: OpenIntent): Promise<OpenOutcome>;
  pickLocation(): Promise<LocationOutcome>;
  /** Open what the page's query asked for (`?sample=`, `?project=`). */
  openRequest(request: StartRequest): Promise<OpenOutcome | null>;
  close(): void;
}

export function studioProjects(runtime: StudioAudioRuntime): StudioProjects {
  async function openHere(source: ProjectSource): Promise<OpenResult> {
    const project = source.kind === "folder" ? await openFolderProject(source.fs, source.root) : await openSampleProject(source.sample);
    runtime.close();
    useProjectAssets(project);
    currentProject.value = project;
    void runtime.open(editorSettings(project));
    void remember(project);
    return { kind: "opened", name: project.name };
  }
  const opening = projectOpening({
    folders: projectFileSystem,
    recent: { check: (entry, fs) => recentProjects().check(entry, fs), handle: (id) => recentProjects().handle(id) },
    progress: (text) => (status.value = { kind: "info", text }),
    open: openHere,
  });
  const show = <T extends OpenOutcome | LocationOutcome>(outcome: T): T => {
    if (outcome.kind === "refused") status.value = outcome.reason;
    else if (outcome.kind === "opened" && outcome.note) status.value = { kind: "info", text: outcome.note };
    return outcome;
  };
  return {
    open: async (intent) => show(await opening.open(intent)),
    pickLocation: async () => show(await opening.pickLocation()),
    async openRequest(request) {
      if (!request) return null;
      try {
        if (request.kind === "sample") return show(await opening.openResolved({ kind: "sample", sample: await findSample(request.id) }));
        const fs = await projectFileSystem();
        if (!fs) return show({ kind: "refused", reason: { kind: "info", text: NO_FOLDERS_NOTE } });
        return show(await opening.openResolved({ kind: "folder", fs, root: request.root }));
      } catch (err) {
        return show({ kind: "refused", reason: errorStatus(null, err) });
      }
    },
    close() {
      runtime.close();
      currentProject.value = null;
      status.value = null;
    },
  };
}
