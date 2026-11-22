// Opening a project in the Studio (ADR 0327, 0318): the start screen's intents go through the editor's project-opening
// module, and the project opens here: read with `openFolderProject` (or a sample, read-only), its assets made the
// page's asset source (`useProjectAssets`), made the current project, remembered in the recent projects (shared with
// the editor), shared with other apps (the Studio's lock and the folder watch, studioProjectWatch.ts) and the Studio's
// audio runtime started on its settings. The editor's hand-off (`myco://studio-open`, studioHandoff.ts) and the
// page's `?project=` come through `openRequest` and `handOff`; a browser folder is found among the recent projects'
// stored handles (`recentForMount`).
import { FsaFileSystem } from "../../editor/fsaFileSystem";
import { errorStatus } from "../../editor/messages";
import { NO_FOLDERS_NOTE, projectFileSystem } from "../../editor/projectFs";
import { projectOpening, type LocationOutcome, type OpenIntent, type OpenOutcome, type OpenResult, type ProjectSource } from "../../editor/projectOpening";
import { editorSettings, openFolderProject, useProjectAssets } from "../../editor/projects";
import { recentProjects, rememberProject } from "../../editor/recentProjects";
import { findSample, openSampleProject } from "../../editor/samples";
import { currentProject, status } from "../../editor/state";
import { requestScreen, type StudioOpenRequest } from "../../editor/studioAssets";
import type { StudioAudioRuntime } from "../runtime/studioAudioHost";
import type { RouteRequest } from "../shell/route";
import { recentForMount, type StartRequest } from "./startQuery";
import { startStudioProjectWatch, stopStudioProjectWatch } from "./studioProjectWatch";

export interface StudioProjects {
  open(intent: OpenIntent): Promise<OpenOutcome>;
  pickLocation(): Promise<LocationOutcome>;
  /** Open what the page's query asked for (`?sample=`, `?project=`). */
  openRequest(request: StartRequest): Promise<OpenOutcome | null>;
  /**
   * Open what the editor handed over (`myco://studio-open`): its project (the open one stays open), then its screen and
   * asset. A null project shows the start screen. Throws, in the Studio's words, when the project couldn't be opened.
   */
  handOff(request: StudioOpenRequest): Promise<void>;
  close(): void;
}

/** Where the Studio's projects go: its audio runtime, and its router (for a hand-off's screen and asset). */
export interface StudioProjectHost {
  readonly runtime: StudioAudioRuntime;
  openRoute(request: RouteRequest): void;
}

export function studioProjects({ runtime, openRoute }: StudioProjectHost): StudioProjects {
  async function openHere(source: ProjectSource): Promise<OpenResult> {
    const project = source.kind === "folder" ? await openFolderProject(source.fs, source.root) : await openSampleProject(source.sample);
    runtime.close();
    useProjectAssets(project);
    currentProject.value = project;
    void runtime.open(editorSettings(project));
    void rememberProject(project, "studio");
    void startStudioProjectWatch(project);
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

  /** Open the project folder at `root`: by path on the desktop; in a browser, the recent folder the editor's tab mounted there. */
  async function openFolder(root: string): Promise<OpenOutcome> {
    const fs = await projectFileSystem();
    if (!fs) return { kind: "refused", reason: { kind: "info", text: NO_FOLDERS_NOTE } };
    if (!(fs instanceof FsaFileSystem)) return opening.openResolved({ kind: "folder", fs, root });
    const entry = recentForMount(recentProjects().list(), root);
    if (!entry) return { kind: "refused", reason: { kind: "info", text: `This tab can't reach ${root.replace(/^\//, "")} by itself: open its folder with Open Project… (the editor adds the folders it opens to the recent projects).` } };
    return opening.open({ kind: "recent", entry });
  }

  function close(): void {
    runtime.close();
    void stopStudioProjectWatch();
    currentProject.value = null;
    status.value = null;
  }

  return {
    open: async (intent) => show(await opening.open(intent)),
    pickLocation: async () => show(await opening.pickLocation()),
    async openRequest(request) {
      if (!request) return null;
      try {
        if (request.kind === "sample") return show(await opening.openResolved({ kind: "sample", sample: await findSample(request.id) }));
        return show(await openFolder(request.root));
      } catch (err) {
        return show({ kind: "refused", reason: errorStatus(null, err) });
      }
    },
    async handOff(request) {
      if (request.project === null) {
        if (currentProject.peek()) close();
      } else if (currentProject.peek()?.root !== request.project) {
        const outcome = show(await openFolder(request.project));
        if (outcome.kind === "refused") throw new Error(outcome.reason.text);
        if (outcome.kind === "cancelled") throw new Error(`Opening ${request.project} was cancelled.`);
      }
      const screen = requestScreen(request);
      if (screen) openRoute({ screen, ...(request.asset !== undefined ? { asset: request.asset } : {}) });
    },
    close,
  };
}
