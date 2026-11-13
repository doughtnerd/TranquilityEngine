// ADR 0171 amended by 0172 (M5, task G7b; architecture §2.1, §4.1): `capture.ts` wires the backend's keyframe source to the
// recorder and the sink's name interning, drives the keyframe cadence and the event frames of a backend with no STATUS (the
// Babylon fallback) from its audio clock, and lets go of the ring when Play stops. Backends are fakes; time is the frames the
// fake's audio clock has reached, advanced by hand (no timer, no wall clock).
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Audio } from "../Audio";
import { setAudioBackend } from "../backend";
import { AudioWorldService } from "../core/service";
import type { AudioHost } from "../core/context";
import { makeFakeBackend, type FakeBackend } from "../testing";
import { _setFramePump, _setRecorderLoader, _setSaveEnv, captureDebug, captureLiveHost, captureOwners, capturePlayStopped, NOTHING_RECORDED, releaseCapture, type RecorderModule } from "./capture";
import { EventKind, RecordType, decodeKeyframe, type KeyframePayload } from "./format";
import { decodeRecordAt, openCapture, openLiveCapture, type CaptureContents } from "./reader";
import { _resetSaveState, deflateRawCompress, type SaveEnv } from "./save";
import { SAMPLE_HEADER, SAMPLE_META, keyframeCodecForTests, statusBytes } from "./testSupport";
import { assembleCapture } from "./format";
import type { Recorder } from "./recorder";

const MiB = 1024 * 1024;
const RATE = 48_000;
const BLOCK = 768;
const SECOND = Math.ceil(RATE / BLOCK);

type Fake = FakeBackend & { frame: number; time: number };

function rig(opts: { babylon?: boolean; keyframe?: boolean } = {}) {
  const fb = makeFakeBackend() as unknown as Fake;
  fb.frame = 0;
  const baseDebug = fb.debug.bind(fb);
  // The core reports STATUS frames (`frame`, moved by `feed`); the fallback reports its audio clock (`time`, moved by `clock`).
  fb.debug = () => {
    const d = baseDebug();
    const frame = opts.babylon ? Math.floor(fb.time * RATE) : fb.frame;
    return { ...d, time: opts.babylon ? fb.time : fb.frame / RATE, sampleRate: RATE, core: { ...d.core, currentFrame: frame } };
  };
  if (opts.babylon) {
    delete (fb as { recorderTap?: unknown }).recorderTap;
    fb.mixCaps = { ...fb.mixCaps, capture: "mainSideOnly" };
  }
  const calls: { table: string; name: string }[] = [];
  let version = 0;
  if (opts.keyframe !== false) {
    (fb as { keyframe?: AudioBackendKeyframe }).keyframe = (nameId, noName = 0xffffffff) => {
      version++;
      const clip = nameId("clips", "jump.ogg");
      calls.push({ table: "clips", name: "jump.ogg" });
      return {
        voices: [{ id: 7, clip, slot: 2, state: 0, priority: 100, reason: 0, gain: 0.5, pitch: 4096, audibility: 0xffff, playheadFrames: version }],
        buses: [], metered: [], events: [{ id: 3, asset: noName, voices: 1, state: 0, paramsHash: 0 }], music: [],
        mix: { slotTableVersion: version, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: noName, masterVolume: 1, hiddenMute: 0 },
      } satisfies KeyframePayload;
    };
  }
  setAudioBackend(fb);
  const recorders: Recorder[] = [];
  _setRecorderLoader(async (): Promise<RecorderModule> => {
    const m = await import("./recorder");
    return { ...m, createRecorder: (o) => { const r = m.createRecorder({ ringBytes: 4 * MiB, ...o }); recorders.push(r); return r; } };
  });
  const downloads: { bytes: Uint8Array; fileName: string }[] = [];
  const env: SaveEnv = {
    tauri: false,
    storage: { save: async () => {}, list: async () => [], delete: async () => {} },
    appDataDir: async () => "/data/app",
    download: (bytes, fileName) => void downloads.push({ bytes, fileName }),
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
  const ringOf = (): CaptureContents => {
    const d = openLiveCapture(assembleCapture({ ...SAMPLE_HEADER, sampleRate: RATE }, SAMPLE_META, []));
    d.appendRecords(recorders[0]!.ring.copyRecords(0).bytes);
    return d.contents;
  };
  return { fb, calls, recorders, downloads, feed, ringOf };
}

type AudioBackendKeyframe = NonNullable<FakeBackend["keyframe"]>;

/** The keyframes of a decoded ring, with their frames. */
function keyframes(c: CaptureContents): { frame: number; payload: KeyframePayload }[] {
  return c.keyframes.map((i) => {
    const r = decodeRecordAt(c, i);
    if (r.kind !== "keyframe") throw new Error("not a keyframe");
    return { frame: r.frame, payload: decodeKeyframe(new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength), 0, r.payload.byteLength) };
  });
}

beforeEach(() => {
  _resetSaveState();
});

afterEach(() => {
  releaseCapture();
  _setFramePump(null);
  _setRecorderLoader(() => import("./recorder"));
  _setSaveEnv(null);
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("the backend's keyframe source reaches the recorder", () => {
  it("the first keyframe and each second's carry the backend's rows, with clip names interned through the sink (one NAMES record)", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(2 * SECOND + 2);
    const c = r.ringOf();
    const kfs = keyframes(c);
    expect(kfs.length).toBeGreaterThanOrEqual(3); // the epoch's, then one per second of rendered frames
    for (const k of kfs) {
      expect(k.payload.voices).toHaveLength(1);
      expect(k.payload.voices[0]!.id).toBe(7);
      expect(c.names.clips.get(k.payload.voices[0]!.clip)).toBe("jump.ogg");
      expect(k.payload.events[0]!.id).toBe(3);
    }
    expect(r.calls).toHaveLength(kfs.length); // the source ran once per keyframe
    let names = 0;
    for (let i = 0; i < c.records.count; i++) if (c.records.type[i] === RecordType.NAMES) names++;
    expect(names).toBe(1);
    // Rows differ between keyframes (the source is read each time, not once).
    expect(new Set(kfs.map((k) => k.payload.mix.slotTableVersion)).size).toBe(kfs.length);
  });

  it("a backend with no keyframe member leaves the empty keyframes", async () => {
    const r = rig({ keyframe: false });
    await Audio.capture.start();
    r.feed(SECOND + 2);
    const kfs = keyframes(r.ringOf());
    expect(kfs.length).toBeGreaterThanOrEqual(2);
    for (const k of kfs) expect(k.payload.voices).toHaveLength(0);
  });
});

describe("the Babylon fallback has no STATUS: its audio clock drives the frames", () => {
  it("event frames and the keyframe cadence advance with the clock the pump reports; no STATUS record is written", async () => {
    let tick: (() => void) | null = null;
    let stopped = 0;
    _setFramePump((t) => {
      tick = t;
      return () => void stopped++;
    });
    const r = rig({ babylon: true });
    await Audio.capture.start();
    expect(tick).not.toBeNull();
    const clock = (seconds: number): void => {
      r.fb.time = seconds;
      tick!();
    };
    const sink = r.fb.profileSink!;
    clock(0.5);
    sink.voiceStart(1, "a.wav", 2, 0, 0, 1);
    clock(1.25); // past the first second: a keyframe opens a segment
    sink.voiceStart(2, "b.wav", 2, 0, 0, 1);
    clock(2.5); // and again past the second
    sink.voiceStart(3, "c.wav", 2, 0, 0, 1);
    clock(2.75);
    Audio.capture.stop();
    expect(stopped).toBe(1); // Held: the pump ends with the recording
    await Audio.capture.save("b");
    const c = await openCapture(r.downloads[0]!.bytes);
    expect(c.mainSideOnly).toBe(true);
    expect(c.keyframes.length).toBe(3); // the epoch's at frame 0, one past 1 s, one past 2 s of the audio clock
    const kfFrames = keyframes(c).map((k) => k.frame);
    expect(kfFrames[0]).toBe(0);
    expect(kfFrames[1]).toBe(Math.floor(1.25 * RATE));
    expect(kfFrames[2]).toBe(Math.floor(2.5 * RATE));
    const starts: number[] = [];
    for (let i = 0; i < c.records.count; i++) {
      if (c.records.type[i] === RecordType.STATUS) throw new Error("a STATUS record in a main-side-only capture");
      const rec = decodeRecordAt(c, i);
      if (rec.kind === "event" && rec.payload.kind === EventKind.voiceStart) starts.push(rec.frame);
    }
    // Each start is stamped with the audio clock's frame as of the pump's last report: strictly later than the one before.
    expect(starts).toEqual([Math.floor(0.5 * RATE), Math.floor(1.25 * RATE), Math.floor(2.5 * RATE)]);
  });

  it("the pump stops when the ring is Held and starts again for a new take; a Held ring ignores a late tick", async () => {
    const pumps: { tick: () => void; stopped: boolean }[] = [];
    _setFramePump((t) => {
      const p = { tick: t, stopped: false };
      pumps.push(p);
      return () => void (p.stopped = true);
    });
    const r = rig({ babylon: true });
    await Audio.capture.start();
    r.fb.time = 3;
    pumps[0]!.tick();
    Audio.capture.stop();
    expect(pumps[0]!.stopped).toBe(true);
    const frames = r.recorders[0]!.newestStatusFrame;
    r.fb.time = 9;
    pumps[0]!.tick(); // a tick that raced the stop does nothing
    expect(r.recorders[0]!.newestStatusFrame).toBe(frames);
    await Audio.capture.start();
    expect(pumps).toHaveLength(2);
    expect(pumps[1]!.stopped).toBe(false);
    pumps[1]!.tick();
    expect(r.recorders[0]!.newestStatusFrame).toBe(9 * RATE);
  });

  it("the core backend runs no pump", async () => {
    const pump = vi.fn(() => () => {});
    _setFramePump(pump);
    rig();
    await Audio.capture.start();
    expect(pump).not.toHaveBeenCalled();
  });
});

describe("Play stops", () => {
  it("a panel's hold alone: the ring is freed, the tap and the sink come off, and the panel's later release does nothing", async () => {
    const r = rig();
    const panel = await captureLiveHost.join();
    expect(captureDebug()?.state).toBe("recording");
    capturePlayStopped();
    expect(captureDebug()).toBeNull();
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
    expect(r.fb.recorderTap).toBeNull();
    expect(r.fb.profileSink).toBeNull();
    expect(() => panel.release()).not.toThrow();
    expect(captureDebug()).toBeNull();
    expect(Audio.capture.state).toBe("idle");
  });

  it("a take running when Play stops is Held: its seconds and its save survive; the next Play stop frees it", async () => {
    const r = rig();
    await Audio.capture.start();
    r.feed(SECOND);
    capturePlayStopped();
    expect(captureDebug()?.state).toBe("held");
    expect(Audio.capture.state).toBe("stopped");
    expect(r.fb.recorderTap).toBeNull();
    await Audio.capture.save("kept");
    expect(r.downloads).toHaveLength(1);
    capturePlayStopped(); // the take outlived one Play stop: this one frees it
    expect(captureDebug()).toBeNull();
    expect(Audio.capture.state).toBe("idle");
    await expect(Audio.capture.save()).rejects.toThrow(NOTHING_RECORDED);
  });

  it("a take stopped before Play stops is Held the same way; a panel beside a take ends with it", async () => {
    const r = rig();
    const panel = await captureLiveHost.join();
    await Audio.capture.start();
    r.feed(2);
    Audio.capture.stop(); // the panel still holds the ring
    capturePlayStopped();
    expect(captureOwners()).toEqual({ take: false, panels: 0 });
    expect(captureDebug()?.state).toBe("held");
    panel.release(); // the panel's token is dead: it doesn't re-hold or free anything
    expect(captureDebug()?.state).toBe("held");
    await Audio.capture.save();
    expect(r.downloads).toHaveLength(1);
  });

  it("a new take after a kept one is kept again at its own Play stop", async () => {
    const r = rig();
    await Audio.capture.start();
    capturePlayStopped();
    await Audio.capture.start(); // from Held: a new take
    r.feed(2);
    capturePlayStopped();
    expect(captureDebug()?.state).toBe("held");
    await Audio.capture.save();
    expect(r.downloads).toHaveLength(1);
  });

  it("with no ring it does nothing", () => {
    rig();
    expect(() => capturePlayStopped()).not.toThrow();
    expect(captureDebug()).toBeNull();
    expect(Audio.capture.state).toBe("idle");
  });
});

describe("the audio World service lets go of the capture with the last Runtime World", () => {
  /** A host that keeps shares by owner, as `AudioHost` does for the three calls the service makes. */
  function fakeHost() {
    const shares = new Map<number, { key: number; owner: object; released: boolean }>();
    let next = 1;
    const host = {
      closed: false,
      attachWorld(owner: object) {
        const share = { key: next++, owner, released: false };
        shares.set(share.key, share);
        return share;
      },
      releaseWorld(key: number) {
        const s = shares.get(key);
        if (!s) return false;
        s.released = true;
        shares.delete(key);
        return true;
      },
      forEachWorld(fn: (key: number, owner: object) => void) {
        for (const s of shares.values()) fn(s.key, s.owner);
      },
    };
    return host as unknown as AudioHost;
  }
  const world = (kind: string) => ({ kind }) as never;

  it("the editor's World and a Runtime World still running keep the ring; the last Runtime World frees it", async () => {
    rig();
    const host = fakeHost();
    const core = { ready: true, host } as never;
    const editor = new AudioWorldService(world("editor"), core);
    const play1 = new AudioWorldService(world("runtime"), core);
    const play2 = new AudioWorldService(world("runtime"), core);
    await captureLiveHost.join();
    editor.dispose();
    play1.dispose();
    expect(captureDebug()).not.toBeNull(); // play2 is still running
    play2.dispose();
    expect(captureDebug()).toBeNull();
    play2.dispose(); // idempotent: a second dispose changes nothing
    expect(captureDebug()).toBeNull();
  });

  it("a server or editor World going alone never ends the capture", async () => {
    rig();
    const host = fakeHost();
    const core = { ready: true, host } as never;
    const server = new AudioWorldService(world("server"), core);
    await captureLiveHost.join();
    server.dispose();
    expect(captureDebug()).not.toBeNull();
  });
});
