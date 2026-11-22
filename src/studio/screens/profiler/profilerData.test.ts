// The Profiler screen's data reader over the fixture capture, opened through the real reader and the capture Worker's
// handler run in process: the tracks it plans from what the capture holds, the voices and their statuses, the messages
// in time order, the bus lines in dB, the parameter line and the cursor's marker targets.
import { describe, expect, it } from "vitest";
import { CaptureSource } from "../../../plugins/audio/editor/mix/profilerSource";
import { inProcessWorker } from "../../../plugins/audio/editor/mix/tracks/cpuCountersTestSupport";
import { metaTarget, ProfilerDataReader } from "./profilerData";
import { fixtureCapture } from "./profilerFixture";

async function openFixture(): Promise<CaptureSource> {
  return CaptureSource.openFile(fixtureCapture().slice().buffer, { worker: inProcessWorker() });
}

describe("the Profiler's data reader", () => {
  it("plans the tracks the fixture has data for, in the prototype's order", async () => {
    const source = await openFixture();
    const data = await new ProfilerDataReader(source).refresh();
    expect(data.tracks.map((t) => t.label)).toEqual(["Load", "Bus · Music", "Bus · Vehicles", "Bus · Dialogue", "Voices", "Game · Speed"]);
    expect(data.load!.cap.values[0]).toBe(4);
    // Music is ducked by 6 dB from 4 s to 7 s: -6 dB authored, -12 dB while ducked.
    const music = data.buses.get(1)!;
    const at = (t: number) => music.values[Array.from(music.times).filter((x) => x <= t).length - 1]!;
    expect(at(2)).toBeCloseTo(-6.02, 1);
    expect(at(5)).toBeCloseTo(-12.04, 1);
    expect(Array.from(data.parameters.get("Speed")!.values)).toEqual([20, 80, 118]);
    source.close();
  });

  it("reads the voices with their statuses, and the messages in time order", async () => {
    const source = await openFixture();
    const data = await new ProfilerDataReader(source).refresh();
    const statuses = data.voices.map((v) => `${v.clipName}:${v.status}`);
    expect(statuses).toContain("impact_01.wav:stolen");
    expect(statuses).toContain("boost.wav:blocked");
    expect(statuses).toContain("vo_rider_07.wav:missing");
    expect(data.voices.find((v) => v.clipName === "music_explore.ogg")!.busName).toBe("Music");
    const times = data.messages.map((m) => m.time);
    expect(times).toEqual([...times].sort((a, b) => a - b));
    expect(data.messages.map((m) => m.text)).toEqual(expect.arrayContaining(["Marker: Boss spawned", "Music Explore → Combat", "Missing file vo_rider_07.wav"]));
    // Shift+arrows reach the marker and every warning.
    expect(data.targets.marker.length).toBe(data.marks.length);
    expect(data.targets.status.length).toBeGreaterThan(100);
    source.close();
  });

  it("reads a loudness target from the capture's META leniently", () => {
    expect(metaTarget({ name: "Console", integrated: -23, tolerance: 1, truePeak: -1 })).toEqual({ name: "Console", integrated: -23, tolerance: 1, truePeak: -1 });
    expect(metaTarget({ integrated: -16 })).toEqual({ integrated: -16, tolerance: 2, truePeak: -1 });
    expect(metaTarget(null)).toBeNull();
    expect(metaTarget({ integrated: "loud" })).toBeNull();
  });
});
