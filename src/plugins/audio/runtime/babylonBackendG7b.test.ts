// ADR 0171 amended by 0172 (M5, task G7b; api-and-models §9, §5.5): the real Babylon backend (against the mocked AudioV2 engine)
// under the real recorder. The fallback has no STATUS, so its audio clock in frames (`debug().core.currentFrame`, and `time` at
// the context's rate) is what stamps events and drives the keyframe cadence; the keyframes carry its voices and bus lanes with
// the clip names interned through the sink. No wall-clock assertion: the fake context's clock is moved by hand and the pump is
// ticked by hand.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock, makeFakeContext } from "../testing/babylonMocks";
import { Audio } from "./Audio";
import { setAudioBackend } from "./backend";
import { BabylonBackend } from "./babylonBackend";
import { _setFramePump, _setSaveEnv, releaseCapture } from "./capture/capture";
import { EventKind, RecordType, decodeKeyframe } from "./capture/format";
import { decodeRecordAt, openCapture } from "./capture/reader";
import { _resetSaveState, deflateRawCompress } from "./capture/save";
import { NULL_PROFILE_SINK } from "./mix/profileSink";
import { taps } from "./mix/profileTaps";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);

const RATE = 48_000;
const BUSES = [{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }];

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await new Promise<void>((r) => setTimeout(r, 0));
};

const made: BabylonBackend[] = [];

beforeEach(() => {
  babylonMock.reset();
  _resetSaveState();
  mixer.configure(parseAudioSettings({ buses: BUSES }).settings);
});

afterEach(() => {
  releaseCapture();
  _setFramePump(null);
  _setSaveEnv(null);
  setAudioBackend(null);
  for (const b of made.splice(0)) b.dispose();
  mixer._setTap(null);
  taps.sink = NULL_PROFILE_SINK;
  vi.restoreAllMocks();
});

describe("a capture on the real Babylon backend", () => {
  it("keyframes carry its voices and lanes, and events and keyframes follow the audio clock in frames", async () => {
    const ctx = makeFakeContext("running");
    const b = new BabylonBackend({ createContext: () => ctx as unknown as AudioContext, unlockTarget: new EventTarget(), hostContext: () => null, visibility: null as never });
    made.push(b);
    setAudioBackend(b);
    mixer.onChange(() => b.applyMix(mixer.resolveAll()));
    let tick: (() => void) | null = null;
    _setFramePump((t) => {
      tick = t;
      return () => {};
    });
    const downloads: Uint8Array[] = [];
    _setSaveEnv({
      tauri: false,
      storage: { save: async () => {}, list: async () => [], delete: async () => {} },
      appDataDir: async () => "/data",
      download: (bytes) => void downloads.push(bytes),
      compress: deflateRawCompress,
      now: () => new Date(2026, 10, 13, 10, 15, 0),
    });
    const clock = (seconds: number): void => {
      ctx.currentTime = seconds;
      tick!();
    };

    // The engine exists once a sound plays; its clock is the context's.
    const first = b.play({ path: "a.wav", url: "asset://a.wav", loop: true, stream: false, bus: "SFX", volume: 0.5 })!;
    await flush();
    expect(b.debug().core.currentFrame).toBe(0);
    ctx.currentTime = 4; // the page has been running: the capture begins at the clock's frame, not at 0
    expect(b.debug().core.currentFrame).toBe(4 * RATE);
    await Audio.capture.start();
    mixer.bus("Music").volume = 0.5;
    clock(4.5);
    const second = b.play({ path: "b.wav", url: "asset://b.wav", loop: true, stream: false, bus: "Music" })!;
    await flush();
    clock(5.25); // one second of the audio clock past the capture's first keyframe: the next one
    clock(6.5);
    Audio.capture.stop();
    await Audio.capture.save();

    const c = await openCapture(downloads[0]!);
    expect(c.mainSideOnly).toBe(true);
    const kfs = c.keyframes.map((i) => {
      const r = decodeRecordAt(c, i);
      if (r.kind !== "keyframe") throw new Error("not a keyframe");
      return { frame: r.frame, p: decodeKeyframe(new DataView(r.payload.buffer, r.payload.byteOffset, r.payload.byteLength), 0, r.payload.byteLength) };
    });
    expect(kfs.map((k) => k.frame)).toEqual([4 * RATE, Math.floor(5.25 * RATE), Math.floor(6.5 * RATE)]);
    // The first keyframe has the one voice that was playing; later ones both. Rows name their clips through NAMES.
    expect(kfs[0]!.p.voices.map((v) => c.names.clips.get(v.clip))).toEqual(["a.wav"]);
    expect(kfs[2]!.p.voices.map((v) => c.names.clips.get(v.clip)).sort()).toEqual(["a.wav", "b.wav"]);
    expect(kfs[2]!.p.voices.find((v) => v.id === second.id)!.gain).toBe(1);
    expect(kfs[2]!.p.voices.find((v) => v.id === first.id)!.gain).toBe(0.5);
    const music = kfs[2]!.p.buses.find((x) => x.slot === 2)!;
    expect(music.lanes[2]).toBeCloseTo(0.5, 5); // the runtime lane's value
    // The events carry the frames the clock had reached, in order.
    const starts: number[] = [];
    for (let i = 0; i < c.records.count; i++) {
      expect(c.records.type[i]).not.toBe(RecordType.STATUS);
      const rec = decodeRecordAt(c, i);
      if (rec.kind === "event" && rec.payload.kind === EventKind.voiceStart) starts.push(rec.frame);
    }
    expect(starts).toEqual([4.5 * RATE]);
  });
});
