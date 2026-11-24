// The Profiler screen's store and recorder through their interfaces: opening a project capture over the in-process
// capture Worker, the cursor keys and seeks, selecting a voice, a refused file; and the recorder's flow over a fake
// `Audio.capture` (start, stop, the take's bytes written into the captures folder and opened).
import { describe, expect, it, vi } from "vitest";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { inProcessWorker } from "../../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import { CaptureRecorder, recorderStatus, type RecorderSeams } from "./captureRecorder";
import { fixtureCapture } from "./profilerFixture";
import { ProfilerStore } from "./profilerStore";
import { whyNotRecord } from "./RecordButton";
import { clockText, extent, linePath, pct, rulerTicks, stepPath, valueAt } from "./timelineGeometry";

function store(files: Record<string, Uint8Array> = { "recordings/run.sporesample": fixtureCapture() }) {
  return new ProfilerStore({
    open: (bytes) => CaptureSource.openFile(bytes, { worker: inProcessWorker() }),
    readFile: async (path) => {
      const f = files[path];
      if (!f) throw new Error(`${path} isn't in the project.`);
      return f.slice().buffer;
    },
  });
}

describe("the Profiler store", () => {
  it("opens a project capture, reads its data and the state at the cursor", async () => {
    const s = store();
    expect(await s.openPath("recordings/run.sporesample")).toBe(true);
    expect(s.state.value).toEqual({ kind: "open", origin: "file", path: "recordings/run.sporesample", title: "run", replayOf: null, take: false });
    expect(s.data.value!.tracks.length).toBeGreaterThan(0);
    s.seekTo(5);
    await vi.waitFor(() => expect(s.readouts.value.map((r) => r.name)).toEqual(["Music", "Vehicles", "Dialogue"]));
    expect(s.cursor.value).toBe(5);
    expect(s.readouts.value[0]!.lanes.map((l) => l.reason)).toEqual(["ducked"]);
  });

  it("steps with the arrows and jumps to markers and warnings with Shift", async () => {
    const s = store();
    await s.openPath("recordings/run.sporesample");
    expect(s.key("stepBack")).toBe(false);
    expect(s.key("stepForward")).toBe(true);
    expect(s.cursor.value).toBeGreaterThan(0);
    const marks = s.data.value!.targets.marker;
    expect(s.key("markerForward")).toBe(true);
    expect(s.cursor.value).toBe(marks[0]);
    expect(s.key("markerForward")).toBe(true);
    expect(s.cursor.value).toBe(marks[1]);
    expect(s.key("markerBack")).toBe(true);
    expect(s.cursor.value).toBe(marks[0]);
  });

  it("selects a voice and seeks to its start; a refused file says why and leaves nothing open", async () => {
    const s = store({ "recordings/run.sporesample": fixtureCapture(), "recordings/bad.sporesample": new Uint8Array([1, 2, 3]) });
    await s.openPath("recordings/run.sporesample");
    const stolen = s.data.value!.voices.find((v) => v.status === "stolen")!;
    s.select(stolen.key, true);
    expect(s.selectedVoice.value).toBe(stolen);
    expect(s.cursor.value).toBe(stolen.start);
    expect(await s.openPath("recordings/bad.sporesample")).toBe(false);
    expect(s.state.value.kind).toBe("failed");
    expect(s.state.value.kind === "failed" && s.state.value.message).toMatch(/Not a Myco capture file/);
    expect(s.data.value).toBeNull();
    expect(s.selectedVoice.value).toBeNull();
  });

  it("says which take a replay capture came from (META replayOf)", async () => {
    const take = { path: "recordings/canyon_run_01.sporesample", audioHash: "5f3a90c1" };
    const s = store({ "recordings/replay.sporesample": fixtureCapture(undefined, take) });
    await s.openPath("recordings/replay.sporesample");
    expect(s.state.value).toMatchObject({ kind: "open", replayOf: take });
  });
});

function recorderSeams(over: Partial<RecorderSeams> = {}) {
  const capture = { state: "idle" as const, seconds: 3, start: vi.fn(async () => {}), stop: vi.fn() };
  const storeFake = { openLive: vi.fn(async () => {}), refreshLive: vi.fn(async () => {}), openPath: vi.fn(async () => true), close: vi.fn() };
  const seams: RecorderSeams = {
    capture,
    liveHost: null,
    store: storeFake,
    files: () => ["recordings/capture_01.sporesample"],
    fileBytes: vi.fn(async () => new Uint8Array([9])),
    write: vi.fn(async (path: string) => path),
    ...over,
  };
  return { seams, capture, storeFake };
}

describe("the recorder", () => {
  it("records, then on Stop saves into the captures folder under the next free name and opens it", async () => {
    const { seams, capture, storeFake } = recorderSeams();
    const r = new CaptureRecorder(seams);
    await r.start();
    expect(capture.start).toHaveBeenCalled();
    expect(r.state.value.kind).toBe("recording");
    expect(recorderStatus(r.state.value, r.seconds)).toBe("● Recording a new capture · 3.0 s");
    await r.stop();
    expect(capture.stop).toHaveBeenCalled();
    expect(seams.fileBytes).toHaveBeenCalled();
    expect(seams.write).toHaveBeenCalledWith("recordings/capture_02.sporesample", new Uint8Array([9]));
    expect(storeFake.openPath).toHaveBeenCalledWith("recordings/capture_02.sporesample");
    expect(r.state.value).toEqual({ kind: "saved", path: "recordings/capture_02.sporesample" });
  });

  it("reports a save that failed, and never writes into the project", async () => {
    const { seams } = recorderSeams({ fileBytes: async () => Promise.reject(new Error("nothing recorded")) });
    const r = new CaptureRecorder(seams);
    await r.start();
    await r.stop();
    expect(r.state.value).toEqual({ kind: "failed", message: "Couldn't save the capture: nothing recorded" });
    expect(seams.write).not.toHaveBeenCalled();
  });

  it("reports a start the core refused", async () => {
    const { seams } = recorderSeams();
    (seams.capture.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("the core is unavailable"));
    const r = new CaptureRecorder(seams);
    await r.start();
    expect(r.state.value).toEqual({ kind: "failed", message: "Couldn't start a capture: the core is unavailable" });
  });

  it("names the take that replays while it records in the capture's META, and stops naming it on Stop", async () => {
    const named: unknown[] = [];
    const take = { path: "recordings/HoverBike/canyon_run_01.sporesample", audioHash: "5f3a90c1" };
    const { seams, capture } = recorderSeams({ replaying: () => take, nameReplay: (t) => named.push(t) });
    capture.start.mockImplementation(async () => {
      expect(named).toEqual([take]); // named before the capture's META is made
    });
    const r = new CaptureRecorder(seams);
    await r.start();
    expect(r.replayOf).toEqual(take);
    expect(recorderStatus(r.state.value, r.seconds, r.replayOf)).toBe("● Recording the replay of canyon_run_01 · 3.0 s");
    await r.stop();
    expect(named).toEqual([take, null]);
    expect(r.replayOf).toBeNull();
  });

  it("names nothing when no take replays, or when the start fails", async () => {
    const named: unknown[] = [];
    const { seams } = recorderSeams({ replaying: () => null, nameReplay: (t) => named.push(t) });
    const r = new CaptureRecorder(seams);
    await r.start();
    expect(named).toEqual([null]);
    const failing = recorderSeams({ replaying: () => ({ path: "recordings/a.sporesample", audioHash: "" }), nameReplay: (t) => named.push(t) });
    failing.capture.start.mockRejectedValue(new Error("no core"));
    await new CaptureRecorder(failing.seams).start();
    expect(named.slice(1)).toEqual([{ path: "recordings/a.sporesample", audioHash: "" }, null]);
  });

  it("is offered only while the Studio's runtime plays something", () => {
    expect(whyNotRecord({ playable: false, voices: 0 })).toMatch(/isn't running/);
    expect(whyNotRecord({ playable: true, voices: 0 })).toMatch(/Nothing is playing/);
    expect(whyNotRecord({ playable: true, voices: 2 })).toBeNull();
    // A take replaying (the game session) records even while it sounds nothing of this project (journeys walk 2, J10.3).
    expect(whyNotRecord({ playable: true, voices: 0, replaying: true })).toBeNull();
    expect(whyNotRecord({ playable: false, voices: 0, replaying: true })).toMatch(/isn't running/);
  });
});

describe("the timeline's geometry", () => {
  it("places times, draws reduced lines and held steps, and labels the ruler", () => {
    expect(pct(3, 12)).toBe(25);
    expect(pct(20, 12)).toBe(100);
    const line = { times: [0.2, 1.2, 2], values: [0, 10, 5] };
    expect(linePath(line, 2, 0, 10, 2)).toBe("M250 100 L750 0 L750 50");
    expect(stepPath({ times: [0, 1], values: [0, 1] }, 2, 0, 1)).toBe("M0 100 L500 100 L500 0 L1000 0");
    expect(valueAt(line, 1.5)).toBe(10);
    expect(valueAt(line, -1)).toBeNull();
    expect(extent([3, 3])).toEqual({ min: 2, max: 4 });
    expect(clockText(62.54)).toBe("1:02.5");
    expect(rulerTicks(12)).toEqual([0, 2, 4, 6, 8, 10, 12]);
  });
});
