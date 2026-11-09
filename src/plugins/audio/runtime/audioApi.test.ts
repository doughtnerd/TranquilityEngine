// A1.6 L2: one case per row of api-and-models §1 (K10). Request-shaped rows use the fake backend; handle, locked,
// clock and status rows use a real `CoreBackend` on a recording port (the rig below, copied from coreBackend.test.ts);
// the default-backend row runs the Howler backend on a mocked "howler".
import { Howl } from "howler";
import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import { Assets, Engine, GameObject, SceneManager, Time } from "../../../myco";
import * as myco from "../../../myco";
import { mixer } from "../../../engine/audio/mixer";
import { Kind, Op, readBatchHeader, readEnvelope, readFade, readRecordHead, readStop, STATUS_BUFFER_BYTES, writeStatus } from "./wire.generated";
import type { AudioHost, HostLifecycleListener } from "./core/context";
import { CoreLink, type LinkPort } from "./core/context";
import type { ClipInfo, ClipRegistry, ClipResidentListener, ClipState } from "./core/clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./core/coreBackend";
import { makeStatusBlock } from "./core/mirror";
import { _resetHandleWarningsForTests } from "./core/handle";
import { setAudioBackend } from "./backend";
import { makeFakeBackend } from "./testing";
import { Audio, AudioListener, AudioSource } from "./index";

// --- The core rig (copied from coreBackend.test.ts; not exported from there) --------------------------------------

class FakeRegistry implements ClipRegistry {
  readonly ids = new Map<string, number>();
  readonly states = new Map<number, ClipState>();
  readonly refs = new Map<number, number>();
  readonly listeners = new Map<number, ClipResidentListener[]>();
  readonly events: [number, number][] = [];
  resident: number[] = [];
  private next = 1;
  acquire(path: string): number {
    let id = this.ids.get(path);
    if (id === undefined) {
      id = this.next++;
      this.ids.set(path, id);
      this.states.set(id, "ready");
    }
    this.refs.set(id, (this.refs.get(id) ?? 0) + 1);
    return id;
  }
  release(id: number): void {
    this.refs.set(id, (this.refs.get(id) ?? 0) - 1);
  }
  state(id: number): ClipState {
    return this.states.get(id) ?? "idle";
  }
  info(id: number): ClipInfo | null {
    return { id, path: "", state: this.state(id), refs: this.refs.get(id) ?? 0, frames: 0, channels: 1, sampleRate: 48_000, format: 1, bytes: 0, failure: null };
  }
  onResident(id: number, listener: ClipResidentListener): () => void {
    const list = this.listeners.get(id) ?? [];
    list.push(listener);
    this.listeners.set(id, list);
    return () => {};
  }
  releaseWorld(): void {}
  acquireReserved(): void {}
  applyClipEvent(id: number, code: number): void {
    this.events.push([id, code]);
  }
  residentIds(): readonly number[] {
    return this.resident;
  }
  settle(id: number, state: ClipState): void {
    this.states.set(id, state);
    for (const l of this.listeners.get(id) ?? []) l(this.info(id)!);
    this.listeners.delete(id);
  }
}

function rig(options: { status?: "locked" | "running" | "failed" } = {}) {
  const sent: ArrayBuffer[] = [];
  const port: LinkPort = { onmessage: null, postMessage: (m) => sent.push(m as ArrayBuffer) };
  const link = new CoreLink(port);
  const listeners: HostLifecycleListener[] = [];
  const state = { status: options.status ?? "running", worlds: 1 };
  const host: CoreBackendHost = {
    link,
    get status() {
      return state.status;
    },
    preset: { maxLogical: 16 },
    get worldCount() {
      return state.worlds;
    },
    sampleRate: 48_000,
    addLifecycleListener: ((l: HostLifecycleListener) => {
      listeners.push(l);
      return () => void listeners.splice(listeners.indexOf(l), 1);
    }) as AudioHost["addLifecycleListener"],
  };
  const clock = fakeClock();
  const clips = new FakeRegistry();
  // The global mixer, so `Audio.bus(name)` and the core's voice counts are the same buses.
  const backend = new CoreBackend(host, { clips, clock, mixer });
  /** Batches posted since the last call, as record lists. */
  const batches = () => {
    const out: ReturnType<typeof decode>[] = [];
    for (const m of sent.splice(0)) if (readEnvelope(new DataView(m), 0).kind === Kind.BATCH) { out.push(decode(m)); link.batchPool.release(m); } // the shell would recycle it; the decoded views are read before the next flush
    return out;
  };
  const ops = () => batches().flatMap((b) => b.records);
  const status = (fields: Parameters<typeof makeStatusBlock>[0]) => {
    const buffer = new ArrayBuffer(STATUS_BUFFER_BYTES);
    writeStatus(new DataView(buffer), 0, makeStatusBlock(fields), 1);
    link.handleMessage(buffer);
  };
  const frame = () => {
    clock.advance(16);
    backend.update(0.016);
  };
  return { backend, link, sent, batches, ops, state, clock, mixer, clips, listeners, status, frame };
}

function decode(buffer: ArrayBuffer) {
  const view = new DataView(buffer);
  const header = readBatchHeader(view, 0);
  const records: { op: number; voiceId: number; frameOffset: number; off: number; view: DataView }[] = [];
  let off = 32;
  for (let i = 0; i < header.count; i++) {
    const head = readRecordHead(view, off);
    records.push({ op: head.opcode, voiceId: head.voiceId, frameOffset: head.frameOffset, off, view });
    off += head.words * 4;
  }
  return { header, records };
}

/** A tiny fake HostClock: the context clock advances with rAF time. */
function fakeClock() {
  let raf = 1000;
  let ctx = 0;
  let date = 1_000_000;
  return {
    rafTime: () => raf,
    outputTimestamp: () => ({ contextTime: ctx, performanceTime: raf }),
    currentTime: () => ctx,
    dateNow: () => date,
    fake: true as const,
    advance(ms: number) {
      raf += ms;
      date += ms;
      ctx += ms / 1000;
    },
  };
}

/** Sets the core rig as the page's backend, with the first BUS_CONFIG and BUS_MIX already sent. */
function useCore(status?: "locked" | "running" | "failed") {
  const r = rig({ status });
  setAudioBackend(r.backend);
  r.frame();
  r.ops();
  return r;
}

// --- Setup ----------------------------------------------------------------------------------------------------------

const fake = makeFakeBackend();
let warn: MockInstance<typeof console.warn>;

/** Console warnings that mention `needle`, as text. */
const warnings = (needle: string) => warn.mock.calls.map((c) => String(c[0])).filter((m) => m.includes(needle));

beforeEach(async () => {
  fake.clear();
  fake.ready = true;
  setAudioBackend(fake);
  _resetHandleWarningsForTests();
  warn = vi.spyOn(console, "warn").mockImplementation(() => {});
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, "a.wav": "data:audio/wav;base64,AAAA", "bad.wav": "data:audio/wav;base64,AAAA" }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "Music", parent: "Master" }] } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Audio public surface (api-and-models §1)", () => {
  describe("playOneShot", () => {
    it("returns an AudioHandle; a bare number is the volume", () => {
      const h = Audio.playOneShot("asset:a.wav", 0.5);
      expect(typeof h.stop).toBe("function");
      expect(typeof h.fade).toBe("function");
      expect(h.playing).toBe(true);
      expect(fake.plays.at(-1)).toMatchObject({ path: "a.wav", volume: 0.5 });
      Audio.playOneShot("asset:a.wav");
      expect(fake.plays.at(-1)).toMatchObject({ volume: 1 });
    });

    it("never throws: unknown clip, undefined options, NaN and Infinity values, a null-returning backend", () => {
      expect(() => Audio.playOneShot("asset:nope.wav")).not.toThrow();
      expect(() => Audio.playOneShot("asset:a.wav", undefined)).not.toThrow();
      let h = Audio.playOneShot("asset:a.wav", {
        volume: NaN, pitch: Infinity, priority: NaN, minDistance: NaN, maxDistance: -Infinity, position: { x: NaN, y: 0, z: 0 }, at: NaN,
      });
      expect(typeof h.playing).toBe("boolean");
      fake.ready = false;
      expect(() => { h = Audio.playOneShot("asset:a.wav", { volume: Infinity, pitch: NaN }); }).not.toThrow();
      expect(h.playing).toBe(false);
    });

    it("a refused play (backend.play returns null) gives an inert handle: playing false, reason null, stop and fade are no-ops", () => {
      fake.ready = false;
      const h = Audio.playOneShot("asset:a.wav", { volume: 0.5 });
      expect(h.playing).toBe(false);
      expect(h.reason).toBeNull();
      expect(() => {
        h.stop(0.5);
        h.fade(2, 1);
        h.stop();
      }).not.toThrow();
      expect(fake.voices).toHaveLength(0);
      expect(h.playing).toBe(false);
      expect(h.reason).toBeNull();
    });

    it("passes volume, pitch, priority, bus, position and attenuation to the backend request, with oneShot true", () => {
      Audio.playOneShot("asset:a.wav", { volume: 0.5, pitch: 2, priority: 200, bus: "Music", position: { x: 1, y: 2, z: 3 }, minDistance: 2, maxDistance: 50 });
      expect(fake.plays.at(-1)).toMatchObject({
        path: "a.wav",
        bus: "Music",
        volume: 0.5,
        pitch: 2,
        priority: 200,
        oneShot: true,
        position: { x: 1, y: 2, z: 3 },
        attenuation: { minDistance: 2, maxDistance: 50 },
      });
    });

    it("defaults: volume 1, pitch 1, priority 128, minDistance 1, maxDistance 100, flat without position", () => {
      Audio.playOneShot("asset:a.wav");
      const flat = fake.plays.at(-1)!;
      expect(flat).toMatchObject({ volume: 1, pitch: 1, priority: 128, bus: "Master", oneShot: true });
      expect(flat.position).toBeUndefined();
      expect(flat.attenuation).toBeUndefined();
      Audio.playOneShot("asset:a.wav", { position: { x: 0, y: 0, z: 0 } });
      expect(fake.plays.at(-1)!.attenuation).toMatchObject({ minDistance: 1, maxDistance: 100 });
    });

    it("pitch is clamped to 0.0625..16 and warns once", () => {
      Audio.playOneShot("asset:a.wav", { pitch: 100 });
      expect(fake.plays.at(-1)!.pitch).toBe(16);
      Audio.playOneShot("asset:a.wav", { pitch: 0 });
      expect(fake.plays.at(-1)!.pitch).toBe(0.0625);
      expect(warnings("pitch")).toHaveLength(1);
    });

    it("priority is clamped to 0..255", () => {
      Audio.playOneShot("asset:a.wav", { priority: 300 });
      expect(fake.plays.at(-1)!.priority).toBe(255);
      Audio.playOneShot("asset:a.wav", { priority: -5 });
      expect(fake.plays.at(-1)!.priority).toBe(0);
      expect(warnings("priority").length).toBeGreaterThanOrEqual(1);
    });

    it("an unknown bus plays on Master and warns once (the mixer's warning)", () => {
      Audio.playOneShot("asset:a.wav", { bus: "NoSuchBus" });
      Audio.playOneShot("asset:a.wav", { bus: "NoSuchBus" });
      expect(fake.plays.at(-2)!.bus).toBe("Master");
      expect(fake.plays.at(-1)!.bus).toBe("Master");
      expect(warnings("NoSuchBus")).toHaveLength(1);
    });

    it("at: a finite time reaches the request; non-finite warns once and plays now (request.at undefined)", () => {
      Audio.playOneShot("asset:a.wav", { at: 2.5 });
      expect(fake.plays.at(-1)!.at).toBe(2.5);
      Audio.playOneShot("asset:a.wav", { at: NaN });
      expect(fake.plays.at(-1)!.at).toBeUndefined();
      Audio.playOneShot("asset:a.wav", { at: Infinity });
      expect(fake.plays.at(-1)!.at).toBeUndefined();
      expect(warnings("at").length).toBeGreaterThanOrEqual(1);
    });

    it("at is ignored while Audio.status is locked", () => {
      const locked = Object.assign(makeFakeBackend(), { status: "locked" as const });
      setAudioBackend(locked);
      expect(Audio.status).toBe("locked");
      Audio.playOneShot("asset:a.wav", { at: 5 });
      expect(locked.plays.at(-1)).toBeDefined();
      expect(locked.plays.at(-1)!.at).toBeUndefined();
    });

    it("a negative or non-finite volume is clamped and warns once", () => {
      Audio.playOneShot("asset:a.wav", { volume: -1 });
      expect(fake.plays.at(-1)!.volume).toBe(0);
      Audio.playOneShot("asset:a.wav", { volume: NaN });
      const clamped = fake.plays.at(-1)!.volume!;
      expect(Number.isFinite(clamped)).toBe(true);
      expect(clamped).toBeGreaterThanOrEqual(0);
      expect(warnings("volume").length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("AudioHandle", () => {
    it("playing is true right after playOneShot", () => {
      useCore();
      const h = Audio.playOneShot("asset:a.wav");
      expect(h.playing).toBe(true);
      expect(h.reason).toBeNull();
    });

    it("stop() ends it at once; a second stop is a no-op", () => {
      const r = useCore();
      const h = Audio.playOneShot("asset:a.wav");
      r.frame();
      r.ops();
      h.stop();
      expect(h.playing).toBe(false);
      r.frame();
      expect(r.ops().filter((o) => o.op === Op.STOP)).toHaveLength(1);
      h.stop();
      r.frame();
      expect(r.ops().filter((o) => o.op === Op.STOP)).toHaveLength(0);
    });

    it("stop(fadeSeconds) fades then stops", () => {
      const r = useCore();
      const h = Audio.playOneShot("asset:a.wav");
      r.frame();
      r.ops();
      h.stop(0.5);
      expect(h.playing).toBe(false);
      r.frame();
      const stop = r.ops().find((o) => o.op === Op.STOP)!;
      expect(readStop(stop.view, stop.off)).toMatchObject({ fadeFrames: 24_000 });
    });

    it("fade(to, seconds) eases the voice gain; to is clamped to 0..4", () => {
      const r = useCore();
      const h = Audio.playOneShot("asset:a.wav");
      r.frame();
      r.ops();
      h.fade(0.25, 0.5);
      r.frame();
      const first = r.ops().find((o) => o.op === Op.FADE)!;
      expect(readFade(first.view, first.off)).toMatchObject({ frames: 24_000 });
      expect(readFade(first.view, first.off).target).toBeCloseTo(0.25);

      h.fade(9, 0);
      r.frame();
      const high = r.ops().find((o) => o.op === Op.FADE)!;
      expect(readFade(high.view, high.off).target).toBeCloseTo(4);
      expect(warnings("fade").length).toBeGreaterThanOrEqual(1);

      h.fade(-2, 0);
      r.frame();
      const low = r.ops().find((o) => o.op === Op.FADE)!;
      expect(readFade(low.view, low.off).target).toBeCloseTo(0);
    });

    it("after the voice ends or its slot is reused every call is a no-op and playing is false", () => {
      const r = useCore();
      const h1 = Audio.playOneShot("asset:a.wav");
      r.frame();
      const play = r.ops().find((o) => o.op === Op.PLAY)!;
      r.status({ ended: [play.voiceId] });
      expect(h1.playing).toBe(false);
      r.frame();
      expect(h1.playing).toBe(false);
      expect(h1.reason).toBeNull();

      const h2 = Audio.playOneShot("asset:a.wav");
      r.frame();
      r.ops();
      expect(h2.playing).toBe(true);
      h1.stop(0.5);
      h1.fade(2, 1);
      r.frame();
      expect(r.ops().filter((o) => o.op === Op.STOP || o.op === Op.FADE)).toHaveLength(0);
      expect(h2.playing).toBe(true);
    });

    it("reason is null while audible, and 'stolen' or 'failed' after an early end", () => {
      const r = useCore();
      const audible = Audio.playOneShot("asset:a.wav");
      expect(audible.reason).toBeNull();

      const id = r.clips.acquire("bad.wav");
      r.clips.states.set(id, "decoding");
      const failing = Audio.playOneShot("asset:bad.wav");
      expect(failing.reason).toBe("waitingForData");
      r.clips.settle(id, "failed");
      expect(failing.playing).toBe(false);
      expect(failing.reason).toBe("failed");

      // Sixteen logical voices fill the core's table; a higher-priority play takes the lowest one.
      const lows = Array.from({ length: 16 }, () => Audio.playOneShot("asset:a.wav", { priority: 10 }));
      const high = Audio.playOneShot("asset:a.wav", { priority: 200 });
      expect(high.playing).toBe(true);
      const stolen = lows.filter((h) => h.reason === "stolen");
      expect(stolen).toHaveLength(1);
      expect(stolen[0]!.playing).toBe(false);
    });

    it("a locked sound reads playing true with reason 'locked'", () => {
      useCore("locked");
      expect(Audio.status).toBe("locked");
      const h = Audio.playOneShot("asset:a.wav");
      expect(h.playing).toBe(true);
      expect(h.reason).toBe("locked");
    });
  });

  describe("bus, buses, snapshot, clearSnapshot", () => {
    it("bus(name) returns the mixer bus; buses lists the names", () => {
      expect(Audio.buses).toEqual(["Master", "Music"]);
      Audio.bus("Music").volume = 0.25;
      expect(Audio.bus("Music").volume).toBe(0.25);
      expect(Audio.bus("Music").effectiveGain).toBeCloseTo(0.25);
    });

    it("snapshot and clearSnapshot default to a 0.5 s fade", () => {
      const snapshot = vi.spyOn(mixer, "snapshot").mockImplementation(() => {});
      const clear = vi.spyOn(mixer, "clearSnapshot").mockImplementation(() => {});
      Audio.snapshot("Muffled");
      expect(snapshot).toHaveBeenCalledWith("Muffled", 0.5);
      Audio.clearSnapshot();
      expect(clear).toHaveBeenCalledWith(0.5);
    });
  });

  describe("volume, masterVolume, muted", () => {
    it("volume and masterVolume are the same property", () => {
      Audio.volume = 0.3;
      expect(Audio.masterVolume).toBe(0.3);
      Audio.masterVolume = 0.6;
      expect(Audio.volume).toBe(0.6);
    });

    it("masterVolume is clamped 0..1 by the backend", () => {
      useCore();
      Audio.masterVolume = 3;
      expect(Audio.masterVolume).toBe(1);
      Audio.volume = -1;
      expect(Audio.volume).toBe(0);
    });

    it("muted is readable and reads back what was set", () => {
      expect(Audio.muted).toBe(false);
      Audio.muted = true;
      expect(Audio.muted).toBe(true);
      expect(fake.muted).toBe(true);
      Audio.muted = false;
      expect(Audio.muted).toBe(false);
    });
  });

  describe("time, status, debug", () => {
    it("time is 0 before the context runs and does not move with Time.scale", () => {
      const r = rig();
      setAudioBackend(r.backend);
      expect(Audio.time).toBe(0);
      r.status({ currentFrame: 48_000, dateMs: 1_001_000 });
      r.frame();
      const before = Audio.time;
      expect(before).toBeGreaterThan(0);
      Time.timeScale = 0;
      r.status({ currentFrame: 96_000, dateMs: 1_002_000 });
      r.frame();
      expect(Audio.time).toBeGreaterThan(before);
    });

    it("status reflects the backend: locked, running, failed", () => {
      const r = useCore("running");
      expect(Audio.status).toBe("running");
      r.state.status = "locked";
      expect(Audio.status).toBe("locked");
      r.state.status = "failed";
      expect(Audio.status).toBe("failed");
    });

    it("debug() returns a copy: mutating it changes nothing, and two calls give different objects", () => {
      useCore();
      const a = Audio.debug();
      const b = Audio.debug();
      expect(a).not.toBe(b);
      a.status = "failed";
      a.counters.traps = 99;
      const again = Audio.debug();
      expect(again.status).toBe("running");
      expect(again.counters.traps).not.toBe(99);
    });

    it("debug() delegates to backend.debug()", () => {
      const r = useCore();
      const spy = vi.spyOn(r.backend, "debug");
      const info = Audio.debug();
      expect(spy).toHaveBeenCalledTimes(1);
      expect(info).toEqual(spy.mock.results[0]!.value);
    });

    it("the default backend gives status running, handle reason null and a debug with an empty voice list", () => {
      // Unset the test backend: the next audioBackend() builds the default (Howler) one.
      setAudioBackend(null);
      // The setup may have loaded the real Howler before this file's mock applied, so stand in for what it needs.
      vi.spyOn(Howl.prototype, "playing").mockReturnValue(true);
      expect(Audio.status).toBe("running");
      const h = Audio.playOneShot("asset:a.wav");
      expect(h.playing).toBe(true);
      expect(h.reason).toBeNull();
      expect(Audio.debug().voices).toEqual([]);
    });
  });

  describe("Bus.peak", () => {
    it("is declared and returns 0 (until A2.3), also for an unknown bus", () => {
      expect(Audio.bus("Music").peak).toBe(0);
      expect(Audio.bus("NoSuchBus").peak).toBe(0);
    });

    it("Bus.activeVoices still counts every live voice on the bus", () => {
      useCore();
      const music = Audio.bus("Music");
      const before = music.activeVoices;
      // More plays than the sixteen logical voices: every live one (virtual, paused or audible) counts on the bus.
      const handles = Array.from({ length: 20 }, () => Audio.playOneShot("asset:a.wav", { bus: "Music" }));
      const playing = handles.filter((h) => h.playing).length;
      expect(playing).toBeGreaterThan(0);
      expect(music.activeVoices).toBe(before + playing);
    });
  });

  describe("AudioSource", () => {
    it("isPlaying keeps its meaning", () => {
      const src = GameObject.create("m").addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false });
      expect(src.isPlaying).toBe(false);
      src.play();
      expect(src.isPlaying).toBe(true);
      fake.voices.at(-1)!.end();
      expect(src.isPlaying).toBe(false);
    });

    it("priority defaults to 128 and an old scene without it loads as 128", async () => {
      const fresh = GameObject.create("p").addBehavior(AudioSource, { clip: "asset:a.wav", playOnAwake: false });
      expect(fresh.priority).toBe(128);
      Assets.addSource(
        Assets.fromObject({
          "old.json": {
            format: "myco.scene@2",
            nodes: [{ id: "m", name: "Music", transform: false, components: [{ type: "engine.AudioSource", data: { clip: "asset:a.wav", loop: true } }] }],
          },
        }),
      );
      await SceneManager.load("old.json");
      expect(GameObject.findObjectOfType(AudioSource)!.priority).toBe(128);
    });
  });

  describe("exports from src/myco.ts", () => {
    it("Audio, AudioSource, AudioListener are exported", () => {
      expect(myco.Audio).toBe(Audio);
      expect(myco.AudioSource).toBe(AudioSource);
      expect(myco.AudioListener).toBe(AudioListener);
    });

    it("the public types compile: AudioHandle, AudioStatus, AudioReason, AudioDebugInfo, OneShotOptions, Rolloff, Bus", () => {
      type Types = [myco.AudioHandle, myco.AudioStatus, myco.AudioReason, myco.AudioDebugInfo, myco.OneShotOptions, myco.Rolloff, myco.Bus];
      const probe: Types | null = null;
      expect(probe).toBeNull();
    });
  });
});
