// ADR 0348: the record toggles' model: start, stop and write into recordings/ under the first free name; a
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
  it("names files take_NN.sporesample and capture_NN.sporesample, the first free one", () => {
    expect(nextRecordPath("take", [])).toBe("recordings/take_01.sporesample");
    expect(nextRecordPath("take", ["recordings/take_01.sporesample", "recordings/TAKE_02.sporesample"])).toBe("recordings/take_03.sporesample");
    expect(nextRecordPath("capture", ["recordings/take_01.sporesample"])).toBe("recordings/capture_01.sporesample");
  });

  it("records, then writes the file into the project on the next press", async () => {
    const { toggle, writes, stops } = rig("take", { files: ["recordings/take_01.sporesample"] });
    const seen: string[] = [];
    toggle.subscribe(() => seen.push(toggle.state.kind));
    await toggle.toggle();
    expect(toggle.recording).toBe(true);
    await toggle.toggle();
    expect(stops()).toBe(1);
    expect(writes.map(([p]) => p)).toEqual(["recordings/take_02.sporesample"]);
    expect(toggle.state).toEqual({ kind: "saved", path: "recordings/take_02.sporesample" });
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

  it("a stop while the recorder is still loading cancels the start: nothing is written and the toggle goes idle", async () => {
    const writes: string[] = [];
    let state: "idle" | "loading" | "recording" | "stopped" = "stopped"; // a previous take is kept
    let finishLoad!: () => void;
    const toggle = new RecordToggle("take", {
      recorder: {
        get state() { return state; },
        seconds: 0,
        start: () => {
          state = "loading";
          return new Promise<void>((resolve) => {
            finishLoad = () => {
              if (state === "loading") state = "recording";
              resolve();
            };
          });
        },
        stop: () => {
          state = "stopped"; // a load is abandoned; the previous take stays
        },
      },
      bytes: async () => new Uint8Array([9]),
      files: () => [],
      write: async (path) => {
        writes.push(path);
        return path;
      },
    });
    const started = toggle.toggle();
    await toggle.toggle(); // pressed again while starting
    finishLoad();
    await started;
    expect(writes).toEqual([]);
    expect(toggle.state).toEqual({ kind: "idle" });
    expect(toggle.recording).toBe(false);
  });

  it("a stop while starting but already recording saves that take, and the start doesn't flip it back to recording", async () => {
    const writes: string[] = [];
    let state: "idle" | "loading" | "recording" | "stopped" = "idle";
    let finish!: () => void;
    const toggle = new RecordToggle("take", {
      recorder: {
        get state() { return state; },
        seconds: 0,
        start: () => {
          state = "recording"; // recording, but the start's promise still waits (plugin sources loading)
          return new Promise<void>((resolve) => (finish = resolve));
        },
        stop: () => {
          state = "stopped";
        },
      },
      bytes: async () => new Uint8Array([9]),
      files: () => [],
      write: async (path) => {
        writes.push(path);
        return path;
      },
    });
    const started = toggle.toggle();
    await toggle.toggle();
    finish();
    await started;
    expect(writes).toEqual(["recordings/take_01.sporesample"]);
    expect(toggle.state).toEqual({ kind: "saved", path: "recordings/take_01.sporesample" });
  });

  it("words the tooltip by state", () => {
    expect(recordToggleTitle("take", { kind: "idle" }, 0, false)).toMatch(/while playing/);
    expect(recordToggleTitle("take", { kind: "recording" }, 2.25, true)).toBe("Recording the take · 2.3 s. Press again to stop and save it.");
    expect(recordToggleTitle("capture", { kind: "saved", path: "recordings/capture_01.sporesample" }, 0, true)).toMatch(/^Saved recordings\/capture_01\.sporesample/);
  });
});
