// ADR 0171 amended by 0172 (M5a, task Rc4 over Pf7 and Rc6; architecture §2.1, §3.7): the Profiler panel's `LiveFollow` over
// the real `captureLiveHost` (Rc4's seam), the real recorder and the capture Worker's real handler, in process. The ring is
// shared with a take: closing the panel with no take frees it, with a take running the take keeps it, and the panel's view
// follows the same STATUS blocks the take records. No wall-clock assertion: every wait is "the segments the feed sealed
// have reached the view".
import { afterEach, describe, expect, it, vi } from "vitest";
import { LiveFollow, type LiveFollowModel, type LiveScheduler } from "../../editor/mix/liveFollow";
import type { CaptureWorkerLike } from "../../editor/mix/profilerSource";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { _setRecorderLoader, _setSaveEnv, captureDebug, captureLiveHost, captureOwners, releaseCapture, type RecorderModule } from "./capture";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "./worker";
import { deflateRawCompress, type SaveEnv } from "./save";
import { openCapture } from "./reader";
import { keyframeCodecForTests, statusBytes } from "./testSupport";

const BLOCK = 768;
const RATE = 48_000;
const SECOND = Math.ceil(RATE / BLOCK);
const MiB = 1024 * 1024;

/** A scheduler that runs timers only when told. */
function manualScheduler(): LiveScheduler & { fire(): void } {
  let next = 1;
  const timers = new Map<number, () => void>();
  return {
    setTimeout(fn) {
      const h = next++;
      timers.set(h, fn);
      return h;
    },
    clearTimeout(h) {
      timers.delete(h as number);
    },
    fire() {
      const all = [...timers.values()];
      timers.clear();
      for (const fn of all) fn();
    },
  };
}

/** The capture Worker's real handler behind a `CaptureWorkerLike`, answering on later macrotasks. */
function inProcessWorker(): CaptureWorkerLike {
  const w: CaptureWorkerLike & { terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.terminated) void handler.handle(copy as CaptureRequest); }, 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.terminated) w.onmessage?.({ data: copy }); }, 0);
    },
  });
  return w;
}

function rig() {
  const fb = makeFakeBackend() as FakeBackend & { frame: number };
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  fb.debug = () => ({ ...baseDebug(), time: fb.frame / RATE, sampleRate: RATE, core: { backend: "fake", currentFrame: fb.frame } });
  setAudioBackend(fb);
  const before = _setRecorderLoader(async (): Promise<RecorderModule> => {
    const m = await import("./recorder");
    return { ...m, createRecorder: (o) => m.createRecorder({ ringBytes: 8 * MiB, codec: keyframeCodecForTests(), ...o }) };
  });
  const downloads: Uint8Array[] = [];
  const env: SaveEnv = {
    tauri: false,
    storage: { save: async () => {}, list: async () => [], delete: async () => {} },
    appDataDir: async () => "/data",
    download: (bytes) => void downloads.push(bytes),
    compress: deflateRawCompress,
    now: () => new Date(2026, 10, 13, 10, 15, 0),
  };
  _setSaveEnv(env);
  const feed = (n: number): void => {
    for (let k = 0; k < n; k++) {
      fb.frame += BLOCK;
      const block = statusBytes(fb.frame);
      const data = block.slice().buffer as ArrayBuffer;
      fb.recorderTap?.(data, block.byteLength, new DataView(data));
    }
  };
  const updates: LiveFollowModel[] = [];
  const scheduler = manualScheduler();
  const follow = new LiveFollow({ host: captureLiveHost, scheduler, sourceOptions: () => ({ worker: inProcessWorker() }), onUpdate: (m) => void updates.push(m) });
  return { fb, feed, follow, downloads, restore: () => _setRecorderLoader(before) };
}

let cleanup: (() => void) | null = null;
afterEach(() => {
  releaseCapture();
  cleanup?.();
  cleanup = null;
  _setSaveEnv(null);
  setAudioBackend(null);
});

const settle = (cond: () => boolean) => vi.waitFor(() => expect(cond()).toBe(true));

describe("LiveFollow over Rc4's LiveHost", () => {
  it("opening the panel loads the recorder as a panel owner: the view follows the ring, which is no take", async () => {
    const r = rig();
    cleanup = r.restore;
    await r.follow.start();
    expect(r.follow.current.state).toBe("following");
    expect(captureOwners()).toEqual({ take: false, panels: 1 });
    expect(Audio.capture.state, "a panel's hold isn't a take").toBe("idle");
    r.feed(3 * SECOND + 5); // three segments seal
    await settle(() => r.follow.current.segments >= 3);
    expect(r.follow.current.source!.duration).toBeGreaterThan(2);
    expect(r.follow.current.error).toBeNull();
    r.follow.stop();
  });

  it("closing the panel with no take frees the ring", async () => {
    const r = rig();
    cleanup = r.restore;
    await r.follow.start();
    r.feed(SECOND + 5);
    await settle(() => r.follow.current.segments >= 1);
    r.follow.stop();
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
    expect(captureDebug()).toBeNull();
    expect(r.fb.recorderTap).toBeNull();
    expect(r.fb.profileSink).toBeNull();
  });

  it("closing the panel with a take running keeps the ring and the take, and reopening resumes the view", async () => {
    const r = rig();
    cleanup = r.restore;
    await Audio.capture.start();
    await r.follow.start();
    expect(captureOwners()).toEqual({ take: true, panels: 1 });
    r.feed(2 * SECOND + 5);
    await settle(() => r.follow.current.segments >= 2);
    r.follow.stop();
    expect(captureOwners()).toEqual({ take: true, panels: 0 });
    expect(r.fb.recorderTap, "the take still records").toBeTypeOf("function");
    r.feed(SECOND);
    await r.follow.start();
    r.feed(2 * SECOND + 5);
    await settle(() => r.follow.current.segments >= 3);
    expect(r.follow.current.state).toBe("following");
    r.follow.stop();
    await Audio.capture.save();
    const c = await openCapture(r.downloads[0]!);
    expect(c.warnings).toEqual([]);
    expect(c.keyframes.length).toBeGreaterThanOrEqual(5);
  });

  it("the take ending while the panel is open leaves the panel recording; its close then holds the ring for save", async () => {
    const r = rig();
    cleanup = r.restore;
    await Audio.capture.start();
    await r.follow.start();
    r.feed(SECOND + 5);
    Audio.capture.stop();
    expect(r.fb.recorderTap).toBeTypeOf("function");
    expect(Audio.capture.state).toBe("stopped");
    r.follow.stop();
    expect(captureDebug()).toMatchObject({ state: "held", owners: 0 });
    await expect(Audio.capture.save("after-panel")).resolves.toBe("after-panel.mycap");
  });
});
