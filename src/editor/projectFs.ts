// Where project folders come from (ADR 0038): the desktop editor's Tauri file system, or in a
// Chromium browser the File System Access API. Safari and Firefox can only open samples, read-only.
import { getFileSystem, isTauri, type FileSystem } from "../engine/platform/FileSystem";
import { FsaFileSystem, fsaSupported } from "./fsaFileSystem";

let fsa: FsaFileSystem | null = null;

/** The browser's folder file system (one per tab: it holds the folders opened in it). */
export function browserFolders(): FsaFileSystem {
  return (fsa ??= new FsaFileSystem());
}

/** True when this editor can open, create and save project folders. */
export function canOpenFolders(): boolean {
  return isTauri() || fsaSupported();
}

/** The file system project folders are opened with, or null where folders can't be opened (Safari, Firefox). */
export async function projectFileSystem(): Promise<FileSystem | null> {
  if (isTauri()) return getFileSystem();
  if (fsaSupported()) return browserFolders();
  return null;
}

/** Why folders can't be opened here, for the start screen and status bar. */
export const NO_FOLDERS_NOTE =
  "This browser can't open project folders, so samples open read-only. Use the desktop editor (npm run tauri:dev) or a Chromium browser (Chrome, Edge) to create, open and save projects.";
