// Where the connected build's takes go (ADR 0403, 0408): the take recorder belongs to the build session
// (`runtime/buildSession.ts`, ADR 0417), kept by the page rather than the Take screen, because a take the build stops (F10,
// its script) is saved whichever screen shows. The Studio decides where takes go: the open project's `recordings/`, a
// takes folder's own folder, or, in a browser with no project, a file the user chooses for each take (the save dialog,
// so it waits for Save there). `buildTakeSeams` gives the session's recorder these choices.
import { isTauri } from "../../../engine/platform/FileSystem";
import { isTakesFolder } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { saveFileAs } from "../../saveFileAs";
import { openRoute, studioRouter } from "../../shell/studioServices";
import { saveTakeIntoProject, type BuildTakeSeams, type TakeBuild } from "./recordFromBuild";

/** The screens that open a take from the route (one recording for both). */
const showsTakes = (): boolean => {
  const screen = studioRouter().route.peek().screen;
  return screen === "take" || screen === "profiler";
};

/**
 * Puts a saved take in the route of the Take screen or the Profiler, whichever shows; they open it in the background
 * (or as soon as the build disconnects, while they show it live).
 */
export function routeSavedTake(path: string): void {
  if (showsTakes() && studioRouter().route.peek().asset !== path) openRoute({ asset: path });
}

/** True where each take is saved as a file the user chooses: a browser page with no project (a takes folder in memory). */
export function asksWhereToSaveTakes(): boolean {
  if (isTauri()) return false;
  const project = currentProject.peek();
  return !project || isTakesFolder(project);
}

/** Writes a build's take where the Studio keeps takes; resolves with what the saved state names. */
async function writeTake(name: string, bytes: Uint8Array): Promise<string> {
  const project = currentProject.peek();
  if (!asksWhereToSaveTakes()) return saveTakeIntoProject(project, name, bytes);
  const file = await saveFileAs(name, bytes, { description: "Myco take", extension: ".sporesample" });
  if (file === null) throw new Error("saving was cancelled");
  // The browser's live session keeps a copy in its takes folder in memory, so the Take screen can open it.
  if (project?.canSave) return saveTakeIntoProject(project, name, bytes).catch(() => file);
  return file;
}

/** The build session's recorder seams for `build`: where its takes go, and what a save says. */
export function buildTakeSeams(build: Pick<TakeBuild, "name">): Omit<BuildTakeSeams, "pictureWidth"> {
  return {
    write: writeTake,
    autoSave: () => !asksWhereToSaveTakes(),
    saved: (path, auto) => {
      if (!currentProject.peek()?.files.includes(path)) return;
      routeSavedTake(path);
      status.value = { kind: "info", text: auto ? `Saved the take ${build.name} stopped: ${path}` : `Saved ${path}` };
    },
  };
}
