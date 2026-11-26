// The build session (ADR 0417) over a real link to a build (the audio link client's test support), without React: one
// session per connected build (`followBuildSessions`), always live while connected (ADR 0408): the take a build records
// grows as the live take, one recording state follows it however it started, the Profiler's capture follow starts at
// once, the take picture width is sent on connect and on change (ADR 0411); when the link closes the session ends, says
// why, shows files and hands the take it saved to `keep` (ADR 0412).
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { joinPath, openFolderProject, type EditorProject } from "../../editor/projects";
import { currentProject } from "../../editor/state";
import { MemoryFileSystem, ROOT } from "../../editor/testing";
import { linkedBuild, type LinkedBuild } from "../../plugins/audio/editor/debugLink/buildLinkTestSupport";
import type { LiveScheduler } from "../../plugins/audio/editor/mix/liveFollow";
import { inProcessWorker } from "../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import { Audio } from "../../plugins/audio/runtime/Audio";
import { setAudioBackend } from "../../plugins/audio/runtime/backend";
import { releaseCapture } from "../../plugins/audio/runtime/capture/capture";
import type { CaptureChunkControl } from "../../plugins/audio/runtime/capture/testSupport";
import { ProfilerStore } from "../screens/profiler/profilerStore";
import { saveTakeIntoProject } from "../screens/take/recordFromBuild";
import { buildSession, followBuildSessions, takeOnShow, type BuildSessionSeams, type SessionBuild } from "./buildSession";
import { DEFAULT_TAKE_PICTURE_WIDTH, takePictureWidth, takePictureWidthOf } from "./takePictures";

const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("../../plugins/audio/runtime/capture/recorder", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureRecorderModule(await real(), chunk));
vi.mock("../../plugins/audio/runtime/capture/save", async (real) => (await import("../../plugins/audio/runtime/capture/testSupport")).captureSaveModule(await real(), chunk));

const WHEN = new Date(2026, 10, 22, 10, 15, 0);
const NAME = "recordings/smoke-game_2026-11-22_10-15-00.sporesample";

/** Timers that never run (the live view's update window and the quiet check aren't what these tests are about). */
const idle: LiveScheduler = { setTimeout: () => 0, clearTimeout: () => {} };

let project: EditorProject;
const undo: (() => void)[] = [];

beforeEach(async () => {
  const fs = new MemoryFileSystem();
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
  takePictureWidth.value = DEFAULT_TAKE_PICTURE_WIDTH;
});

async function rig(more: Partial<BuildSessionSeams> = {}) {
  const build: LinkedBuild = await linkedBuild(chunk);
  undo.push(() => build.dispose());
  const builds = signal<SessionBuild | null>(null);
  const kept: string[] = [];
  let clock = 5000;
  const store = new ProfilerStore({ open: () => Promise.reject(new Error("no files here")), readFile: () => Promise.reject(new Error("no files here")) });
  undo.push(
    followBuildSessions(builds, () => ({
      recorder: { write: (name, bytes) => saveTakeIntoProject(project, name, bytes), now: () => WHEN },
      follow: { store, liveOptions: { scheduler: idle, sourceOptions: () => ({ worker: inProcessWorker() }) }, remote: { scheduler: idle } },
      liveTake: { publishMs: 0 },
      now: () => clock,
      keep: (path) => void kept.push(path),
      ...more,
    })),
  );
  /** Runs `p` to the end, the build stepping and the tool polling meanwhile. */
  const run = async <T>(p: Promise<T>): Promise<T> => {
    let done = false;
    p.then(() => (done = true), () => (done = true));
    await build.until(() => done, 2000);
    return p;
  };
  const connect = () => (builds.value = { name: "Smoke game", peer: build.peer });
  return { build, builds, kept, run, connect, store, tick: (ms: number) => (clock += ms) };
}

const session = () => buildSession.value!;
const live = () => {
  const show = takeOnShow.value;
  return show.kind === "live" ? show.take : null;
};

describe("the build session", () => {
  it("is live while connected: the take a build records grows as the live take, a new take starts over, and the Profiler follows", async () => {
    const { build, run, connect } = await rig();
    expect(buildSession.value).toBeNull();
    expect(takeOnShow.value).toEqual({ kind: "file" });
    connect();
    expect(takeOnShow.value).toEqual({ kind: "live", build: "Smoke game", take: null });
    expect(session().recording.value).toEqual({ kind: "idle" });
    expect(session().follow.following).toBe(true); // the Profiler is live at once (ADR 0408)

    // The game starts a take itself (as its script or F10 would) and marks it.
    await run(Audio.take.start());
    await build.until(() => live()?.state === "recording", 2000);
    expect(live()).toMatchObject({ build: "Smoke game", state: "recording", message: null });
    expect(live()!.take.keyframes.length).toBeGreaterThan(0);
    const first = live()!.id;
    Audio.take.mark("first");
    build.feed(10);
    await build.until(() => live()!.take.marks().length === 1, 5000);
    Audio.take.mark("second");
    await build.until(() => live()!.take.marks().length === 2, 5000);
    expect(live()!.take.meta).toMatchObject({ engine: "myco", audioHash: expect.stringMatching(/^[0-9a-f]{8}$/) });

    Audio.take.stop();
    await build.until(() => live()?.state === "stopped", 2000);
    expect(live()!.take.marks().map((m) => m.text)).toEqual(["first", "second"]);
    expect(live()!.take.meta.duration).toBeCloseTo(Audio.take.seconds, 2);

    // A new take: the picture starts over.
    await run(Audio.take.start());
    await build.until(() => live()?.state === "recording" && live()!.id !== first, 2000);
    expect(live()!.take.marks()).toEqual([]);
  });

  it("shows a build's last take when it connects after the take stopped", async () => {
    const { build, run, connect } = await rig();
    await run(Audio.take.start());
    Audio.take.mark("kept");
    Audio.take.stop();
    connect();
    await build.until(() => live()?.state === "stopped", 2000);
    expect(live()!.take.marks().map((m) => m.text)).toEqual(["kept"]);
  });

  it("keeps one recording state, however the take started: since when it started, idle once it stopped", async () => {
    const { build, run, connect, tick } = await rig({ recorder: { write: (name, bytes) => saveTakeIntoProject(project, name, bytes), now: () => WHEN, autoSave: () => false } });
    connect();
    await run(session().start());
    expect(session().recording.value).toEqual({ kind: "recording", since: 5000 });
    tick(1000);
    await run(session().mark("boss"));
    expect(session().recording.value).toEqual({ kind: "recording", since: 5000 });
    await run(session().stop());
    expect(session().recording.value).toEqual({ kind: "idle" });
    // The game starts the next one (F10): the same state, from when it was seen.
    await run(Audio.take.start());
    await build.until(() => session().recording.value.kind === "recording", 2000);
    expect(session().recording.value).toEqual({ kind: "recording", since: 6000 });
  });

  it("sends the take picture width on connect and on change; the build's next take uses it; a refusal says why", async () => {
    const width = signal<unknown>(DEFAULT_TAKE_PICTURE_WIDTH);
    const { build, run, connect } = await rig({ pictureWidth: width });
    expect(takePictureWidthOf(960)).toBe(960);
    expect(takePictureWidthOf(500)).toBe(640);
    connect();
    await build.until(() => session().pictureWidth.value !== null, 2000);
    expect(session().pictureWidth.value).toEqual({ build: "Smoke game", width: 640 });
    width.value = 1280;
    await build.until(() => (session().pictureWidth.value as { width?: number } | null)?.width === 1280, 2000);
    await run(Audio.take.start());
    await build.until(() => live()?.state === "recording", 2000);
    expect(live()).toMatchObject({ pictures: true, pictureWidth: 1280 });
    expect(await run(session().client.frames(5000)).catch((e: unknown) => (e as Error).message)).toMatch(/take\.frames: .*from 64 to 1920/);
  });

  it("ends when the link closes: says why, shows files and keeps the take it saved", async () => {
    const { build, builds, kept, run, connect } = await rig();
    connect();
    await run(session().start());
    for (let i = 0; i < 4; i++) (build.feed(500), build.round());
    await run(session().stop());
    expect(await run(session().recorder.save())).toBe(NAME);
    const ended = session();
    build.closeBuild();
    builds.value = null; // the Studio's link drops the build
    expect(buildSession.value).toBe(ended); // stays, ended, to say why
    expect(ended.open).toBe(false);
    expect(ended.recording.value).toMatchObject({ kind: "ended" });
    expect(takeOnShow.value).toEqual({ kind: "file" });
    expect(kept).toEqual([NAME]);
    const follow = ended.follow.state.value;
    expect(follow.kind === "ended" && follow.message).toMatch(/^The link to Smoke game closed/);
    // Whatever runs on the closed link fails with why.
    await ended.start();
    expect(ended.recorder.state.value).toMatchObject({ kind: "failed", message: expect.stringMatching(/the link to Smoke game closed/) });

  });
});
