// Live mixer moves are steps of `audio.json`'s history (ADR 0330 "Live mixing", ADR 0327 "the engine's undo tree"): the
// Mixer session over the real `audio.json` document (the editor's asset document, its persistent history tree), with
// the Studio's runtime running. A fader drag is one undo step however many moves it makes; undo and redo of it reach the
// running mixer at once, named `undo` and `redo` for a capture's MIXOP records (D22); the drag's own moves are `editor`.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AssetDocument } from "../../../editor/assetDocuments";
import { MemoryFileSystem } from "../../../editor/memoryFs";
import { joinPath, openFolderProject, useProjectAssets, type EditorProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { ROOT, useCoreAssetKinds } from "../../../editor/testing";
import { audioProjectText } from "../../../editor/audioProjectFile";
import type { ApplyResult, MixOp } from "../../../engine/audio/mixOps";
import { AUDIO_PROJECT_FILE, type AudioProject } from "../../../engine/audio/project/types";
import { currentMixOpOrigin } from "../../../plugins/audio/runtime/capture/mixOpOrigin";
import { levelLabel, setLevel } from "./mixEdits";
import { mixerFixture } from "./mixerFixture";
import { openMixDocument } from "./mixerDocument";
import { createMixerSession, type MixerSession } from "./mixerScreen";

useCoreAssetKinds();

let project: EditorProject;
let doc: AssetDocument<AudioProject>;
let session: MixerSession;
let applied: { op: MixOp; origin: string }[];

beforeEach(async () => {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  fs.files.set(joinPath(ROOT, AUDIO_PROJECT_FILE), audioProjectText(mixerFixture()));
  project = await openFolderProject(fs, ROOT);
  useProjectAssets(project);
  currentProject.value = project;
  doc = openMixDocument(project)!;
  applied = [];
  session = createMixerSession({
    doc,
    path: AUDIO_PROJECT_FILE,
    confirm: async () => true,
    toast: () => {},
    report: () => {},
    // The running runtime: what reaches `mixer.apply`, with the origin a capture would label it with.
    live: { running: () => true, apply: (op): ApplyResult => (applied.push({ op, origin: currentMixOpOrigin() }), { ok: true, class: "smoothed" }) },
  });
});
afterEach(async () => {
  session.dispose();
  await doc.flush();
  currentProject.value = null;
});

const musicDb = () => session.project.peek().buses.find((b) => b.name === "Music")!.volumeDb;
/** One fader move: a drag's moves coalesce into one step of the history. */
const drag = (db: number) => session.commit(setLevel(session.project.peek(), "Music", db, null), levelLabel(session.project.peek(), "Music", null), true);
const volumes = () => applied.filter((a) => a.op.op === "setBus" && a.op.bus === "Music");

describe("live mixer moves in the document's history", () => {
  it("a fader drag is one undo step: each move is heard live, undo brings the level back live and redo again", async () => {
    const steps = doc.history.states.length;
    const start = musicDb();
    for (const db of [-11, -12, -13, -14]) drag(db);
    await doc.flush(); // the drag ends (the burst becomes its step)
    expect(doc.history.states.length).toBe(steps + 1);
    expect(doc.undoLabel.peek()).toBe(levelLabel(session.project.peek(), "Music", null));
    expect(volumes().map((a) => a.origin)).toEqual(["editor", "editor", "editor", "editor"]);
    expect(volumes().at(-1)!.op).toMatchObject({ key: "volume", value: expect.closeTo(Math.pow(10, -14 / 20), 6) });

    applied = [];
    doc.undo();
    expect(musicDb()).toBe(start);
    expect(volumes()).toEqual([{ op: expect.objectContaining({ key: "volume", value: expect.closeTo(Math.pow(10, start / 20), 6) }), origin: "undo" }]);

    applied = [];
    doc.redo();
    expect(musicDb()).toBe(-14);
    expect(volumes()).toEqual([{ op: expect.objectContaining({ key: "volume", value: expect.closeTo(Math.pow(10, -14 / 20), 6) }), origin: "redo" }]);
  });

  it("undo in the middle of a drag closes the drag as its step and undoes all of it, live", () => {
    const start = musicDb();
    drag(-20);
    drag(-24);
    applied = [];
    doc.undo();
    expect(musicDb()).toBe(start);
    expect(volumes().map((a) => a.origin)).toEqual(["undo"]);
    applied = [];
    doc.redo();
    expect(musicDb()).toBe(-24);
    expect(volumes().map((a) => a.origin)).toEqual(["redo"]);
  });
});
