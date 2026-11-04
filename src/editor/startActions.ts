// What the start screen's buttons do (ADR 0059). In the editor window they open the project there
// (session.ts); the desktop editor's Projects window picks the project and hands it to the editor
// window instead (launcher/). The start screen calls these rather than session.ts, so the Projects
// window opens without loading the editor or the engine.
import type { FileSystem } from "../engine/platform/FileSystem";
import type { ProjectTemplate } from "./newProject";
import type { RecentProject } from "./recentProjects";
import type { SampleInfo } from "./samples";

export interface StartActions {
  openProjectFolder(): Promise<void>;
  openRecentProject(entry: RecentProject): Promise<void>;
  openSample(sample: SampleInfo): Promise<void>;
  copySampleToFolder(sample: SampleInfo): Promise<void>;
  /** The folder a new project goes in (it gets its own folder inside), or null if cancelled. */
  pickProjectLocation(): Promise<{ fs: FileSystem; path: string } | null>;
  /** Create a project in a new folder `name` inside `parent` and open it. Throws if it can't be created. */
  createProject(fs: FileSystem, parent: string, name: string, template: ProjectTemplate): Promise<void>;
}

let actions: StartActions | null = null;

/** Set by each page's entry point before it renders. */
export function setStartActions(value: StartActions): void {
  actions = value;
}

export function startActions(): StartActions {
  if (!actions) throw new Error("The start screen's actions weren't set.");
  return actions;
}
