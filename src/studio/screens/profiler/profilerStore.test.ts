// The Profiler screen's store and recorder through their interfaces: opening a project capture over the in-process
// capture Worker, the cursor keys and seeks, selecting a voice, a refused file; and the recorder's flow over a fake
// `Audio.capture` (start, stop, save into the captures folder and open it, or say the browser downloaded it).
import { describe, expect, it, vi } from "vitest";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { inProcessWorker } from "../../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import { CaptureRecorder, recorderStatus, type RecorderSeams } from "./captureRecorder";
import { fixtureCapture } from "./profilerFixture";
import { ProfilerStore } from "./profilerStore";
import { whyNotRecord } from "./RecordButton";
import { clockText, extent, linePath, pct, rulerTicks, stepPath, valueAt } from "./timelineGeometry";

function store(files: Record<string, Uint8Array> = { "captures/run.mycap": fixtureCapture() }) {
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
    expect(await s.openPath("captures/run.mycap")).toBe(true);
    expect(s.state.value).toEqual({ kind: "open", origin: "file", path: "captures/run.mycap", title: "run" });
    expect(s.data.value!.tracks.length).toBeGreaterThan(0);
    s.seekTo(5);
    await vi.waitFor(() => expect(s.readouts.value.map((r) => r.name)).toEqual(["Music", "Vehicles", "Dialogue"]));
    expect(s.cursor.value).toBe(5);
    expect(s.readouts.value[0]!.lanes.map((l) => l.reason)).toEqual(["ducked"]);
  });

  it("steps with the arrows and jumps to markers and warnings with Shift", async () => {
    const s = store();
    await s.openPath("captures/run.mycap");
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
    const s = store({ "captures/run.mycap": fixtureCapture(), "captures/bad.mycap": new Uint8Array([1, 2, 3]) });
    await s.openPath("captures/run.mycap");
    const stolen = s.data.value!.voices.find((v) => v.status === "stolen")!;
    s.select(stolen.key, true);
    expect(s.selectedVoice.value).toBe(stolen);
    expect(s.cursor.value).toBe(stolen.start);
    expect(await s.openPath("captures/bad.mycap")).toBe(false);
    expect(s.state.value.kind).toBe("failed");
    expect(s.state.value.kind === "failed" && s.state.value.message).toMatch(/Not a Myco capture file/);
    expect(s.data.value).toBeNull();
    expect(s.selectedVoice.value).toBeNull();
  });
});

function recorderSeams(over: Partial<RecorderSeams> = {}) {
  const capture = { state: "idle" as const, seconds: 3, start: vi.fn(async () => {}), stop: vi.fn(), save: vi.fn(async (name?: string) => `/data/cache/${name}.mycap.bin`) };
  const storeFake = { openLive: vi.fn(async () => {}), refreshLive: vi.fn(async () => {}), openPath: vi.fn(async () => true), close: vi.fn() };
  const seams: RecorderSeams = {
    capture,
    liveHost: null,
    store: storeFake,
    files: () => ["captures/capture_01.mycap"],
    readSaved: vi.fn(async () => new Uint8Array([9])),
    forgetSaved: vi.fn(async () => {}),
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
    expect(recorderStatus(r.state.value, r.seconds)).toBe("Recording the Studio · 3.0 s");
    await r.stop();
    expect(capture.stop).toHaveBeenCalled();
    expect(capture.save).toHaveBeenCalledWith("capture_02");
    expect(seams.readSaved).toHaveBeenCalledWith("capture_02.mycap");
    expect(seams.write).toHaveBeenCalledWith("captures/capture_02.mycap", new Uint8Array([9]));
    expect(seams.forgetSaved).toHaveBeenCalledWith("capture_02.mycap");
    expect(storeFake.openPath).toHaveBeenCalledWith("captures/capture_02.mycap");
    expect(r.state.value).toEqual({ kind: "saved", path: "captures/capture_02.mycap" });
  });

  it("says the browser downloaded the file when the save can't be read back", async () => {
    const { seams } = recorderSeams({ readSaved: async () => null });
    (seams.capture.save as ReturnType<typeof vi.fn>).mockResolvedValue("capture_02.mycap");
    const r = new CaptureRecorder(seams);
    await r.start();
    await r.stop();
    expect(r.state.value).toEqual({ kind: "downloaded", file: "capture_02.mycap" });
    expect(recorderStatus(r.state.value, 0)).toMatch(/import it with Open capture file/);
  });

  it("reports a start the core refused", async () => {
    const { seams } = recorderSeams();
    (seams.capture.start as ReturnType<typeof vi.fn>).mockRejectedValue(new Error("the core is unavailable"));
    const r = new CaptureRecorder(seams);
    await r.start();
    expect(r.state.value).toEqual({ kind: "failed", message: "Couldn't start a capture: the core is unavailable" });
  });

  it("is offered only while the Studio's runtime plays something", () => {
    expect(whyNotRecord({ playable: false, voices: 0 })).toMatch(/isn't running/);
    expect(whyNotRecord({ playable: true, voices: 0 })).toMatch(/Nothing is playing/);
    expect(whyNotRecord({ playable: true, voices: 2 })).toBeNull();
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
