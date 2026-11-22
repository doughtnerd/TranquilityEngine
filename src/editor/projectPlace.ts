// Where the editor keeps what it writes for a project (ADR 0316): the project's own folder when it can be written
// (edit histories in `.myco/`, saved layouts in `.layouts/`), and the editor's per-user storage otherwise and for
// what belongs to the user (ADR 0317's editor scope). Edit histories and saved layouts ask here, so both follow one
// rule for which file system writes a project's folder.
import { getFileSystem, type FileSystem } from "../engine/platform/FileSystem";
import type { StorageBackend } from "../engine/platform/Storage";
import { openStorage } from "../engine/platform/storageScope";
import type { EditorProject } from "./projects";

/** The editor's platform: the file system for folders (null where it can't write), and its per-user storage. */
export interface EditorPlatform {
  fs: FileSystem | null;
  userStorage: StorageBackend;
}

let platform: Promise<EditorPlatform> | null = null;

/** The real platform: the FileSystem when it can write (Tauri), and the editor's own storage scope. */
export function editorPlatform(): Promise<EditorPlatform> {
  return (platform ??= (async () => {
    const fs = await getFileSystem();
    return { fs: fs.canWrite ? fs : null, userStorage: await openStorage({ kind: "editor" }) };
  })());
}

/** A project's folder as the editor reads and writes it. */
export interface ProjectFolder {
  readonly root: string;
  /** Reads files in the folder: the project's own file system (a browser folder, ADR 0038), else the platform's. */
  readonly read: FileSystem | null;
  /** Writes them, or null when the project is read-only or nothing can write its folder. */
  readonly write: FileSystem | null;
}

/** `project`'s folder, or null for a project without one (a bundled sample). */
export function projectFolder(project: EditorProject, p: EditorPlatform): ProjectFolder | null {
  if (!project.root) return null;
  // The project's own file system first: a browser folder isn't the platform's.
  const write = project.canSave ? (project.fileSystem?.canWrite ? project.fileSystem : p.fs) : null;
  return { root: project.root, read: project.fileSystem ?? p.fs, write };
}

/** The key that names `project` in per-user storage. */
export const projectKey = (project: EditorProject) => project.root ?? `bundled:${project.name}`;

/**
 * The project's own saves and settings (ADR 0317), shared by the editor's Engine and Play: what a game stores while it
 * is edited or played (a calibration, a graphics tier, a save) is the same store either way, apart from other
 * projects' and the editor's own data.
 */
export function projectStorage(project: EditorProject): Promise<StorageBackend> {
  return openStorage({ kind: "project", id: projectKey(project), name: project.name });
}
