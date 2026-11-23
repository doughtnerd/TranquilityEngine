// ADR 0348: the record toggles' model: start, stop and write into takes/ or captures/ under the first free name; a
// failed start, a failed save and a read-only project say so; Play stopping (stop with the recorder already stopped)
// still saves.
import { describe, expect, it } from "vitest";
import { RecordToggle, nextRecordPath, recordToggleTitle, type RecordKind } from "./recordToggleModel";

function rig(kind: RecordKind, opts: { files?: string[]; startFails?: boolean; bytesFail?: boolean; readOnly?: boolean } = {}) {
  const writes: [string, Uint8Array][] = [];
  let state: "idle" | "recording" | "stopped" = "idle";
  let stops = 0;
  const toggle = new RecordToggle(kind, {
    recorder: {
      get state() { return state; },
      seconds: 2,
      start: async () => {
        if (opts.startFails) throw new Error("no core");
        state = "recording";
      },
      stop: () => {
        stops++;
        state = "stopped";
      },
    },
    bytes: async () => {
      if (opts.bytesFail) throw new Error("nothing recorded");
      return new Uint8Array([1, 2, 3]);
    },
    files: () => opts.files ?? [],
    write: async (path, bytes) => {
      if (opts.readOnly) return null;
      writes.push([path, bytes]);
      return path;
    },
  });
  return { toggle, writes, stops: () => stops };
}

describe("RecordToggle (ADR 0348)", () => {
  it("names files take_NN.mycotake and capture_NN.mycap, the first free one", () => {
    expect(nextRecordPath("take", [])).toBe("takes/take_01.mycotake");
    expect(nextRecordPath("take", ["takes/take_01.mycotake", "takes/TAKE_02.mycotake"])).toBe("takes/take_03.mycotake");
    expect(nextRecordPath("capture", ["takes/capture_01.mycap"])).toBe("captures/capture_01.mycap");
  });

  it("records, then writes the file into the project on the next press", async () => {
    const { toggle, writes, stops } = rig("take", { files: ["takes/take_01.mycotake"] });
    const seen: string[] = [];
    toggle.subscribe(() => seen.push(toggle.state.kind));
    await toggle.toggle();
    expect(toggle.recording).toBe(true);
    await toggle.toggle();
    expect(stops()).toBe(1);
    expect(writes.map(([p]) => p)).toEqual(["takes/take_02.mycotake"]);
    expect(toggle.state).toEqual({ kind: "saved", path: "takes/take_02.mycotake" });
    expect(seen).toEqual(["starting", "recording", "saving", "saved"]);
  });

  it("says why when the start, the save or the project refuses", async () => {
    const a = rig("take", { startFails: true });
    await a.toggle.toggle();
    expect(a.toggle.state).toEqual({ kind: "failed", message: "Couldn't start the take: no core" });
    const b = rig("capture", { bytesFail: true });
    await b.toggle.start();
    await b.toggle.stop();
    expect(b.toggle.state).toEqual({ kind: "failed", message: "Couldn't save the capture: nothing recorded" });
    const c = rig("capture", { readOnly: true });
    await c.toggle.start();
    await c.toggle.stop();
    expect(c.toggle.state.kind).toBe("failed");
  });

  it("a stop when not recording does nothing", async () => {
    const { toggle, writes, stops } = rig("take");
    await toggle.stop();
    expect(stops()).toBe(0);
    expect(writes).toHaveLength(0);
  });

  it("words the tooltip by state", () => {
    expect(recordToggleTitle("take", { kind: "idle" }, 0, false)).toMatch(/while playing/);
    expect(recordToggleTitle("take", { kind: "recording" }, 2.25, true)).toBe("Recording the take · 2.3 s. Press again to stop and save it.");
    expect(recordToggleTitle("capture", { kind: "saved", path: "captures/capture_01.mycap" }, 0, true)).toMatch(/^Saved captures\/capture_01\.mycap/);
  });
});
