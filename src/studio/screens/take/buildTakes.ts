// The Studio's recorder of the connected build's takes (ADR 0403, 0408): one `BuildTakeRecorder` per chosen build,
// kept by the page rather than the Take screen, because a take the build stops (F10, its script) is saved whichever
// screen shows. The Studio decides where takes go: the open project's `takes/`, a takes folder's own folder, or, in a
// browser with no project, a file the user chooses for each take (the save dialog, so it waits for Save there).
import { effect, signal } from "@preact/signals";
import { isTauri } from "../../../engine/platform/FileSystem";
import { isTakesFolder } from "../../../editor/projects";
import { currentProject, status } from "../../../editor/state";
import { studioBuild } from "../../debugLink/studioLink";
import { saveFileAs } from "../../saveFileAs";
import { BuildTakeRecorder, saveTakeIntoProject } from "./recordFromBuild";
import { openTake } from "./takeScreen";

/** The recorder of the connected build's takes; a build that left keeps it while it shows a failure. */
export const buildTake = signal<BuildTakeRecorder | null>(null);

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
  const file = await saveFileAs(name, bytes, { description: "Myco take", extension: ".mycotake" });
  if (file === null) throw new Error("saving was cancelled");
  // The browser's live session keeps a copy in its takes folder in memory, so the Take screen can open it.
  if (project?.canSave) return saveTakeIntoProject(project, name, bytes).catch(() => file);
  return file;
}

/** Follows `studioBuild` with a recorder per build that watches the build's take. Returns the stop. */
export function installBuildTakes(): () => void {
  const stop = effect(() => {
    const build = studioBuild.value;
    const current = buildTake.peek();
    if (current && current.build.peer === build?.peer) return;
    if (current && current.build.peer.state === "closed") current.linkClosed(current.build.peer.closedReason);
    const keep = !build && current?.state.peek().kind === "failed";
    if (!keep) current?.dispose();
    const next = build
      ? new BuildTakeRecorder(build, {
          write: writeTake,
          autoSave: () => !asksWhereToSaveTakes(),
          saved: (path, auto) => {
            if (!currentProject.peek()?.files.includes(path)) return;
            if (auto) status.value = { kind: "info", text: `Saved the take ${build.name} stopped: ${path}` };
            else openTake(path);
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
