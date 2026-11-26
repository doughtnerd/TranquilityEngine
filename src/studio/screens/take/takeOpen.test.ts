// The Take screen opening takes (ADR 0348; journeys walk 2, J10.2): a take that can't be read shows its error, and the
// screen then names that take alone (the take open before closes, so the Takes tree, the timeline and the player bar
// never show one take beside another's error); the route moving on (another take, or none) leaves the error behind.
// Driven through the screen's store over a project in memory and a stand-in runtime.
import { signal } from "@preact/signals";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { joinPath, openFolderProject } from "../../../editor/projects";
import { currentProject } from "../../../editor/state";
import { MemoryFileSystem, ROOT } from "../../../editor/testing";
import { assembleTakeFile } from "../../../plugins/audio/runtime/capture/save";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE } from "../../../plugins/audio/runtime/capture/testSupport";
import { TakeRecorder } from "../../../plugins/audio/runtime/capture/takeRecorder";
import { encodeRecords, RecordType } from "../../../plugins/audio/runtime/capture/format";
import type { StudioAudioRuntime } from "../../runtime/studioAudioHost";
import { replayStore } from "../../shell/replay";
import { createRouter, type HashLocation } from "../../shell/route";
import { provideStudio } from "../../shell/studioServices";
import { takeScreen } from "./takeScreen";

const GOOD = "takes/good.sporesample";
const OTHER = "takes/other.sporesample";
const BAD = "takes/bad.sporesample";

/** A short take with no requests: one EPOCH in the profile and the recorder's own keyframe. */
function takeBytes(): Uint8Array {
  let seq = 1;
  const ring = { ringBytes: 1024 * 1024, stamp: () => ({ seq: seq++, epoch: 0, frame: 0 }), marker() {} };
  const epoch = { type: RecordType.EPOCH, epoch: 0, seq: seq++, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0, perfMs: 1000 } } as const;
  const rec = new TakeRecorder(ring, { now: () => 0 });
  const { requests, section } = rec.finish({ seed: 1, seeded: true, audioHash: "h" });
  return assembleTakeFile({
    header: SAMPLE_HEADER,
    meta: { ...SAMPLE_META, take: section },
    span: { bytes: encodeRecords([epoch]), recordCount: 1, keyframes: [], firstFrame: 0, sampleRate: SAMPLE_RATE, firstSeq: epoch.seq },
    truncatedFromSeq: 0,
    requests,
  });
}

beforeEach(async () => {
  const fs = new MemoryFileSystem();
  fs.files.set(joinPath(ROOT, "project.json"), "{}");
  const bytes = takeBytes();
  fs.files.set(joinPath(ROOT, GOOD), bytes);
  fs.files.set(joinPath(ROOT, OTHER), bytes);
  fs.files.set(joinPath(ROOT, BAD), new Uint8Array(200));
  currentProject.value = await openFolderProject(fs, ROOT);
  const hash: HashLocation = { get: () => "#/take", set: () => {}, listen: () => () => {} };
  const audio = { setParameter() {}, bus: () => ({ exists: false }), buses: [], masterVolume: 1 };
  const runtime = { playable: signal(false), state: signal({ kind: "stopped" }), audio, audition: () => null } as unknown as StudioAudioRuntime;
  provideStudio({ router: createRouter(hash), runtime });
});

afterEach(() => {
  takeScreen().close();
  currentProject.value = null;
});

describe("opening takes on the Take screen", () => {
  it("a take that fails names itself alone: the take open before closes, and the tree selects the failed one", async () => {
    const store = takeScreen();
    await store.openPath(GOOD);
    expect(store.state.value).toEqual({ kind: "open", path: GOOD });
    expect(replayStore().open.value?.path).toBe(GOOD);
    await store.openPath(BAD);
    expect(store.state.value.kind).toBe("failed");
    expect(replayStore().open.value).toBeNull();
    expect(store.shownPath()).toBe(BAD);
  });

  it("after a failed open, another take opens and the error is gone", async () => {
    const store = takeScreen();
    await store.openPath(BAD);
    expect(store.state.value.kind).toBe("failed");
    store.follow(OTHER, true);
    await new Promise((r) => setTimeout(r, 50));
    await store.openPath(OTHER); // settles the open the route started
    expect(store.state.value).toEqual({ kind: "open", path: OTHER });
    expect(replayStore().open.value?.path).toBe(OTHER);
    expect(store.shownPath()).toBe(OTHER);
  });

  it("a route that names no take drops the error of the take it named before", async () => {
    const store = takeScreen();
    await store.openPath(BAD);
    store.follow(undefined, false);
    expect(store.state.value).toEqual({ kind: "none" });
    expect(store.shownPath()).toBeNull();
  });
});
