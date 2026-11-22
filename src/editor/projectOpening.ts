// Opening a project from the start screen (ADR 0318): one module turns what the user asked for (pick a folder, a
// recent entry, a sample, a copy of one, a new project) into an outcome: opened, cancelled, or refused with a reason
// worded once for both windows. Its seam is the last step: the editor window opens the project there (session.ts),
// the desktop Projects window hands it to the editor window (launcher/actions.ts). Resolving a recent entry (its
// folder probed, picked again where it can't be reached, a browser folder asked for access) and choosing a folder
// live here only. Nothing here loads the engine, so the Projects window can use it.
import type { FileSystem } from "../engine/platform/FileSystem";
import { FsaFileSystem, ensureWritable } from "./fsaFileSystem";
import { errorStatus } from "./messages";
import { scaffoldProject, type ProjectTemplate } from "./newProject";
import { NO_FOLDERS_NOTE } from "./projectFs";
import { joinPath } from "./projectPaths";
import type { RecentProject, RecentProjects } from "./recentProjectList";
import { copySample, type SampleInfo } from "./samples";
import type { Status } from "./state";

/** What the user asked the start screen (or the File menu) to open. */
export type OpenIntent =
  /** Choose a project folder in the folder dialog. */
  | { readonly kind: "pick-folder" }
  /** A recent project: its folder path (desktop) or stored folder handle (a Chromium browser). */
  | { readonly kind: "recent"; readonly entry: RecentProject }
  /** A sample, read-only, from the files served beside the editor (ADR 0031). */
  | { readonly kind: "sample"; readonly sample: SampleInfo }
  /** A copy of a sample in a folder the user chooses. */
  | { readonly kind: "copy-sample"; readonly sample: SampleInfo }
  /** A new project in folder `name` inside `parent` (ADR 0038). */
  | { readonly kind: "new"; readonly fs: FileSystem; readonly parent: string; readonly name: string; readonly template: ProjectTemplate };

/** Where the project an intent resolved to is: a folder, or a sample. */
export type ProjectSource = { readonly kind: "folder"; readonly fs: FileSystem; readonly root: string } | { readonly kind: "sample"; readonly sample: SampleInfo };

/**
 * What came of an intent. `opened`: `note` says so in the status line, null when opening already reported a problem
 * there (a main scene or scripts that didn't load), which a note mustn't hide. `refused`: why, as a status line.
 */
export type OpenOutcome =
  | { readonly kind: "opened"; readonly note: string | null }
  | { readonly kind: "cancelled" }
  | { readonly kind: "refused"; readonly reason: Status };

/**
 * What the window's last step reports: the project is open (`name` where the window knows it, the editor window
 * does and a hand-off doesn't; `problem` when opening already put one in the status line), or the window that was
 * to open it refused, in its own words. A step that throws is refused in this module's words.
 */
export type OpenResult =
  | { readonly kind: "opened"; readonly name?: string; readonly problem?: boolean }
  | { readonly kind: "refused"; readonly reason: Status };

/** A folder chosen for a new project, or why not. */
export type LocationOutcome = { readonly kind: "chosen"; readonly fs: FileSystem; readonly path: string } | { readonly kind: "cancelled" } | { readonly kind: "refused"; readonly reason: Status };

export interface OpeningSeams {
  /** The folder file system (desktop, or a Chromium browser), or null where folders can't be opened. */
  folders(): Promise<FileSystem | null>;
  /** The recent projects list: how a recent entry is checked, and a browser entry's stored folder handle. */
  readonly recent: Pick<RecentProjects, "check" | "handle">;
  /** Open `source` here, or hand it to the window that will. */
  open(source: ProjectSource): Promise<OpenResult>;
  /** What is happening, while it happens ("Copying Flappy to …"). */
  progress(text: string): void;
  /** Asked once the intent can go ahead, before any dialog (the editor: unsaved changes); false cancels. */
  confirm?(): Promise<boolean>;
  /** The engine's declarations a new project's scripting files are written with, where they are at hand. */
  declarations?(): Promise<Readonly<Record<string, string>> | undefined>;
}

const CANCELLED: OpenOutcome = { kind: "cancelled" };
const refused = (reason: Status) => ({ kind: "refused", reason }) as const;
const info = (text: string): Status => ({ kind: "info", text });

/** The project opener for one window: `open` an intent, or choose where a new project goes. */
export interface ProjectOpening {
  open(intent: OpenIntent): Promise<OpenOutcome>;
  /** Open a project another window already resolved (the Projects window's hand-off), without asking anything. */
  openResolved(source: ProjectSource): Promise<OpenOutcome>;
  pickLocation(): Promise<LocationOutcome>;
}

export function projectOpening(seams: OpeningSeams): ProjectOpening {
  const confirmed = async () => (seams.confirm ? seams.confirm() : true);

  /** Open `source`; `failed` words a refusal, `done` the note given the project's name. */
  async function openSource(source: ProjectSource, failed: string | null, done: (name: string) => string): Promise<OpenOutcome> {
    try {
      const opened = await seams.open(source);
      if (opened.kind === "refused") return opened;
      return { kind: "opened", note: opened.problem ? null : done(opened.name ?? (source.kind === "folder" ? source.root : source.sample.name)) };
    } catch (err) {
      return refused(errorStatus(failed, err));
    }
  }
  const openFolder = (fs: FileSystem, root: string, opening: string, failed: string | null, done: (name: string) => string = (name) => `Opened ${name}`) => {
    seams.progress(opening);
    return openSource({ kind: "folder", fs, root }, failed, done);
  };

  /** The folder file system once the intent may go ahead, or the outcome that stops it here. */
  async function folders(): Promise<{ fs: FileSystem } | OpenOutcome> {
    const fs = await seams.folders();
    if (!fs) return refused(info(NO_FOLDERS_NOTE));
    return (await confirmed()) ? { fs } : CANCELLED;
  }

  /** Pick a folder, or the outcome that stops here (cancelled, or the dialog failing with `failed`). */
  async function pick(fs: FileSystem, title: string, failed: string | null, start?: string): Promise<string | OpenOutcome> {
    try {
      return (await fs.pickFolder(title, start)) ?? CANCELLED;
    } catch (err) {
      return refused(errorStatus(failed, err));
    }
  }

  const openSample = (sample: SampleInfo) => {
    seams.progress(`Opening the ${sample.name} sample…`);
    return openSource({ kind: "sample", sample }, `Couldn't open the ${sample.name} sample`, () => `Opened the ${sample.name} sample (read-only). Make a copy to edit it.`);
  };

  async function openRecent(fs: FileSystem, entry: RecentProject): Promise<OpenOutcome> {
    const failed = `Couldn't open ${entry.name}`;
    if (entry.kind === "handle") {
      // A browser folder asks for access again (it lapses when the tab closes).
      const handle = await seams.recent.handle(entry.id);
      if (!handle || !(fs instanceof FsaFileSystem)) return refused(errorStatus(failed, new Error(`The editor no longer has access to ${entry.name}. Open its folder again with Open Project….`)));
      try {
        if (!(await ensureWritable(handle))) return refused(info(`${entry.name} wasn't opened: the browser wasn't given access to its folder.`));
        return await openFolder(fs, await fs.mount(handle), `Opening ${entry.name}…`, failed);
      } catch (err) {
        return refused(errorStatus(failed, err));
      }
    }
    // A desktop folder the editor can't reach any more (folder access lasts a session), or that lost its project, is
    // picked again in the folder dialog, starting there.
    let root = entry.path;
    if ((await seams.recent.check(entry, fs)) !== "ok") {
      const picked = await pick(fs, `Open ${entry.name} (confirm its folder)`, failed, entry.path);
      if (typeof picked !== "string") return picked;
      root = picked;
    }
    return openFolder(fs, root, `Opening ${root}…`, failed);
  }

  return {
    async open(intent) {
      switch (intent.kind) {
        case "sample":
          return (await confirmed()) ? openSample(intent.sample) : CANCELLED;
        case "new": {
          const name = intent.name.trim();
          if (!(await confirmed())) return CANCELLED;
          const root = joinPath(intent.parent, name);
          seams.progress(`Creating ${name}…`);
          try {
            // Without the declarations the editor writes the scripting files when it opens the project.
            await scaffoldProject(intent.fs, root, { name: intent.name, template: intent.template, declarations: await seams.declarations?.() });
          } catch (err) {
            return refused(errorStatus(`Couldn't create ${name}`, err));
          }
          return openFolder(intent.fs, root, `Opening ${name}…`, `Couldn't open ${name}`, () => `Created ${name} in ${root}.`);
        }
        case "pick-folder": {
          const got = await folders();
          if (!("fs" in got)) return got;
          const { fs } = got;
          const root = await pick(fs, "Open project folder", null);
          return typeof root === "string" ? openFolder(fs, root, `Opening ${root}…`, `Couldn't open ${root}`) : root;
        }
        case "recent": {
          const got = await folders();
          return "fs" in got ? openRecent(got.fs, intent.entry) : got;
        }
        case "copy-sample": {
          const { sample } = intent;
          const got = await folders();
          if (!("fs" in got)) return got;
          const { fs } = got;
          const root = await pick(fs, `Choose an empty folder for your copy of ${sample.name}`, `Couldn't copy ${sample.name}`);
          if (typeof root !== "string") return root;
          seams.progress(`Copying ${sample.name} to ${root}…`);
          try {
            await copySample(sample, fs, root);
          } catch (err) {
            return refused(errorStatus(`Couldn't copy ${sample.name}`, err));
          }
          return openFolder(fs, root, `Opening ${root}…`, `Couldn't open ${root}`, () => `Copied ${sample.name} to ${root}.`);
        }
      }
    },

    openResolved: (source) => (source.kind === "sample" ? openSample(source.sample) : openFolder(source.fs, source.root, `Opening ${source.root}…`, `Couldn't open ${source.root}`)),

    async pickLocation() {
      const fs = await seams.folders();
      if (!fs) return refused(info(NO_FOLDERS_NOTE));
      try {
        const path = await fs.pickFolder("Choose where the new project's folder goes");
        return path ? { kind: "chosen", fs, path } : { kind: "cancelled" };
      } catch (err) {
        return refused(errorStatus("Couldn't choose a folder", err));
      }
    },
  };
}
