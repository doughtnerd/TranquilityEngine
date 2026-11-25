// Spec §2.16 / §4.5.7: one review position for Take and the Profiler, through the link's interface over the real stores:
// the Profiler store over the in-process capture Worker with a replay capture, and the replay store over a silent target.
import { describe, expect, it, vi } from "vitest";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { inProcessWorker } from "../../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import type { ReplayTarget } from "../../runtime/takeReplay";
import { ReplayStore } from "../../shell/replay";
import { fixtureTake } from "../take/takeFixture";
import { FIXTURE_SECONDS, fixtureCapture } from "./profilerFixture";
import { ProfilerStore } from "./profilerStore";
import { linkReview, takeOfCapture } from "./reviewLink";

const TAKE = "recordings/canyon_run_03.sporesample";
const OTHER = "recordings/other.sporesample";

function setup() {
  const files: Record<string, Uint8Array> = {
    "recordings/replay.sporesample": fixtureCapture(FIXTURE_SECONDS, { path: TAKE, audioHash: "h" }),
    "recordings/plain.sporesample": fixtureCapture(),
  };
  const profiler = new ProfilerStore({
    open: (bytes) => CaptureSource.openFile(bytes, { worker: inProcessWorker() }),
    readFile: async (path) => files[path]!.slice().buffer,
  });
  const silent: ReplayTarget = { play: () => null, setGlobal() {}, busVolume() {}, snapshot() {}, clearSnapshot() {}, masterVolume: () => 1, listener() {}, seed: () => true };
  const replay = new ReplayStore({ target: () => silent, clock: { now: () => 0 }, frame: () => () => {} });
  const unlink = linkReview(profiler, replay);
  return { profiler, replay, unlink };
}

describe("one review position for Take and the Profiler", () => {
  it("names the take a capture is backed by: a take file itself, or a replay capture's take; never a live recording", () => {
    expect(takeOfCapture({ kind: "open", origin: "file", path: TAKE, replayOf: null, take: true })).toBe(TAKE);
    expect(takeOfCapture({ kind: "open", origin: "file", path: "recordings/r.sporesample", replayOf: { path: TAKE, audioHash: "h" }, take: false })).toBe(TAKE);
    expect(takeOfCapture({ kind: "open", origin: "file", path: "recordings/r.sporesample", replayOf: null, take: false })).toBeNull();
    expect(takeOfCapture({ kind: "open", origin: "live", path: null, replayOf: { path: TAKE, audioHash: "h" }, take: false })).toBeNull();
    expect(takeOfCapture({ kind: "none" })).toBeNull();
  });

  it("shows the take's position when its replay capture opens, then moves both together", async () => {
    const { profiler, replay } = setup();
    replay.openTake(TAKE, fixtureTake());
    replay.seek(8.5);
    await profiler.openPath("recordings/replay.sporesample");
    // The capture opened after the take: the Profiler's cursor is the take's position, not 0.
    await vi.waitFor(() => expect(profiler.cursor.value).toBeCloseTo(8.5));
    // Moving the Profiler's cursor moves the take…
    profiler.seekTo(3);
    expect(replay.time.value).toBeCloseTo(3);
    // …and moving the take moves the cursor.
    replay.seek(10);
    expect(profiler.cursor.value).toBeCloseTo(10);
    // Past the capture's end the cursor waits at its end; the take is not dragged back.
    replay.seek(20);
    expect(profiler.cursor.value).toBeCloseTo(FIXTURE_SECONDS);
    expect(replay.time.value).toBeCloseTo(20);
  });

  it("lands a take opened from the Profiler (Open in Take) at the Profiler's cursor", async () => {
    const { profiler, replay } = setup();
    await profiler.openPath("recordings/replay.sporesample");
    profiler.seekTo(6.25);
    replay.openTake(TAKE, fixtureTake());
    expect(replay.time.value).toBeCloseTo(6.25);
    expect(profiler.cursor.value).toBeCloseTo(6.25);
  });

  it("leaves unrelated captures and takes alone, and unlinks", async () => {
    const { profiler, replay, unlink } = setup();
    replay.openTake(OTHER, fixtureTake());
    replay.seek(4);
    await profiler.openPath("recordings/replay.sporesample"); // a replay of another take
    profiler.seekTo(2);
    expect(replay.time.value).toBeCloseTo(4);
    replay.openTake(TAKE, fixtureTake());
    expect(replay.time.value).toBeCloseTo(2);
    unlink();
    profiler.seekTo(7);
    expect(replay.time.value).toBeCloseTo(2);
    await profiler.openPath("recordings/plain.sporesample"); // no take behind it
    replay.seek(9);
    expect(profiler.cursor.value).toBe(0);
  });
});
