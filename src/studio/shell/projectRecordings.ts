// The recordings open in the Studio belong to the project they came from: when the Studio opens another project (a
// hand-off from the editor, the start screen, a takes folder) or closes one, the Profiler's capture and the Take
// screen's take (with its replay) close, so nothing from the last project shows. A live view of a connected build stays
// (ADR 0408: it follows the build, not the project). Reopening the same folder (after a migration) keeps them.
import { effect } from "@preact/signals";
import type { EditorProject } from "../../editor/projects";
import { currentProject } from "../../editor/state";
import { captureFolder, profilerStore } from "../screens/profiler/profilerScreen";
import { lastBuildTake } from "../screens/take/buildTakes";
import { takeScreen } from "../screens/take/takeScreen";

/** The same project on disk: one file system and root (a sample: its name). */
const sameProject = (a: EditorProject | null, b: EditorProject | null): boolean =>
  a === b || (!!a && !!b && a.fileSystem === b.fileSystem && (a.root ?? a.name) === (b.root ?? b.name));

/** Installed once for the page; returns the stop. */
export function installProjectRecordings(): () => void {
  let last = currentProject.peek();
  return effect(() => {
    const project = currentProject.value;
    if (sameProject(project, last)) return;
    last = project;
    const profiler = profilerStore();
    const shown = profiler.state.peek();
    if (!(shown.kind === "open" && shown.origin === "live")) profiler.close();
    takeScreen().close();
    lastBuildTake.value = null;
    captureFolder.value = null;
  });
}
