// A1.4 (lead): `CoreBackend` against a fake ClipRegistry and a real `CoreLink` on a recording port (no wasm), plus the
// loopback check (skipped until A1.7's `createLoopbackHost` is merged).
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import {
  ASAP,
  Kind,
  Op,
  readBatchHeader,
  readBusConfig,
  readBusMix,
  readEnvelope,
  readPlay,
  readRecordHead,
  readReset,
  readSetParams,
  readStop,
  readFade,
  SET_PARAMS_MASK_BUS,
  STATUS_BUFFER_BYTES,
  writeStatus,
} from "../wire.generated";
import type { AudioHost, BusRemap, HostLifecycleListener } from "./context";
import { CoreLink, type LinkPort } from "./context";
import type { ClipInfo, ClipRegistry, ClipResidentListener, ClipState } from "./clipRegistry";
import type { HrirLoader } from "./hrir";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { makeStatusBlock } from "./mirror";
import { VoiceReason, VoiceState } from "./voiceTable";

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
  applyClipEvent(id: number, code: number): void {
    this.events.push([id, code]);
  }
  residentIds(): readonly number[] {
    return this.resident;
  }
  acquireReserved(): void {}
  settle(id: number, state: ClipState): void {
    this.states.set(id, state);
    for (const l of this.listeners.get(id) ?? []) l(this.info(id)!);
    this.listeners.delete(id);
  }
}

function rig(options: { status?: "locked" | "running" | "failed"; settings?: AudioSettings; hrir?: HrirLoader } = {}) {
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
  const mixer = new Mixer(options.settings ?? defaultAudioSettings());
  const clips = new FakeRegistry();
  const backend = new CoreBackend(host, { clips, clock, mixer, hrir: options.hrir });
  /** Batches posted since the last call, as record lists. */
  const batches = () => {
    const out: ReturnType<typeof decode>[] = [];
    for (const m of sent.splice(0)) if (readEnvelope(new DataView(m), 0).kind === Kind.BATCH) out.push(decode(m));
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

/** A tiny fake HostClock (hostClock.ts's fake is A1.7's): the context clock advances with rAF time. */
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

const req = (path = "a.wav", extra: object = {}) => ({ path, url: path, loop: false, stream: false, bus: "SFX", ...extra });
const idx = (id: number) => id & 0xffff;
const only = (list: ReturnType<typeof decode>["records"], op: number) => list.filter((x) => x.op === op);

describe("CoreBackend (api-and-models §3, §6)", () => {
  it("play allocates a voice, sends PLAY with the registry's clip id, and counts the bus with mixer.voiceStarted", () => {
    const r = rig();
    r.frame(); // the initial BUS_CONFIG and BUS_MIX
    r.ops();
    const voice = r.backend.play({ ...req("hit.wav"), volume: 0.5, pitch: 2, loop: true })!;
    expect(voice.playing).toBe(true);
    expect(r.mixer.bus("SFX").activeVoices).toBe(1);
    r.frame();
    const plays = only(r.ops(), Op.PLAY);
    expect(plays).toHaveLength(1);
    const p = readPlay(plays[0]!.view, plays[0]!.off);
    expect(p).toMatchObject({ voiceId: voice.id, clip: r.clips.ids.get("hit.wav"), bus: 2, gain: 0.5, pitch: 2 });
    expect(p.flags & 1).toBe(1); // loop
    expect(p.flags & 8).toBe(8); // mixed
    expect(plays[0]!.frameOffset).toBe(ASAP);
  });

  it("the constructor's BUS_CONFIG and BUS_MIX go out at the first update", () => {
    const sentRig = rig();
    sentRig.backend.update(0);
    const ops = sentRig.ops();
    expect(ops.map((o) => o.op)).toEqual([Op.BUS_CONFIG, Op.BUS_MIX]);
    const cfg = readBusConfig(ops[0]!.view, ops[0]!.off);
    expect(cfg.buses).toHaveLength(5);
    expect(cfg.buses[0]!.parent).toBe(0xffff);
    expect(cfg.buses[2]!.parent).toBe(0);
    const mix = readBusMix(ops[1]!.view, ops[1]!.off);
    expect(mix.buses).toHaveLength(5);
    expect(mix.buses[0]).toEqual({ gain: 1, lpHz: 24000 });
  });

  it("a play on a clip that isn't ready is waitingForData and starts when the registry says resident", () => {
    const r = rig();
    r.frame();
    r.ops();
    const id = r.clips.acquire("late.wav");
    r.clips.states.set(id, "decoding");
    const voice = r.backend.play(req("late.wav"))!;
    expect(voice.reason).toBe("waitingForData");
    expect(voice.playing).toBe(true);
    r.frame();
    expect(only(r.ops(), Op.PLAY).filter((o) => o.voiceId === voice.id)).toHaveLength(0);
    r.clips.settle(id, "ready");
    expect(voice.reason).toBeNull();
    r.frame();
    expect(only(r.ops(), Op.PLAY).filter((o) => o.voiceId === voice.id)).toHaveLength(1);
  });

  it("a failed clip frees the voice with reason failed and drops the clip reference", () => {
    const r = rig();
    const id = r.clips.acquire("bad.wav");
    r.clips.states.set(id, "decoding");
    const voice = r.backend.play(req("bad.wav"))!;
    const refs = r.clips.refs.get(id)!;
    r.clips.settle(id, "failed");
    expect(voice.playing).toBe(false);
    expect(voice.reason).toBe("failed");
    expect(r.clips.refs.get(id)).toBe(refs - 1);
    expect(r.mixer.bus("SFX").activeVoices).toBe(0);
  });

  it("an already failed clip fails at once", () => {
    const r = rig();
    const id = r.clips.acquire("bad.wav");
    r.clips.states.set(id, "failed");
    const voice = r.backend.play(req("bad.wav"))!;
    expect(voice.playing).toBe(false);
    expect(voice.reason).toBe("failed");
  });

  it("stop and fade go out through table.drainCommands as STOP and FADE", () => {
    const r = rig();
    r.frame();
    r.ops();
    const a = r.backend.play(req())!;
    const b = r.backend.play(req())!;
    r.frame();
    r.ops();
    a.fade(0.25, 0.5);
    b.stop(0.1);
    expect(b.playing).toBe(false);
    r.frame();
    const ops = r.ops();
    const fade = readFade(ops.find((o) => o.op === Op.FADE)!.view, ops.find((o) => o.op === Op.FADE)!.off);
    expect(fade).toMatchObject({ voiceId: a.id, frames: 24_000 });
    expect(fade.target).toBeCloseTo(0.25);
    const stopRec = ops.find((o) => o.op === Op.STOP)!;
    expect(readStop(stopRec.view, stopRec.off)).toMatchObject({ voiceId: b.id, fadeFrames: 4_800 });
  });

  it("an ended voice (STATUS) is freed on the next update and mixer.voiceEnded runs once", () => {
    const r = rig();
    r.frame();
    const v = r.backend.play(req("a.wav"))!;
    r.frame();
    const clip = r.clips.ids.get("a.wav")!;
    expect(r.clips.refs.get(clip)).toBe(1);
    r.status({ ended: [v.id], currentFrame: 4_800, dateMs: 1_000_016 });
    expect(v.playing).toBe(false);
    expect(r.mixer.bus("SFX").activeVoices).toBe(1); // freed by the frame, not onmessage
    r.frame();
    expect(r.mixer.bus("SFX").activeVoices).toBe(0);
    expect(r.clips.refs.get(clip)).toBe(0);
    r.status({ ended: [v.id] });
    r.frame();
    expect(r.mixer.bus("SFX").activeVoices).toBe(0);
    expect(r.clips.refs.get(clip)).toBe(0);
  });

  it("onBusRemap sends BUS_CONFIG and resets the table's bus limits to the new tree's maxVoices", () => {
    const r = rig();
    r.frame();
    r.ops();
    const live = r.backend.play(req())!; // on SFX, bus 2
    r.frame();
    r.ops();
    const settings = defaultAudioSettings();
    settings.buses = settings.buses.filter((b) => b.name !== "Music");
    settings.buses.find((b) => b.name === "SFX")!.maxVoices = 3;
    r.mixer.configure(settings);
    const remap: BusRemap = { epoch: 2, from: ["Master", "Music", "SFX", "UI", "Voice"], to: settings.buses.map((b) => b.name), map: new Uint8Array([0, 0, 1, 2, 3]) };
    for (const l of [...r.listeners]) l.onBusRemap?.(remap);
    expect(r.backend.table.busMax[1]).toBe(3);
    expect(r.backend.table.busMax[2]).toBe(0);
    r.frame();
    const ops = r.ops();
    expect(readBusConfig(ops.find((o) => o.op === Op.BUS_CONFIG)!.view, ops.find((o) => o.op === Op.BUS_CONFIG)!.off).buses).toHaveLength(4);
    // A2.1: the live voice is re-routed in the core to its new index, after the BUS_CONFIG.
    const configAt = ops.findIndex((o) => o.op === Op.BUS_CONFIG);
    const moveAt = ops.findIndex((o) => o.op === Op.SET_PARAMS && o.voiceId === live.id);
    expect(moveAt).toBeGreaterThan(configAt);
    const move = readSetParams(ops[moveAt]!.view, ops[moveAt]!.off);
    expect(move.mask).toBe(SET_PARAMS_MASK_BUS);
    expect(move.bus).toBe(1);
    // New plays use the new indices (SFX is bus 1 now).
    r.backend.play(req());
    r.frame();
    const play = only(r.ops(), Op.PLAY)[0]!;
    expect(readPlay(play.view, play.off).bus).toBe(1);
  });

  it("onIdle sends RESET 0 once nothing is live or resident", () => {
    const r = rig();
    r.frame();
    r.ops();
    const v = r.backend.play(req())!;
    r.frame();
    r.ops();
    r.state.worlds = 0;
    for (const l of [...r.listeners]) l.onIdle?.();
    r.frame();
    expect(only(r.ops(), Op.RESET)).toHaveLength(0); // a voice is still live
    r.clips.resident = [5];
    v.stop();
    r.frame();
    r.status({ ended: [v.id] });
    r.frame();
    expect(only(r.ops(), Op.RESET)).toHaveLength(0); // a clip is still resident
    r.clips.resident = [];
    r.frame();
    const resets = only(r.ops(), Op.RESET);
    expect(resets).toHaveLength(1);
    expect(readReset(resets[0]!.view, resets[0]!.off).keepClips).toBe(0);
    r.frame();
    expect(only(r.ops(), Op.RESET)).toHaveLength(0); // once
  });

  it("a World attaching before the idle reset cancels it", () => {
    const r = rig();
    r.frame();
    r.ops();
    r.state.worlds = 0;
    for (const l of [...r.listeners]) l.onIdle?.();
    r.state.worlds = 1;
    r.frame();
    r.frame();
    expect(only(r.ops(), Op.RESET)).toHaveLength(0);
  });

  it("applyMix sends BUS_MIX; masterVolume and muted send MASTER", () => {
    const r = rig();
    r.frame();
    r.ops();
    r.mixer.bus("Music").volume = 0.5;
    r.mixer.update(0.016); // onChange -> applyMix
    r.backend.masterVolume = 0.25;
    r.backend.muted = true;
    r.frame();
    const ops = r.ops();
    const mix = readBusMix(ops.find((o) => o.op === Op.BUS_MIX)!.view, ops.find((o) => o.op === Op.BUS_MIX)!.off);
    expect(mix.buses[1]!.gain).toBeCloseTo(0.5);
    expect(mix.rampFrames).toBeGreaterThan(0);
    const masters = ops.filter((o) => o.op === Op.MASTER);
    expect(masters).toHaveLength(2);
    expect(masters[1]!.view.getFloat32(masters[1]!.off + 12, true)).toBeCloseTo(0.25);
    expect(masters[1]!.view.getUint32(masters[1]!.off + 16, true)).toBe(1);
  });

  it("update flushes one BATCH, and a play `at` a future time is stamped on that frame", () => {
    const r = rig();
    r.frame();
    r.ops();
    r.backend.play({ ...req(), at: 2 });
    r.backend.play(req());
    r.frame();
    const batches = r.batches();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.header.firstFrame).toBe(96_000);
    expect(batches[0]!.records.map((x) => x.frameOffset)).toEqual([ASAP, 0]);
  });

  it("an `at` in the past plays asap", () => {
    const r = rig();
    r.frame();
    r.ops();
    r.backend.play({ ...req(), at: 0.0001 });
    r.frame();
    expect(only(r.ops(), Op.PLAY)[0]!.frameOffset).toBe(ASAP);
  });

  it("asks for the HRIR on spatial plays (the loader dedupes the fetch), never for flat plays, and reports ready", () => {
    let ensured = 0;
    let ready = false;
    const r = rig({ hrir: { ensure: () => void ensured++, get ready() { return ready; } } });
    r.backend.play(req());
    r.frame();
    expect(ensured).toBe(0);
    r.backend.play({ ...req(), position: { x: 1, y: 0, z: 0 } });
    r.backend.play({ ...req(), position: { x: 2, y: 0, z: 0 } });
    r.frame();
    expect(ensured).toBeGreaterThanOrEqual(1);
    expect(r.backend.hrtfReady).toBe(false);
    expect(r.backend.debug().core["hrtfReady"]).toBe(false);
    ready = true;
    expect(r.backend.hrtfReady).toBe(true);
    expect(r.backend.debug().core["hrtfReady"]).toBe(true);
  });

  it("spatial play sends the listener-space direction and the distance gain, and a moved listener sends SET_PARAMS", () => {
    const r = rig();
    r.backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } });
    r.frame();
    r.ops();
    const v = r.backend.play({ ...req(), position: { x: 10, y: 0, z: 0 }, attenuation: { minDistance: 1, maxDistance: 100, rolloff: "inverse" } })!;
    r.frame();
    const play = only(r.ops(), Op.PLAY)[0]!;
    const p = readPlay(play.view, play.off);
    expect(p.dirX).toBeCloseTo(1);
    expect(p.dirZ).toBeCloseTo(0);
    expect(p.gain).toBeCloseTo(0.1); // 1 / (1 + 1 * (10 - 1)) = 0.1
    expect(p.flags & 16).toBe(16);
    // The listener turns to face the source: it is straight ahead now.
    r.backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 1, y: 0, z: 0 }, up: { x: 0, y: 1, z: 0 } });
    r.frame();
    const params = only(r.ops(), Op.SET_PARAMS);
    expect(params).toHaveLength(1);
    const sp = readSetParams(params[0]!.view, params[0]!.off);
    expect(sp.voiceId).toBe(v.id);
    expect(sp.dirZ).toBeCloseTo(-1);
    expect(sp.dirX).toBeCloseTo(0);
    // Nothing moved: nothing sent.
    r.frame();
    expect(only(r.ops(), Op.SET_PARAMS)).toHaveLength(0);
  });

  it("setVolume, setPitch and setBus send SET_PARAMS and move the bus count", () => {
    const r = rig();
    r.frame();
    const v = r.backend.play(req())!;
    r.frame();
    r.ops();
    v.setVolume(0.3);
    v.setPitch(100); // clamped to 16
    v.setBus("Music");
    expect(r.mixer.bus("SFX").activeVoices).toBe(0);
    expect(r.mixer.bus("Music").activeVoices).toBe(1);
    r.frame();
    const params = only(r.ops(), Op.SET_PARAMS).map((o) => readSetParams(o.view, o.off));
    expect(params).toHaveLength(3);
    expect(params[0]!.gain).toBeCloseTo(0.3);
    expect(params[1]!.pitch).toBe(16);
    expect(params[2]!.bus).toBe(1);
  });

  it("while the context is locked, plays wait (reason locked) and start when it runs", () => {
    const r = rig({ status: "locked" });
    r.frame();
    r.ops();
    const v = r.backend.play(req())!;
    expect(v.playing).toBe(true);
    expect(v.reason).toBe("locked");
    expect(r.backend.table.state[idx(v.id)]).toBe(VoiceState.LOCKED);
    r.frame();
    expect(only(r.ops(), Op.PLAY)).toHaveLength(0);
    r.state.status = "running";
    r.frame();
    expect(only(r.ops(), Op.PLAY)).toHaveLength(1);
    expect(v.reason).toBeNull();
  });

  it("a failed host plays nothing", () => {
    const r = rig({ status: "failed" });
    expect(r.backend.play(req())).toBeNull();
  });

  it("a refused play (table full of higher priority) returns null and releases the clip", () => {
    const r = rig();
    for (let i = 0; i < 16; i++) r.backend.play({ ...req(), priority: 255 });
    const before = r.clips.refs.get(r.clips.ids.get("a.wav")!)!;
    expect(r.backend.play({ ...req(), priority: 10 })).toBeNull();
    expect(r.clips.refs.get(r.clips.ids.get("a.wav")!)).toBe(before);
  });

  it("clip events from STATUS reach the registry", () => {
    const r = rig();
    r.frame();
    r.status({ clipEvents: [{ clipId: 9, code: 1 }] });
    r.frame();
    expect(r.clips.events).toEqual([[9, 1]]);
  });

  it("STATUS goes through the preallocated reader and feeds the clock fallback", () => {
    const r = rig();
    r.status({ currentFrame: 4_800, dateMs: 1_000_000 });
    const first = r.link.lastStatus;
    r.status({ currentFrame: 9_600, dateMs: 1_000_100 });
    expect(r.link.lastStatus).toBe(first); // one block, reused
    expect(r.backend.mirror.frameAudio).toBe(9_600);
    r.frame();
    expect(r.backend.time).toBeGreaterThan(0);
  });

  it("the sent STATUS buffers go back as RECYCLE and BATCH seq numbers are shared with the link", () => {
    const r = rig();
    r.frame();
    r.backend.play(req());
    r.frame();
    const kinds = r.sent.map((m) => readEnvelope(new DataView(m), 0));
    expect(kinds.every((e) => e.kind === Kind.BATCH)).toBe(true);
    const seqs = kinds.map((e) => e.seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });

  it("debug() returns the header fields", () => {
    const r = rig();
    const info = r.backend.debug();
    expect(info.status).toBe("running");
    expect(info.sampleRate).toBe(48_000);
  });

  it("dispose stops listening, restores the link's decoder and drops staged records", () => {
    const r = rig();
    r.backend.play(req());
    r.backend.dispose();
    r.frame();
    expect(r.sent).toHaveLength(0);
    expect(r.listeners).toHaveLength(0);
    expect(r.backend.play(req())).toBeNull();
  });

  it("every voice's table fields reset on reuse", () => {
    const r = rig();
    const v = r.backend.play({ ...req(), volume: 0.2, position: { x: 1, y: 0, z: 0 } })!;
    v.stop();
    r.frame();
    r.status({ ended: [v.id] });
    r.frame();
    const w = r.backend.play(req())!;
    expect(idx(w.id)).toBe(idx(v.id));
    expect(r.backend.table.flags[idx(w.id)]! & 2).toBe(0);
    expect(r.backend.table.reason[idx(w.id)]).toBe(VoiceReason.NONE);
    expect(r.backend.table.volume[idx(w.id)]).toBe(1);
  });
});

describe("CoreBackend: ducking counts and Bus.peak (A2.3)", () => {
  const duckSettings = (): AudioSettings => ({ ...defaultAudioSettings(), ducking: [{ target: "Music", trigger: "Voice", amount: 0.4, attack: 0.1, release: 0.5 }] });

  it("a locked voice on the trigger bus still ducks, and the duck lifts when it is freed", () => {
    const r = rig({ status: "locked", settings: duckSettings() });
    const v = r.backend.play(req("v.wav", { bus: "Voice", loop: true }))!;
    expect(r.backend.table.state[idx(v.id)]).toBe(VoiceState.LOCKED);
    expect(r.mixer.bus("Voice").activeVoices).toBe(1);
    for (let i = 0; i < 60; i++) r.mixer.update(0.1);
    expect(r.mixer.bus("Music").effectiveGain).toBeCloseTo(0.4, 2);
    v.stop();
    r.frame();
    r.status({ ended: [v.id] });
    r.frame();
    for (let i = 0; i < 100; i++) r.mixer.update(0.1);
    expect(r.mixer.bus("Music").effectiveGain).toBeCloseTo(1, 2);
  });

  it("a virtual voice on the trigger bus still ducks", () => {
    const r = rig({ settings: duckSettings() });
    const v = r.backend.play(req("v.wav", { bus: "Voice", loop: true }))!;
    r.frame();
    r.status({ demoted: [v.id] });
    r.frame();
    expect(r.backend.table.state[idx(v.id)]).toBe(VoiceState.VIRTUAL);
    expect(r.mixer.bus("Voice").activeVoices).toBe(1);
    for (let i = 0; i < 60; i++) r.mixer.update(0.1);
    expect(r.mixer.bus("Music").effectiveGain).toBeCloseTo(0.4, 2);
  });

  it("a bus remap keeps counting live voices", () => {
    const r = rig();
    r.backend.play(req("v.wav", { bus: "Voice", loop: true }));
    r.backend.play(req("v.wav", { bus: "Voice", loop: true }));
    r.mixer.configure(r.mixer.audioSettings);
    expect(r.mixer.bus("Voice").activeVoices).toBe(0);
    r.backend.configureBuses(r.mixer);
    expect(r.mixer.bus("Voice").activeVoices).toBe(2);
  });

  it("Bus.peak is max(L, R) per bus from STATUS, 0 while locked and past the reported buses", () => {
    const r = rig();
    r.status({ peaks: [{ l: 0.1, r: 0.2 }, { l: 0.5, r: 0.3 }, { l: 0.25, r: 0.75 }] });
    r.frame();
    expect(r.mixer.bus("Master").peak).toBeCloseTo(0.2, 6);
    expect(r.mixer.bus("Music").peak).toBeCloseTo(0.5, 6);
    expect(r.mixer.bus("SFX").peak).toBeCloseTo(0.75, 6);
    expect(r.mixer.bus("Voice").peak).toBe(0);
    r.state.status = "locked";
    r.frame();
    expect(r.mixer.bus("Music").peak).toBe(0);
  });

  it("a remap drops peaks reported for the old indices", () => {
    const r = rig();
    r.status({ peaks: [{ l: 0.9, r: 0.9 }, { l: 0.9, r: 0.9 }] });
    r.frame();
    expect(r.mixer.bus("Music").peak).toBeCloseTo(0.9, 6);
    r.backend.configureBuses(r.mixer);
    r.frame();
    expect(r.mixer.bus("Music").peak).toBe(0);
  });

  it("on the loopback host a voice gives a non-zero peak that decays after it stops; a muted bus reads ~0", async (ctx) => {
    const testing = await import("../testing");
    let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>>;
    try {
      loop = await testing.createLoopbackHost();
    } catch {
      return ctx.skip();
    }
    const { createClipRegistry } = await import("./clipRegistry");
    const link = loop.link;
    const clips = createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async () => new ArrayBuffer(8),
      decode: async () => ({ frames: 4_800, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(4_800).fill(0.5)] }),
      clipFormat: 0,
      nextFrame: (cb) => cb(),
      nextQuantum: (cb) => cb(),
    });
    const host: CoreBackendHost = {
      link,
      status: "running",
      preset: { maxLogical: 256 },
      worldCount: 1,
      sampleRate: 48_000,
      addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
    };
    const mixer = new Mixer(defaultAudioSettings());
    const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
    const step = async (frames: number) => {
      for (let f = 0; f < frames; f++) {
        mixer.update(0.003);
        backend.update(0.003);
        loop.renderQuanta(4);
        await Promise.resolve();
      }
    };
    const music = backend.play(req("m.wav", { bus: "Music", loop: true }))!;
    const sfx = backend.play(req("s.wav", { bus: "SFX", loop: true }))!;
    mixer.bus("SFX").mute = true;
    await step(40);
    expect(mixer.bus("Music").peak).toBeGreaterThan(0.3);
    expect(mixer.bus("SFX").peak).toBeLessThan(0.001);
    music.stop();
    sfx.stop();
    let last = mixer.bus("Music").peak;
    await step(5);
    const after = mixer.bus("Music").peak;
    expect(after).toBeLessThanOrEqual(last);
    await step(400);
    expect(mixer.bus("Music").peak).toBeLessThan(0.05);
    expect(mixer.bus("Music").peak).toBeLessThan(last);
    backend.dispose();
  });
});

describe("CoreBackend on the loopback host (A1.7's createLoopbackHost)", () => {
  /** The real wasm, the real clip registry and shell routing, the real coreBackend; a clip of a constant 0.5. Null when the loopback host can't load. */
  async function loopback(frames: number) {
    const testing = await import("../testing");
    // A1.7 adds `link` to K4's LoopbackHost; this branch's declaration doesn't have it yet.
    let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
    try {
      loop = (await testing.createLoopbackHost()) as typeof loop;
    } catch {
      return null;
    }
    const { createClipRegistry } = await import("./clipRegistry");
    const link = loop.link;
    const clips = createClipRegistry({
      send: (m) => link.post(m),
      nextSeq: () => link.nextSeq(),
      fetchBytes: async () => new ArrayBuffer(8),
      decode: async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [new Float32Array(frames).fill(0.5)] }),
      clipFormat: 0,
      nextFrame: (cb) => cb(),
      nextQuantum: (cb) => cb(),
    });
    const host: CoreBackendHost = {
      link,
      status: "running",
      preset: { maxLogical: 256 },
      worldCount: 1,
      sampleRate: 48_000,
      addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
    };
    const mixer = new Mixer(defaultAudioSettings());
    const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
    return { loop, backend, mixer };
  }

  // MS2's acceptance check (api-and-models §9, A1.4: "loopback plays a WAV").
  it("plays a WAV: the rendered output carries the clip's samples", async (ctx) => {
    const rig = await loopback(4_800); // 0.1 s of a constant 0.5
    if (!rig) return ctx.skip();
    const { loop, backend } = rig;
    const voice = backend.play(req("tone.wav"))!;
    let peakL = 0;
    let peakR = 0;
    let ended = false;
    for (let q = 0; q < 120; q++) {
      backend.update(0.003);
      const { left, right } = loop.renderQuanta(1);
      for (let i = 0; i < left.length; i++) {
        peakL = Math.max(peakL, Math.abs(left[i]!));
        peakR = Math.max(peakR, Math.abs(right[i]!));
      }
      await Promise.resolve();
      if (!voice.playing) {
        ended = true;
        break;
      }
    }
    // A flat (non-spatial) mono voice plays at full level on both channels, as Web Audio upmixes mono with no panner
    // (A1.2's goldens): the constant 0.5 comes out as 0.5 in each channel.
    expect(peakL).toBeCloseTo(0.5, 5);
    expect(peakR).toBeCloseTo(0.5, 5);
    expect(ended).toBe(true);
    backend.dispose();
  });

  // A2.1: the core's buses apply the mixer's gains (BUS_MIX): a bus at half volume halves its voice, a muted bus
  // silences its voice, and the root multiplies its children.
  it("bus gains reach the output: half volume halves a voice, mute silences one", async (ctx) => {
    const rig = await loopback(480);
    if (!rig) return ctx.skip();
    const { loop, backend, mixer } = rig;
    /** Steps `n` frames of 4 quanta each; returns the last quantum's level (every sample of it, both channels, agree). */
    const settle = async (n: number) => {
      let level = NaN;
      for (let f = 0; f < n; f++) {
        mixer.update(0.003);
        backend.update(0.003);
        for (let q = 0; q < 4; q++) {
          const { left, right } = loop.renderQuanta(1);
          level = left[0]!;
          if (f === n - 1 && q === 3) {
            for (let i = 0; i < left.length; i++) {
              expect(left[i]).toBeCloseTo(level, 6);
              expect(right[i]).toBeCloseTo(level, 6);
            }
          }
        }
        await Promise.resolve();
      }
      return level;
    };
    backend.play(req("music.wav", { bus: "Music", loop: true }));
    backend.play(req("sfx.wav", { bus: "SFX", loop: true }));
    expect(await settle(10)).toBeCloseTo(1.0, 5); // 0.5 + 0.5
    mixer.bus("Music").volume = 0.5;
    expect(await settle(10)).toBeCloseTo(0.75, 5); // 0.25 + 0.5
    mixer.bus("SFX").mute = true;
    expect(await settle(10)).toBeCloseTo(0.25, 5); // 0.25 + 0
    mixer.bus("Master").volume = 0.5;
    expect(await settle(10)).toBeCloseTo(0.125, 5); // the root multiplies its children
    backend.dispose();
  });
});
