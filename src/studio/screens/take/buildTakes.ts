// The Studio's recorder of the connected build's takes (ADR 0403, 0408): one `BuildTakeRecorder` per chosen build,
// kept by the page rather than the Take screen, because a take the build stops (F10, its script) is saved whichever
// screen shows. The Studio decides where takes go: the open project's `recordings/`, a takes folder's own folder, or, in a
// browser with no project, a file the user chooses for each take (the save dialog, so it waits for Save there).
import { effect, signal } from "@preact/signals";
import { isTauri } from "../../../engine/platform/FileSystem";
import { isTakesFolder } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { studioBuild } from "../../debugLink/studioLink";
import { takePictureWidth, takePictureWidthOf } from "../../runtime/takePictures";
import { saveFileAs } from "../../saveFileAs";
import { openRoute, studioRouter } from "../../shell/studioServices";
import { BuildTakeRecorder, saveTakeIntoProject } from "./recordFromBuild";

/** The recorder of the connected build's takes; a build that left keeps it while it shows a failure. */
export const buildTake = signal<BuildTakeRecorder | null>(null);

/** The game link as the player bar's badge shows it: linked, ended (after a build was linked), or never made. */
export const gameLink = signal<"linked" | "disconnected" | "none">("none");

/** When the running recording started (`Date.now()`), for Record session's clock; null while none records. */
export const recordingSince = signal<number | null>(null);

/**
 * The take the connected build last saved into the project, while the Take screen and the Profiler still show the build
 * live (ADR 0408): it opens on them once the build disconnects, so the recording just made stays on screen.
 */
export const lastBuildTake = signal<string | null>(null);

/** The screens that open a take from the route (one recording for both). */
const showsTakes = (): boolean => {
  const screen = studioRouter().route.peek().screen;
  return screen === "take" || screen === "profiler";
};

/**
 * Puts the saved take in the route of the Take screen or the Profiler, whichever shows; they open it in the background
 * (or as soon as the build disconnects, while they show it live).
 */
function routeSavedTake(path: string): void {
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

/** Follows `studioBuild` with a recorder per build that watches the build's take. Returns the stop. */
export function installBuildTakes(): () => void {
  const stop = effect(() => {
    const build = studioBuild.value;
    if (build) gameLink.value = "linked";
    else if (gameLink.peek() === "linked") {
      gameLink.value = "disconnected";
      // The live view ends: the take just recorded stays open, now from its saved file.
      const saved = lastBuildTake.peek();
      if (saved && currentProject.peek()?.files.includes(saved)) routeSavedTake(saved);
    }
    const current = buildTake.peek();
    if (current && current.build.peer === build?.peer) return;
    if (current && current.build.peer.state === "closed") current.linkClosed(current.build.peer.closedReason);
    const keep = !build && current?.state.peek().kind === "failed";
    if (!keep) current?.dispose();
    const next = build
      ? new BuildTakeRecorder(build, {
          write: writeTake,
          autoSave: () => !asksWhereToSaveTakes(),
          pictureWidth: () => takePictureWidthOf(takePictureWidth.peek()),
          saved: (path, auto) => {
            if (!currentProject.peek()?.files.includes(path)) return;
            lastBuildTake.value = path;
            routeSavedTake(path);
            status.value = { kind: "info", text: auto ? `Saved the take ${build.name} stopped: ${path}` : `Saved ${path}` };
          },
        })
      : keep
        ? current
        : null;
    next?.watch();
    buildTake.value = next;
  });
  return () => {
    stop();
    buildTake.peek()?.dispose();
  };
}
