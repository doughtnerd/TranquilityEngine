// The Babylon fallback's capture (ADR 0171 amended by 0172; api-and-models §9, §5.5, §5.6): events recorded main-side
// (voice start, stop and steal, the mixer's setters, master and hidden-tab changes) with `busRef`s, keyframes read from
// main's tables through the keyframe codec, and the real recorder on this backend, stamped by its audio clock in frames.
// No wall-clock assertion. Against the mocked AudioV2 engine, through the shared rig.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mixer } from "../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../engine/audio/settings";
import { babylonMock } from "../testing/babylonMocks";
import { babylonRig, disposeBabylonRigs, flush, playRequest } from "../testing/babylonRig";
import { Audio } from "./Audio";
import { setAudioBackend } from "./backend";
import type { BabylonBackend } from "./babylonBackend";
import { KeyframeRows } from "./audioRows";
import { releaseCapture } from "./capture/capture";
import { EventKind, RecordType, decodeKeyframe, encodeKeyframe, keyframeBytes, readCaptureKeyframe, KEYFRAME_BUS_LANES, NO_NAME } from "./capture/format";
import { decodeRecordAt, openCapture } from "./capture/reader";
import { defaultSaveEnv } from "./capture/save";
import type { CaptureChunkControl } from "./capture/testSupport";
import { NULL_PROFILE_SINK } from "./mix/profileSink";
import { recordingSink } from "./mix/recordingSink";
import { taps } from "./mix/profileTaps";

vi.mock("@babylonjs/core/AudioV2/webAudio/webAudioEngine", async () => (await import("../testing/babylonMocks")).webAudioEngineModule);
/** The save chunk is the real one, wrapped: each save goes through the test's fakes. */
const chunk = vi.hoisted((): CaptureChunkControl => ({ options: {}, recorders: [], saveEnv: null }));
vi.mock("./capture/save", async (real) => (await import("./capture/testSupport")).captureSaveModule(await real(), chunk));

describe("events and keyframes, main-side (M5a)", () => {
  const BUSES = [
    { name: "Master" },
    { name: "SFX", parent: "Master", maxVoices: 2 },
    { name: "Music", parent: "Master" },
    { name: "Voice", parent: "SFX" },
  ];
  // Slots: the mixer numbers the buses in list order.
  const SLOT = { Master: 0, SFX: 1, Music: 2, Voice: 3 } as const;

  function configure(): void {
    mixer.configure(parseAudioSettings({ buses: BUSES, snapshots: [{ name: "Quiet", volumes: { Music: 0.5 } }] }).settings);
  }

  const req = playRequest;

  function newBackend(visibility: unknown = null): BabylonBackend {
    const { backend: b } = babylonRig({ visibility: visibility as never, wire: false });
    setAudioBackend(b);
    mixer.onChange(() => b.applyMix(mixer.resolveAll()));
    return b;
  }

  beforeEach(() => {
    babylonMock.reset();
    configure();
  });
  afterEach(() => {
    setAudioBackend(null);
    disposeBabylonRigs(); // a disposed backend takes its tap off the mixer
    taps.sink = NULL_PROFILE_SINK;
    vi.restoreAllMocks();
  });

  describe("BabylonBackend events, main-side (§9 Profiler and capture, §5.6)", () => {
    it("a play reaches the sink as voiceStart with the voice's id, clip, the bus's busRef and its gain", async () => {
      const b = newBackend();
      const rec = recordingSink();
      b.setProfileSink(rec.sink);
      const v = b.play(req({ bus: "Music", volume: 0.5 }))!;
      await flush();
      expect(rec.of("voiceStart")).toEqual([[v.id, "a.wav", SLOT.Music, 0, 0, 0.5]]);
    });

    it("a voice that ends, one that is stopped, one faded out and one whose load fails stop with their reasons", async () => {
      const b = newBackend();
      const rec = recordingSink();
      b.setProfileSink(rec.sink);
      const ended = b.play(req())!;
      const stopped = b.play(req({ bus: "Music" }))!;
      const faded = b.play(req({ bus: "Music" }))!;
      babylonMock.failUrls.add("asset://bad.wav");
      const failed = b.play(req({ path: "bad.wav", url: "asset://bad.wav", bus: "Music" }))!;
      await flush();
      babylonMock.sounds[0]!.finish(); // the clip reaches its end
      stopped.stop();
      faded.stop(0.5);
      await flush();
      expect(rec.of("voiceStop")).toEqual(expect.arrayContaining([[ended.id, "ended"], [stopped.id, "stopped"], [faded.id, "faded"], [failed.id, "failed"]]));
      expect(rec.of("voiceStop")).toHaveLength(4);
    });

    it("a bus over its maxVoices reports voiceSteal (victim, thief, busMaxVoices) in place of a voiceStop for the victim", async () => {
      const b = newBackend();
      const rec = recordingSink();
      b.setProfileSink(rec.sink);
      const first = b.play(req())!;
      const second = b.play(req())!;
      await flush();
      const third = b.play(req())!;
      await flush();
      expect(rec.of("voiceSteal")).toEqual([[first.id, third.id, "busMaxVoices"]]);
      expect(rec.of("voiceStop").some((c) => c[0] === first.id)).toBe(false);
      expect(first.playing).toBe(false);
      expect(second.playing).toBe(true);
    });

    it("the mixer's setters report bus ramps with busRefs, a snapshot and a monitor change", async () => {
      const b = newBackend();
      const rec = recordingSink();
      b.setProfileSink(rec.sink);
      mixer.bus("Music").volume = 0.5;
      mixer.snapshot("Quiet", 1);
      mixer.setMonitor("SFX", { mute: true });
      expect(rec.of("busRamp").some((c) => c[0] === SLOT.Music && c[1] === "runtime" && c[3] === 0.5)).toBe(true);
      // ADR 0344 (ABI 4.8): the snapshot lane's one ramp, linear in dB, to 0.5 at the fade's end.
      expect(rec.of("busRamp").some((c) => c[0] === SLOT.Music && c[1] === "snapshot" && Math.abs((c[3] as number) - 0.5) < 1e-6)).toBe(true);
      expect(rec.of("snapshot")).toEqual([["Quiet", 1]]);
      expect(rec.of("monitor")).toEqual([[1 << SLOT.SFX]]);
    });

    it("master volume and mute, and a hidden page, report masterChange and hiddenTab", async () => {
      const visibility = Object.assign(new EventTarget(), { hidden: false });
      const b = newBackend(visibility);
      b.setBackground("mute");
      const rec = recordingSink();
      b.setProfileSink(rec.sink);
      b.masterVolume = 0.25;
      b.muted = true;
      visibility.hidden = true;
      visibility.dispatchEvent(new Event("visibilitychange"));
      visibility.hidden = false;
      visibility.dispatchEvent(new Event("visibilitychange"));
      expect(rec.of("masterChange")).toEqual([[0.25, false], [0.25, true]]);
      expect(rec.of("hiddenTab")).toEqual([[true], [false]]);
    });

    it("the page-wide taps (events, music) point at the sink, and null puts every null object back", async () => {
      const b = newBackend();
      const rec = recordingSink();
      b.setProfileSink(rec.sink);
      expect(taps.sink).toBe(rec.sink);
      b.setProfileSink(null);
      expect(taps.sink).toBe(NULL_PROFILE_SINK);
      rec.clear();
      mixer.bus("Music").volume = 0.7;
      b.masterVolume = 0.5;
      b.play(req()); // the backend's own sink: a voice's start reaches nothing
      await flush();
      expect(rec.calls).toEqual([]);
    });

    it("a disposed backend leaves the taps at the null object", () => {
      const b = newBackend();
      b.setProfileSink(recordingSink().sink);
      b.dispose();
      expect(taps.sink).toBe(NULL_PROFILE_SINK);
    });

    it("a bus added after a removal gets a slot no other bus holds", async () => {
      const b = newBackend();
      b.play(req());
      await flush();
      mixer.apply({ op: "removeBus", bus: "SFX" });
      mixer.apply({ op: "addBus", name: "Amb", parent: "Master" });
      await flush();
      // The busRef each bus's voices carry to the sink.
      const rec = recordingSink();
      b.setProfileSink(rec.sink);
      for (const bus of mixer.busNames) b.play(req({ bus }));
      await flush();
      const slots = rec.of("voiceStart").map((c) => c[2]);
      expect(slots).toHaveLength(mixer.busNames.length);
      expect(new Set(slots).size).toBe(slots.length);
    });
  });

  describe("BabylonBackend keyframes from main's tables (§9, §5.5)", () => {
    const ids = new Map<string, number>();
    const nameId = (table: string, name: string): number => {
      const key = `${table}:${name}`;
      if (!ids.has(key)) ids.set(key, ids.size + 1);
      return ids.get(key)!;
    };
    beforeEach(() => ids.clear());

    /** The keyframe as a capture records it (ADR 0249: the backend's with the rows composed above the seam), encoded and decoded. */
    function roundTrip(b: BabylonBackend): ReturnType<typeof decodeKeyframe> {
      const p = new KeyframeRows(b, b).read(nameId, NO_NAME);
      const len = keyframeBytes(p);
      const view = new DataView(new ArrayBuffer(len));
      expect(encodeKeyframe(view, 0, p)).toBe(len);
      return decodeKeyframe(view, 0, len);
    }

    it("lists the live voices, every bus's lanes, each event's voices and the mix, and encodes and decodes them", async () => {
      const b = newBackend();
      b.masterVolume = 0.5;
      b.play(req({ bus: "SFX", volume: 0.5, pitch: 2 }));
      b.play(req({ bus: "Music", path: "m.wav", url: "asset://m.wav", group: 7 }));
      await flush();
      mixer.bus("Music").mute = true;
      mixer.setMonitor("SFX", { solo: true });
      mixer.snapshot("Quiet", 0);
      mixer.update(0.1);
      const k = roundTrip(b);
      const named = readCaptureKeyframe(k);

      expect(k.voices).toHaveLength(2);
      const sfx = named.voices.find((v) => v.clip === nameId("clips", "a.wav"))!;
      expect(sfx).toMatchObject({ slot: SLOT.SFX, state: "playing", gain: 0.5, pitch: 2 });
      expect(sfx.audibility).toBeCloseTo(1, 4); // full: the fallback doesn't know audibility
      expect(k.voices.find((v) => v.clip === nameId("clips", "m.wav"))!.slot).toBe(SLOT.Music);
      expect(k.buses.map((x) => x.slot)).toEqual([0, 1, 2, 3]);
      const music = k.buses[SLOT.Music]!;
      expect(named.buses[SLOT.Music]!.runtimeMute).toBe(true);
      expect(music.lanes).toHaveLength(KEYFRAME_BUS_LANES);
      expect(music.lanes[4]).toBeCloseTo(0.5, 6); // snapshot lane value (after the 0 s snapshot's minimum ramp)
      expect(music.lanes[5]).toBeCloseTo(0.5, 6); // and its target
      expect(named.buses[SLOT.SFX]!.monitorSolo).toBe(true);
      // The backend reports each event's voices; the rows are the event runtime's (group 7 is no event instance: no row).
      expect(b.keyframe(nameId).eventVoices).toEqual(new Map([[7, 1]]));
      expect(named.events).toEqual([]);
      expect(k.metered).toEqual([]);
      expect(k.music).toEqual([]);
      expect(named.mix).toMatchObject({ monitorActive: true, masterVolume: 0.5, hiddenMute: false, snapshot: nameId("snapshots", "Quiet") });
    });

    it("an empty fallback encodes: no voices, the buses at their authored values, no snapshot", () => {
      const k = roundTrip(newBackend());
      expect(k.voices).toEqual([]);
      expect(k.buses).toHaveLength(4);
      expect(k.buses[0]!.lanes.slice(0, 2)).toEqual([1, 1]);
      expect(readCaptureKeyframe(k).mix).toMatchObject({ monitorActive: false, snapshot: null, masterVolume: 1 });
    });

    it("a removed bus drops out of the keyframe, and another bus's fade continues across the removal", async () => {
      const b = newBackend();
      b.play(req({ bus: "Voice" }));
      await flush();
      mixer.bus("Music").fadeTo(0.2, 2);
      mixer.update(0.5);
      const before = b.keyframe(nameId).buses[SLOT.Music]!;
      mixer.apply({ op: "removeBus", bus: "SFX" });
      await flush();
      const k = roundTrip(b);
      expect(k.buses.map((x) => x.slot)).toEqual([0, 2]);
      const after = k.buses.find((x) => x.slot === SLOT.Music)!;
      // The runtime lane (indices 2 and 3: value, target) is the same ramp: not snapped to its end, target unchanged.
      expect(after.lanes[3]).toBeCloseTo(0.2, 6);
      expect(after.lanes[2]).toBeCloseTo(before.lanes[2]!, 6);
      expect(after.lanes[2]).toBeGreaterThan(0.2);
      mixer.update(2);
      expect(b.keyframe(nameId).buses.find((x) => x.slot === SLOT.Music)!.lanes[2]).toBeCloseTo(0.2, 6);
    });
  });
});

describe("the real recorder (G7b)", () => {
  const RATE = 48_000;
  const BUSES = [{ name: "Master" }, { name: "SFX", parent: "Master" }, { name: "Music", parent: "Master" }];

  beforeEach(() => {
    babylonMock.reset();
    mixer.configure(parseAudioSettings({ buses: BUSES }).settings);
  });

  afterEach(() => {
    releaseCapture();
    vi.useRealTimers();
    chunk.saveEnv = null;
    setAudioBackend(null);
    disposeBabylonRigs(); // a disposed backend takes its tap off the mixer
    taps.sink = NULL_PROFILE_SINK;
    vi.restoreAllMocks();
  });

  describe("a capture on the real Babylon backend", () => {
    it("keyframes carry its voices and lanes, and events and keyframes follow the audio clock in frames", async () => {
      const { backend: b, context: ctx } = babylonRig({ wire: false });
      setAudioBackend(b);
      mixer.onChange(() => b.applyMix(mixer.resolveAll()));
      // The capture's frame pump polls every 100 ms; only intervals are faked, so the flushes' timeouts still run.
      vi.useFakeTimers({ toFake: ["setInterval", "clearInterval"] });
      const downloads: Uint8Array[] = [];
      chunk.saveEnv = ({
        tauri: false,
        fs: { mkdir: async () => {}, write: async () => {}, list: async () => [], remove: async () => {} },
        storageRoot: async () => "/data",
        download: (bytes) => void downloads.push(bytes),
        compress: defaultSaveEnv().compress,
        now: () => new Date(2026, 10, 13, 10, 15, 0),
      });
      const clock = (seconds: number): void => {
        ctx.currentTime = seconds;
        vi.advanceTimersByTime(100);
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
});
