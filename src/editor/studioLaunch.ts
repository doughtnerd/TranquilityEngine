// Opening the Audio Studio from the editor (ADR 0341): Window > Audio Studio, and Open in Audio Studio on the files
// the Studio opens (studioAssets.ts). On the desktop it asks Rust for the `studio` window (`create_studio_window`
// creates it, or shows and focuses the open one) and hands it the project and asset over Tauri events
// (studioHandoff.ts); in the browser it opens the Studio page in its own tab, the request in the URL.
import { isTauri } from "../engine/platform/FileSystem";
import type { AssetMenuItem, AssetTarget } from "./assetActions";
import { entryPath, fileEntries, isFolderEntry, isSliceEntry } from "./assetEntry";
import { errorStatus } from "./messages";
import type { EditorProject } from "./projects";
import { currentProject, status } from "./state";
import { studioScreenFor, studioUrl, type StudioOpenRequest, type StudioScreen } from "./studioAssets";

/** The browser tab the Studio opens in: one, reused by later opens. */
const BROWSER_TARGET = "myco-audio-studio";

/** Why `entries` can't be opened in the Studio, or null when they can: one file the Studio opens, in a project folder. */
export function whyNotOpenInStudio(project: EditorProject, entries: readonly string[]): string | null {
  const files = fileEntries(entries);
  if (files.length !== 1 || entries.length !== 1) return "open one file at a time";
  const file = files[0];
  if (isFolderEntry(file) || isSliceEntry(file) || studioScreenFor(entryPath(file)) === null) return "the Audio Studio doesn't open this kind of file";
  if (project.root === null) return "the Audio Studio opens project folders; open this project's folder first";
  return null;
}

/** The request opening the Studio on `project` (its folder, or the sample it is; null: the Studio's start screen), on `asset` or a `screen`. */
export function studioRequest(project: EditorProject | null, target: { asset?: string; screen?: StudioScreen } = {}): StudioOpenRequest {
  const sample = project && project.root === null ? project.sample : null;
  return { project: project?.root ?? null, ...(sample ? { sample } : {}), ...(target.asset !== undefined ? { asset: target.asset } : {}), ...(target.screen ? { screen: target.screen } : {}) };
}

/** Open the Studio on `request`: its desktop window, or a browser tab. Failures go to the status bar. */
export async function openAudioStudio(request: StudioOpenRequest): Promise<void> {
  try {
    if (isTauri()) await (await import("./launcher/studioWindow")).openInStudioWindow(request);
    else openStudioTab(request);
  } catch (err) {
    status.value = errorStatus("Couldn't open the Audio Studio", err);
  }
}

/** The Studio on the open project (Window > Audio Studio). */
export const openAudioStudioOnProject = (): Promise<void> => openAudioStudio(studioRequest(currentProject.peek()));

function openStudioTab(request: StudioOpenRequest): void {
  const url = new URL(studioUrl(request), location.href).href;
  const tab = window.open(url, BROWSER_TARGET);
  if (!tab) throw new Error("the browser blocked the new tab; allow pop-ups for the editor");
  tab.focus();
}

/** The Assets panel's Open in Audio Studio item for `target`, when its selection is one file the Studio opens. */
export function studioAssetItems(target: AssetTarget): AssetMenuItem[] {
  const files = fileEntries(target.entries);
  if (files.length !== 1 || isFolderEntry(files[0]) || studioScreenFor(entryPath(files[0])) === null) return [];
  const asset = entryPath(files[0]);
  return [{ label: "Open in Audio Studio", whyNot: whyNotOpenInStudio(target.project, target.entries), run: () => void openAudioStudio(studioRequest(target.project, { asset })) }];
}
