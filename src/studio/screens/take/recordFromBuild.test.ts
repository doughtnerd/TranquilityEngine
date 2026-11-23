// Recording a take from a connected build (plan U5) through `BuildTakeRecorder`: a headless build serves the real
// `audio` topic over the loopback link (as the link smoke does); Start, Mark, Stop and Save drive its take, the upload's
// chunks are reassembled and the take file lands in the project's `takes/` folder (a project in memory), named from the
// build and the time. A refusal, the link closing mid-upload and a read-only project each fail with why.
import { effect } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinPath, openFolderProject, type EditorProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { Audio } from "../../../plugins/audio/runtime/Audio";
import { setAudioBackend } from "../../../plugins/audio/runtime/backend";
import { releaseCapture } from "../../../plugins/audio/runtime/capture/capture";
import { openTakeFile } from "../../../plugins/audio/runtime/capture/takeFile";
import type { CaptureChunkControl } from "../../../plugins/audio/runtime/capture/testSupport";
import { linkedBuild, type LinkedBuild } from "../profiler/buildLinkTestSupport";
import { BuildTakeRecorder, buildTakeName, buildTakeStatus, saveTakeIntoProject, type BuildTakeState } from "./recordFromBuild";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../../plugins/audio/runtime/capture/recorder", async (real) => (await import("../../../plugins/audio/runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../../plugins/audio/runtime/capture/save", async (real) => (await import("../../../plugins/audio/runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const WHEN = new Date(2026, 10, 22, 10, 15, 0);
const NAME = "takes/smoke-game_2026-11-22_10-15-00.mycotake";

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

async function rig(target: () => EditorProject | null = () => project) {
  const build: LinkedBuild = await linkedBuild(chunk);
  undo.push(() => build.dispose());
  const saved: string[] = [];
  const rec = new BuildTakeRecorder({ name: "Smoke game", peer: build.peer }, { write: (name, bytes) => saveTakeIntoProject(target(), name, bytes), now: () => WHEN, saved: (p) => void saved.push(p) });
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
    expect(project.files.some((f) => f.startsWith("takes/"))).toBe(false);
  });

  it("Start, Mark, Stop and Save: the take lands in takes/, named from the build and the time, with its marker", async () => {
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

  it("a second save of the same moment never writes over the first", async () => {
    const r = await rig();
    await r.run(r.rec.start());
    record(r.build, 1000);
    await r.run(r.rec.stop());
    expect(await r.run(r.rec.save())).toBe(NAME);
    expect(await r.run(r.rec.save())).toBe("takes/smoke-game_2026-11-22_10-15-00 (1).mycotake");
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
    expect(buildTakeName("Smoke game", WHEN)).toBe("smoke-game_2026-11-22_10-15-00.mycotake");
    expect(buildTakeName("  Flappy: Canyon *Run*!  ", new Date(2026, 0, 5, 7, 8, 9))).toBe("flappy-canyon-run_2026-01-05_07-08-09.mycotake");
    expect(buildTakeName("???", WHEN)).toBe("build_2026-11-22_10-15-00.mycotake");
  });
});
