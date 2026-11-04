// The Projects window's start screen (ADR 0059): it picks, creates or copies the project here, then
// hands it to the editor window to open. Nothing here loads the engine.
import type { FileSystem } from "../../engine/platform/FileSystem";
import { errorStatus } from "../messages";
import { scaffoldProject } from "../newProject";
import { NO_FOLDERS_NOTE, projectFileSystem } from "../projectFs";
import { joinPath } from "../projectPaths";
import { copySample } from "../samples";
import type { StartActions } from "../startActions";
import { status } from "../state";
import type { EditorLink, OpenRequest } from "./handoff";

/** `opened` runs once the editor window shows a project (the Projects window hides). */
export function launcherActions(link: EditorLink, opened: () => void): StartActions {
  async function folders(): Promise<FileSystem | null> {
    const fs = await projectFileSystem();
    if (!fs) status.value = { kind: "info", text: NO_FOLDERS_NOTE };
    return fs;
  }
  async function handOff(request: OpenRequest, opening: string, failed: string): Promise<void> {
    status.value = { kind: "info", text: opening };
    try {
      await link.open(request);
      status.value = null;
      opened();
    } catch (err) {
      status.value = errorStatus(failed, err);
    }
  }
  const openFolder = (root: string) => handOff({ kind: "folder", root }, `Opening ${root}…`, `Couldn't open ${root}`);

  return {
    async openProjectFolder() {
      const fs = await folders();
      if (!fs) return;
      try {
        const root = await fs.pickFolder("Open project folder");
        if (root) await openFolder(root);
      } catch (err) {
        status.value = errorStatus(null, err);
      }
    },
    async openRecentProject(entry) {
      const fs = await folders();
      if (!fs) return;
      try {
        let root: string | null = entry.path;
        let reachable = false;
        try {
          reachable = await fs.exists(joinPath(root, "project.json"));
        } catch {
          // out of the file system's scope since a restart: pick it again below
        }
        if (!reachable) root = await fs.pickFolder(`Open ${entry.name} (confirm its folder)`, entry.path);
        if (root) await openFolder(root);
      } catch (err) {
        status.value = errorStatus(`Couldn't open ${entry.name}`, err);
      }
    },
    openSample: (sample) => handOff({ kind: "sample", id: sample.id }, `Opening the ${sample.name} sample…`, `Couldn't open the ${sample.name} sample`),
    async copySampleToFolder(sample) {
      const fs = await folders();
      if (!fs) return;
      try {
        const root = await fs.pickFolder(`Choose an empty folder for your copy of ${sample.name}`);
        if (!root) return;
        status.value = { kind: "info", text: `Copying ${sample.name} to ${root}…` };
        await copySample(sample, fs, root);
        await openFolder(root);
      } catch (err) {
        status.value = errorStatus(`Couldn't copy ${sample.name}`, err);
      }
    },
    async pickProjectLocation() {
      const fs = await folders();
      if (!fs) return null;
      try {
        const path = await fs.pickFolder("Choose where the new project's folder goes");
        return path ? { fs, path } : null;
      } catch (err) {
        status.value = errorStatus("Couldn't choose a folder", err);
        return null;
      }
    },
    async createProject(fs, parent, name, template) {
      const root = joinPath(parent, name.trim());
      // Without the engine's declarations: the editor writes the scripting files when it opens the project.
      await scaffoldProject(fs, root, { name, template });
      await openFolder(root);
    },
  };
}
