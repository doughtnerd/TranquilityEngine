// Recording a take from a connected build (plan U5) through `BuildTakeRecorder`: a headless build serves the real
// `audio` topic over the loopback link (as the link smoke does); Start, Mark, Stop and Save drive its take, the upload's
// chunks are reassembled and the take file lands in the project's `recordings/` folder (a project in memory), named from the
// build and the time. A refusal, the link closing mid-upload and a read-only project each fail with why.
import { effect } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isTakesFolder, joinPath, openFolderProject, openTakesFolder, type EditorProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { Audio } from "../../../plugins/audio/runtime/Audio";
import { setAudioBackend } from "../../../plugins/audio/runtime/backend";
import { releaseCapture } from "../../../plugins/audio/runtime/capture/capture";
import { openTakeFile } from "../../../plugins/audio/runtime/capture/takeFile";
import type { CaptureChunkControl } from "../../../plugins/audio/runtime/capture/testSupport";
import { linkedBuild, type LinkedBuild } from "../../../plugins/audio/editor/debugLink/buildLinkTestSupport";
import { setTakeFrameWidth, takeLive } from "../../../plugins/audio/runtime/capture/take";
import { BuildTakeRecorder, buildTakeName, buildTakeStatus, saveTakeIntoProject, type BuildTakeSeams, type BuildTakeState } from "./recordFromBuild";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../../plugins/audio/runtime/capture/recorder", async (real) => (await import("../../../plugins/audio/runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../../plugins/audio/runtime/capture/save", async (real) => (await import("../../../plugins/audio/runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const WHEN = new Date(2026, 10, 22, 10, 15, 0);
const NAME = "recordings/smoke-game_2026-11-22_10-15-00.sporesample";

let fs: MemoryFileSystem;
let project: EditorProject;
const undo: (() => void)[] = [];

beforeEach(async () => {
  fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  project = await openFolderProject(fs, ROOT);
  currentProject.value = project;
});

afterEach(() => {
  for (const u of undo.splice(0).reverse()) u();
  Audio.take.stop();
  releaseCapture();
  chunk.saveEnv = null;
  setAudioBackend(null);
  currentProject.value = null;
});

async function rig(target: () => EditorProject | null = () => project, more: Partial<BuildTakeSeams> = {}) {
  const build: LinkedBuild = await linkedBuild(chunk);
  undo.push(() => build.dispose());
  const saved: string[] = [];
  const rec = new BuildTakeRecorder({ name: "Smoke game", peer: build.peer }, { write: (name, bytes) => saveTakeIntoProject(target(), name, bytes), now: () => WHEN, saved: (p) => void saved.push(p), ...more });
  const states: BuildTakeState[] = [];
  undo.push(effect(() => void states.push(rec.state.value)));
  /** Runs `p` to the end, the build stepping and the tool polling meanwhile. */
  const run = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    void p.finally(() => (done = true));
    await build.until(() => done, 2000);
    return p;
  };
  return { build, rec, states, saved, run };
}

/** Sound for a take of several upload chunks. */
function record(build: LinkedBuild, blocks: number): void {
  for (let i = 0; i < blocks / 500; i++) {
    build.feed(500);
    build.round();
  }
}

describe("recording a take from a connected build", () => {
  // First: the build's take outlives a test (the runtime keeps its last take for a save), so this runs before any take.
  it("Save with nothing recorded fails with the build's refusal, and nothing is written", async () => {
    const r = await rig();
    await r.run(r.rec.mark("ignored")); // not recording: nothing happens
    expect(r.rec.state.value).toEqual({ kind: "idle" });
    expect(await r.run(r.rec.save())).toBeNull();
    const s = r.rec.state.value;
    expect(s.kind).toBe("failed");
    expect(s.kind === "failed" && s.message).toMatch(/^Couldn't save the take from Smoke game: nothing recorded/);
    expect(s.kind === "failed" && s.canSave).toBe(false);
    expect(project.files.some((f) => f.startsWith("recordings/"))).toBe(false);
  });

  it("Start, Mark, Stop and Save: the take lands in recordings/, named from the build and the time, with its marker", async () => {
    const r = await rig();
    expect(buildTakeStatus(r.rec.state.value, "Smoke game")).toBeNull();
    await r.run(r.rec.start());
    expect(r.rec.state.value).toEqual({ kind: "recording", marks: 0 });
    expect(Audio.take.state).toBe("recording");
    record(r.build, 12_000);
    await r.run(r.rec.mark("boss enters"));
    expect(r.rec.state.value).toEqual({ kind: "recording", marks: 1 });
    expect(buildTakeStatus(r.rec.state.value, "Smoke game")).toBe("● Recording on Smoke game · 1 mark");
    record(r.build, 12_000);
    await r.run(r.rec.stop());
    const stopped = r.rec.state.value;
    expect(stopped.kind === "stopped" && stopped.seconds).toBeGreaterThan(0);
    expect(Audio.take.state).toBe("stopped");

    const path = await r.run(r.rec.save());
    expect(path).toBe(NAME);
    expect(r.rec.state.value).toEqual({ kind: "saved", path: NAME });
    expect(r.saved).toEqual([NAME]);
    expect(project.files).toContain(NAME);
    const uploads = r.states.filter((s): s is Extract<BuildTakeState, { kind: "uploading" }> => s.kind === "uploading");
    expect(uploads[0]).toMatchObject({ received: 0, bytes: 0 });
    expect(uploads[0]!.chunks, "a take of several chunks").toBeGreaterThan(1);
    expect(uploads.map((u) => u.received)).toEqual(Array.from({ length: uploads[0]!.chunks }, (_, i) => i));
    expect(buildTakeStatus(uploads[0]!, "Smoke game")).toMatch(/^Uploading the take · 0 of \d+ chunk/);

    const written = fs.files.get(joinPath(ROOT, NAME)) as Uint8Array;
    const opened = await openTakeFile(written);
    expect(opened.take.requests.filter((q) => q.kind === "mark")).toHaveLength(1);
    console.log(`take from a build: ${written.byteLength} bytes in ${uploads[0]!.chunks} chunks`);
  });

  it("Start sends the picture width chosen first, so the take records its pictures at it (ADR 0411)", async () => {
    setTakeFrameWidth(320); // the build's own default
    undo.push(() => void setTakeFrameWidth(320));
    const r = await rig(() => project, { pictureWidth: () => 960 });
    await r.run(r.rec.start());
    expect(r.rec.state.value).toEqual({ kind: "recording", marks: 0 });
    expect(takeLive()?.facts.pictureWidth).toBe(960);
  });

  it("a second save of the same moment never writes over the first", async () => {
    const r = await rig();
    await r.run(r.rec.start());
    record(r.build, 1000);
    await r.run(r.rec.stop());
    expect(await r.run(r.rec.save())).toBe(NAME);
    expect(await r.run(r.rec.save())).toBe("recordings/smoke-game_2026-11-22_10-15-00 (1).sporesample");
  });

  it("the link closing mid-upload fails the save with why", async () => {
    const r = await rig();
    await r.run(r.rec.start());
    record(r.build, 1000);
    await r.run(r.rec.stop());
    const saving = r.rec.save();
    await r.build.until(() => r.rec.state.value.kind === "uploading");
    r.rec.linkClosed("the game quit");
    expect(await saving).toBeNull();
    const s = r.rec.state.value;
    expect(s.kind === "failed" && s.message).toBe("Couldn't save the take from Smoke game: the link to Smoke game closed (the game quit)");
    expect(s.kind === "failed" && s.canSave).toBe(false);
    await r.rec.start(); // gone: nothing more reaches the build
    expect(r.rec.state.value.kind === "failed" && r.rec.state.value.message).toMatch(/^Couldn't start a take on Smoke game: the link to Smoke game closed/);
  });

  it("a read-only project fails the save with why, and the take can be saved again", async () => {
    const r = await rig(() => null);
    await r.run(r.rec.start());
    record(r.build, 1000);
    await r.run(r.rec.stop());
    expect(await r.run(r.rec.save())).toBeNull();
    const s = r.rec.state.value;
    expect(s.kind === "failed" && s.message).toBe("Couldn't save the take from Smoke game: no project is open");
    expect(s.kind === "failed" && s.canSave).toBe(true);
  });
});

describe("a build take's name", () => {
  it("is the build's name made safe, then the date and time", () => {
    expect(buildTakeName("Smoke game", WHEN)).toBe("smoke-game_2026-11-22_10-15-00.sporesample");
    expect(buildTakeName("  Flappy: Canyon *Run*!  ", new Date(2026, 0, 5, 7, 8, 9))).toBe("flappy-canyon-run_2026-01-05_07-08-09.sporesample");
    expect(buildTakeName("???", WHEN)).toBe("build_2026-11-22_10-15-00.sporesample");
  });
});

describe("a take the game starts and stops (ADR 0408)", () => {
  async function watched(autoSave: boolean) {
    const build: LinkedBuild = await linkedBuild(chunk);
    undo.push(() => build.dispose());
    const saved: [string, boolean][] = [];
    const rec = new BuildTakeRecorder({ name: "Smoke game", peer: build.peer }, { write: (name, bytes) => saveTakeIntoProject(project, name, bytes), now: () => WHEN, autoSave: () => autoSave, saved: (p, auto) => void saved.push([p, auto]) });
    undo.push(() => rec.dispose());
    rec.watch();
    return { build, rec, saved };
  }

  it("shows the game's take as recording and saves it into recordings/ when the game stops it", async () => {
    const { build, rec, saved } = await watched(true);
    await build.until(() => true, 50);
    await Audio.take.start(); // the game (F10, or its script)
    await build.until(() => rec.state.value.kind === "recording", 2000);
    record(build, 6_000);
    Audio.take.stop();
    await build.until(() => rec.state.value.kind === "saved" || rec.state.value.kind === "failed", 4000);
    expect(rec.state.value).toEqual({ kind: "saved", path: NAME });
    expect(saved).toEqual([[NAME, true]]);
    expect(project.files).toContain(NAME);
  });

  it("waits, stopped, for Save where saving needs a press (a browser's save dialog)", async () => {
    const { build, rec, saved } = await watched(false);
    await Audio.take.start();
    await build.until(() => rec.state.value.kind === "recording", 2000);
    record(build, 3_000);
    Audio.take.stop();
    await build.until(() => rec.state.value.kind === "stopped", 2000);
    expect(saved).toEqual([]);
    expect(project.files).not.toContain(NAME);
  });
});

describe("a take saved into a takes folder workspace (ADR 0408)", () => {
  it("goes into the folder itself, not a takes/ inside it, and the workspace lists it", async () => {
    const folder = joinPath(ROOT, "my-takes");
    const workspace = await openTakesFolder(fs, folder);
    expect(isTakesFolder(workspace)).toBe(true);
    expect(isTakesFolder(project)).toBe(false);
    const path = await saveTakeIntoProject(workspace, "a.sporesample", new Uint8Array([1, 2, 3]));
    expect(path).toBe("a.sporesample");
    expect(fs.files.get(joinPath(folder, "a.sporesample"))).toEqual(new Uint8Array([1, 2, 3]));
    expect(workspace.files).toContain("a.sporesample");
  });

  it("opens a folder of takes with no project.json, loading only takes, notes and captures", async () => {
    const folder = joinPath(ROOT, "loose");
    fs.files.set(joinPath(folder, "run.sporesample"), new Uint8Array([9]));
    fs.files.set(joinPath(folder, "run.sporesample.notes.json"), "{}");
    fs.files.set(joinPath(folder, "old/cap.sporesample"), new Uint8Array([7]));
    fs.files.set(joinPath(folder, "readme.txt"), "hi");
    const workspace = await openTakesFolder(fs, folder);
    expect([...workspace.files].sort()).toEqual(["old/cap.sporesample", "run.sporesample", "run.sporesample.notes.json"]);
    expect(workspace.name).toBe("loose");
    expect(workspace.canSave).toBe(true);
  });
});
