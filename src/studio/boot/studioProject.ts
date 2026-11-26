// Opening a project in the Studio (ADR 0341, 0318): the start screen's intents go through the editor's project-opening
// module, and the project opens here: read with `openFolderProject` (or a sample, read-only), its assets made the
// page's asset source (`useProjectAssets`), made the current project, remembered in the recent projects (shared with
// the editor), shared with other apps (the Studio's lock and the folder watch, studioProjectWatch.ts) and the Studio's
// audio runtime started on its settings. The editor's hand-off (`myco://studio-open`, studioHandoff.ts) and the
// page's `?project=` come through `openRequest` and `handOff`; a browser folder is found among the recent projects'
// stored handles (`recentForMount`). A folder with old audio events (`*.audioevent.json`) is offered their migration
// first (ADR 0343, `audioEventMigration.ts`); declined, it opens read-only and the Playlists screen's banner offers
// Migrate now (`pendingAudioMigration`), which migrates and opens it again. A folder of takes opens without a project as a
// takes workspace (ADR 0408, `openTakes`).
import { FsaFileSystem } from "../../editor/fsaFileSystem";
import { errorStatus } from "../../editor/messages";
import { migrationSummary, offerAudioEventMigration, runAudioEventMigration, type AudioEventMigrationQuestion } from "../../editor/audioEventMigration";
import type { FileSystem } from "../../engine/platform/FileSystem";
import { confirmInEditor } from "../../editor/ui/ConfirmDialog";
import { NO_FOLDERS_NOTE, projectFileSystem } from "../../editor/projectFs";
import { projectOpening, type LocationOutcome, type OpenIntent, type OpenOutcome, type OpenResult, type ProjectSource } from "../../editor/projectOpening";
import { editorSettings, openFolderProject, openTakesFolder, useProjectAssets } from "../../editor/projects";
import { recentProjects, rememberProject } from "../../editor/recentProjects";
import { applyProjectAudioEffects, clearProjectAudioEffects } from "../../plugins/projectAudioEffects";
import { findSample, openSampleProject } from "../../editor/samples";
import { currentProject, status } from "../../editor/state";
import { requestScreen, type StudioOpenRequest } from "../../editor/studioAssets";
import type { StudioAudioRuntime } from "../runtime/studioAudioHost";
import type { RouteRequest } from "../shell/route";
import { pendingAudioMigration } from "../shell/audioMigration";
import { recentForMount, type StartRequest } from "./startQuery";
import { startStudioProjectWatch, stopStudioProjectWatch } from "./studioProjectWatch";

export interface StudioProjects {
  open(intent: OpenIntent): Promise<OpenOutcome>;
  pickLocation(): Promise<LocationOutcome>;
  /**
   * ADR 0408: open the folder of takes at `root` as a takes workspace (Take and Profiler, no project); a no-op when it
   * is the open one. Not remembered among the recent projects. Throws when the folder can't be read. `fs` names another
   * file system (a browser's live session keeps its takes folder in memory); the desktop's folders by default.
   */
  openTakes(root: string, fs?: FileSystem): Promise<void>;
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
  /** Ask the migration question (the editor's confirm dialog when left out). */
  confirm?(question: AudioEventMigrationQuestion): Promise<boolean>;
}

export function studioProjects({ runtime, openRoute, confirm = (q) => confirmInEditor(q).then((r) => r.ok) }: StudioProjectHost): StudioProjects {
  async function openHere(source: ProjectSource): Promise<OpenResult> {
    const migration = source.kind === "folder" ? await offerAudioEventMigration(source.fs, source.root, confirm) : null;
    const readOnly = migration?.kind === "declined" || migration?.kind === "failed";
    const project = source.kind === "folder" ? await openFolderProject(source.fs, source.root, { readOnly }) : await openSampleProject(source.sample);
    pendingAudioMigration.value = readOnly && source.kind === "folder" ? pending(source.fs, source.root, migration.files, migration.kind === "failed" ? migration.error : null) : null;
    if (migration?.kind === "migrated") status.value = { kind: "info", text: migrationSummary(migration.report) };
    runtime.close();
    useProjectAssets(project);
    currentProject.value = project;
    void runtime.open(editorSettings(project));
    // ADR 0352 §8: the project's plugin audio effects (catalogue, the core's chains, offline renders).
    void applyProjectAudioEffects(project);
    void rememberProject(project, "studio");
    if (!readOnly) void startStudioProjectWatch(project);
    // What the migration did stays in the status line (the opened note doesn't replace it).
    return { kind: "opened", name: project.name, problem: migration?.kind === "migrated" };
  }

  /** The banner's state for the read-only project at `root`: Migrate now migrates it and opens it again, writable. */
  function pending(fs: FileSystem, root: string, files: readonly string[], error: string | null) {
    const state = {
      files,
      running: false,
      error,
      async migrate(): Promise<void> {
        pendingAudioMigration.value = { ...state, running: true, error: null };
        const outcome = await runAudioEventMigration(fs, root);
        if (outcome.kind === "failed") {
          pendingAudioMigration.value = { ...state, running: false, error: outcome.error };
          return;
        }
        show(await opening.openResolved({ kind: "folder", fs, root }));
        if (outcome.kind === "migrated" && currentProject.peek()?.canSave) status.value = { kind: "info", text: migrationSummary(outcome.report) };
      },
    };
    return state;
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

  async function openTakes(root: string, given?: FileSystem): Promise<void> {
    const fs = given ?? (await projectFileSystem());
    if (!fs || (!given && fs instanceof FsaFileSystem)) throw new Error("A folder of takes opens in the desktop app.");
    if (currentProject.peek()?.root === root && currentProject.peek()?.fileSystem === fs) return;
    const project = await openTakesFolder(fs, root);
    if (currentProject.peek()) close();
    useProjectAssets(project);
    currentProject.value = project;
    void runtime.open(editorSettings(project));
  }

  function close(): void {
    pendingAudioMigration.value = null;
    runtime.close();
    void stopStudioProjectWatch();
    void clearProjectAudioEffects();
    currentProject.value = null;
    status.value = null;
  }

  return {
    open: async (intent) => show(await opening.open(intent)),
    pickLocation: async () => show(await opening.pickLocation()),
    openTakes,
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
      if (request.project === null && request.takesFolder) {
        await openTakes(request.takesFolder);
      } else if (request.project === null && request.sample) {
        // The editor has a sample open (ADR 0380): open the same sample here, read-only.
        const current = currentProject.peek();
        if (!(current && current.root === null && current.sample === request.sample)) {
          const outcome = show(await opening.openResolved({ kind: "sample", sample: await findSample(request.sample) }));
          if (outcome.kind === "refused") throw new Error(outcome.reason.text);
          if (outcome.kind === "cancelled") throw new Error(`Opening the ${request.sample} sample was cancelled.`);
        }
      } else if (request.project === null) {
        // A connect request (the launcher's Connect to Game…) keeps the open project: the dialog opens over it.
        if (currentProject.peek() && !request.connect) close();
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
