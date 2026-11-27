// The Samples panel's file actions (ADR 0342 "Samples are assets", ADR 0433): the Studio asset library given what is
// special about samples. A typed name keeps the file's extension (`.wav`, `.sample.json`); the open sample follows a
// move and closes on a delete; a moved sample takes its source versions (per machine) and a moved folder its colour
// (ADR 0362 item 4); deleting a sample writes its pending edit first (so Undo brings it back too), drops its decoded
// audio and its session, and the toast says how many uses are left without audio (owner decision 2: no question first,
// the project's trash, Undo on the toast). A sample's Duplicate is a derived sample, not a file copy, so it stays with
// the panel.
import { currentProject } from "../../../editor/state";
import { studioLibrary, type AssetMove } from "../../library/studioLibrary";
import { openMixDocument } from "../mixer/mixerDocument";
import { moveFolderColours } from "./folderColours";
import { nameOf, usesOf } from "./sampleLibrary";
import { forgetAudio, forgetSession, sampleSession } from "./sampleSession";
import { moveSourceVersions } from "./sampleVersions";
import { openSample, openSamplePath } from "./samplesState";

/** ADR 0362 item 4: a renamed or moved folder keeps its colour (and its subfolders theirs) in the project's settings. */
function followFolderColours(moves: readonly AssetMove[]): void {
  const doc = openMixDocument(currentProject.peek());
  if (!doc || doc.readOnly) return;
  const before = doc.value.peek();
  const next = moves.reduce((p, [from, to]) => moveFolderColours(p, from, to), before);
  if (next !== before) doc.edit(next, { label: "Folder colour" });
}

/** The Samples panel's rename, move, new folder, delete and folder delete. */
export const sampleFiles = studioLibrary({
  noun: "sample",
  extension: (path) => nameOf(path).match(/(\.sample\.json|\.[^.]+)$/i)?.[0] ?? "",
  openPaths: () => {
    const open = openSamplePath.peek();
    return open ? [open] : [];
  },
  open: (path) => openSample(path),
  follow: (_from, to) => openSample(to),
  closed: () => openSample(null),
  async afterMove(moves) {
    const project = currentProject.peek();
    if (project) await moveSourceVersions(project, moves);
    followFolderColours(moves);
  },
  async beforeDelete(path) {
    const project = currentProject.peek();
    if (!project) return;
    await sampleSession(project, path).flush();
    forgetAudio(project, path);
  },
  afterDelete(path) {
    const project = currentProject.peek();
    if (project) forgetSession(project, path);
  },
  deletedText(path) {
    const project = currentProject.peek();
    const uses = project ? usesOf(path, project.files, (p) => project.assets.get(p)) : [];
    return `Deleted ${nameOf(path)}${uses.length ? ` · ${uses.length} use${uses.length === 1 ? "" : "s"} left without audio until it's back` : ""}`;
  },
});
