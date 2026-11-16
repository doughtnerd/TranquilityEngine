// ADR 0171 amended by 0172 (M5a, K0): the recorder is a lazy chunk. A game that never calls `Audio.capture.start()` never
// loads it, and a chunk that fails to load leaves the capture idle until a later start can load it. Each case imports a
// fresh module graph (`vi.resetModules`), so "loaded" is the real module registry's, seen through the mock factory below
// (which wraps the real `recorder.ts`).
import { afterEach, describe, expect, it, vi } from "vitest";

/** How often the recorder module was loaded, and an error the next load fails with. */
const chunk = vi.hoisted(() => ({ loads: 0, fail: null as Error | null }));
vi.mock("./recorder", async (real) => {
  chunk.loads++;
  if (chunk.fail) throw chunk.fail;
  return real();
});

/** `Audio`, the capture module and a fake core backend, from a fresh module graph. */
async function fresh() {
  vi.resetModules();
  const [{ Audio }, { setAudioBackend }, { makeFakeBackend }, capture] = await Promise.all([
    import("../Audio"),
    import("../backend"),
    import("../testing"),
    import("./capture"),
  ]);
  const fb = makeFakeBackend();
  setAudioBackend(fb);
  release = () => {
    capture.releaseCapture();
    setAudioBackend(null);
  };
  return { Audio, fb, capture };
}

let release: () => void = () => {};

afterEach(() => {
  release();
  release = () => {};
  chunk.loads = 0;
  chunk.fail = null;
});

describe("the recorder chunk", () => {
  it("a game that never calls start never loads it, and every member answers as idle", async () => {
    const { Audio, fb, capture } = await fresh();
    expect(Audio.capture.state).toBe("idle");
    expect(Audio.capture.seconds).toBe(0);
    Audio.capture.mark("no ring");
    Audio.capture.stop();
    await expect(Audio.capture.save("take")).rejects.toThrow("nothing recorded: call Audio.capture.start() first");
    expect(capture.captureDebug()).toBeNull();
    expect(fb.recorderTap).toBeNull();
    expect(chunk.loads).toBe(0);
  });

  it("start loads it; when it can't load, start rejects and leaves the capture idle, and a later start loads it", async () => {
    const { Audio, fb, capture } = await fresh();
    chunk.fail = new Error("chunk failed to load");
    await expect(Audio.capture.start()).rejects.toThrow();
    expect(Audio.capture.state).toBe("idle");
    expect(capture.captureDebug()).toBeNull();
    expect(fb.recorderTap).toBeNull();
    chunk.fail = null;
    await Audio.capture.start();
    expect(Audio.capture.state).toBe("recording");
    expect(chunk.loads).toBe(2);
  });
});
