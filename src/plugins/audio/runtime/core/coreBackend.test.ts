// A1.4 (lead): `CoreBackend` on the recording host (`recordingAudio`, ADR 0234: a fake ClipRegistry, no wasm), plus the
// loopback check (`loopbackAudio`, ADR 0221).
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { ASAP, Kind, LANE_RUNTIME, LANE_SNAPSHOT, Op, readBusConfig, readBusDuck, readBusPresence, readBusRamp, readEnvelope, readPlay, readReset, readSetParams, readStop, readFade, SET_PARAMS_MASK_BUS, SET_PARAMS_MASK_SCORE } from "../wire.generated";
import type { HrirLoader } from "./hrir";
import type { CoreBackend, CoreBackendDeps } from "./coreBackend";
import { closeLoopbackAudio, closeRecordingAudio, loopbackAudio, recordingAudio } from "../testing";
import type { PostedBatch } from "./batchRecords";

/**
 * The core backend on the recording host (ADR 0234), over its own mixer, with a fake clip registry: `status` sets the host's
 * starting state as the context gives it ("locked": an interruption only a gesture resumes; "failed": a closed context).
 */
function rig(options: { status?: "locked" | "running" | "failed"; settings?: AudioSettings; hrir?: HrirLoader; streams?: CoreBackendDeps["streams"] } = {}) {
  const r = recordingAudio({ mixer: "own", settings: options.settings ?? defaultAudioSettings(), preset: { maxLogical: 16 }, backend: { hrir: options.hrir, streams: options.streams } });
  if (options.status === "locked") r.lock();
  if (options.status === "failed") void r.host.context.close();
  /** Batches posted since the last call, as record lists. */
  const batches = () => r.posted.take().filter((b) => b.kind === Kind.BATCH).map(decode);
  const ops = () => batches().flatMap((b) => b.records);
  return { ...r, backend: r.backend, batches, ops, frame: () => r.frame() };
}

/** A posted batch's records, each with its frame offset from the batch's first frame (`ASAP` kept). */
function decode(batch: PostedBatch) {
  const records = batch.records.map((x) => ({ op: x.opcode, voiceId: x.voiceId, frameOffset: x.frame === -1 ? ASAP : x.frame - batch.firstFrame, off: x.off, view: x.view }));
  return { header: { firstFrame: batch.firstFrame }, records };
}

const req = (path = "a.wav", extra: object = {}) => ({ path, url: path, loop: false, stream: false, bus: "SFX", ...extra });
const idx = (id: number) => id & 0xffff;
/** Voice `id`'s `Audio.debug()` row. */
const row = (r: { backend: CoreBackend }, id: number) => r.backend.debug().voices.find((v) => v.id === id);
const only = (list: ReturnType<typeof decode>["records"], op: number) => list.filter((x) => x.op === op);

afterEach(async () => {
  await closeRecordingAudio();
  await closeLoopbackAudio();
});

describe("CoreBackend (api-and-models §3, §6)", () => {
  it("a stream: true play is a stream voice: never acquired as a whole clip, no warning, its PLAY flagged stream and spatial (B3, B6)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const opened: { streamId: number; asset: string }[] = [];
    const fetched: string[] = [];
    const decoder = {
      generation: 1,
      connectWorklet: () => {},
      openStream: (o: { streamId: number; asset: string }) => void opened.push({ streamId: o.streamId, asset: o.asset }),
      closeStream: () => {},
      onStream: () => () => {},
    };
    const r = rig({
      streams: {
        decoder: () => decoder,
        connectWorklet: () => {},
        channel: () => ({ worker: {} as MessagePort, worklet: {} as MessagePort }),
        fetchBytes: async (path) => (fetched.push(path), new ArrayBuffer(8)),
      },
    });
    // Spatial too: on the core a stream voice is a full voice (B3).
    const voice = r.backend.play({ ...req("music.ogg"), stream: true, position: { x: 10, y: 0, z: 0 }, attenuation: { minDistance: 1, maxDistance: 100, rolloff: "inverse" } })!;
    expect(voice).not.toBeNull();
    expect(voice.reason).toBe("waitingForData");
    expect(r.clips.ids.has("music.ogg")).toBe(false);
    r.frame();
    const plays = only(r.ops(), Op.PLAY);
    expect(plays).toHaveLength(1);
    const p = readPlay(plays[0]!.view, plays[0]!.off);
    expect(p.clip >>> 0).toBeGreaterThanOrEqual(0xffff0100);
    expect(p.flags & 2).toBe(2); // stream
    expect(p.flags & 16).toBe(16); // spatial
    expect(p.gain).toBeCloseTo(0.1);
    await Promise.resolve();
    await Promise.resolve();
    expect(fetched).toEqual(["music.ogg"]);
    expect(opened).toEqual([{ streamId: p.clip >>> 0, asset: "music.ogg" }]);
    // A clip that does not stream still goes through the registry.
    r.backend.play(req("hit.wav"));
    expect(r.clips.ids.has("hit.wav")).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("play allocates a voice, sends PLAY with the registry's clip id, and counts the bus with mixer.voiceStarted", () => {
    const r = rig();
    r.frame(); // the initial BUS_CONFIG and bus lanes
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

  it("the constructor's BUS_CONFIG, the presence rules and mask (Dp1) and every bus lane (Mx2: authored, runtime, snapshot, monitor, dip per bus) go out at the first update", () => {
    const sentRig = rig();
    sentRig.tick(0);
    // Ld2: LOUD_CONFIG follows BUS_CONFIG at configure (master metered; its records: loudnessWiring.test.ts).
    const sent = sentRig.ops();
    expect(sent.filter((o) => o.op === Op.LOUD_CONFIG)).toHaveLength(1);
    expect(sent.findIndex((o) => o.op === Op.LOUD_CONFIG)).toBeGreaterThan(sent.findIndex((o) => o.op === Op.BUS_CONFIG));
    const ops = sent.filter((o) => o.op !== Op.LOUD_CONFIG);
    expect(ops.map((o) => o.op)).toEqual([Op.BUS_CONFIG, Op.BUS_DUCK, Op.BUS_PRESENCE, ...Array.from({ length: 25 }, () => Op.BUS_RAMP)]);
    const cfg = readBusConfig(ops[0]!.view, ops[0]!.off);
    expect(cfg.buses).toHaveLength(5);
    expect(cfg.buses[0]!.parent).toBe(0xffff);
    expect(cfg.buses[2]!.parent).toBe(0);
    expect(readBusDuck(ops[1]!.view, ops[1]!.off).rules).toHaveLength(0);
    expect(readBusPresence(ops[2]!.view, ops[2]!.off)).toMatchObject({ mask: 0, frameOffset: ASAP });
    const ramps = ops.slice(3).map((o) => readBusRamp(o.view, o.off));
    // Bus b: lanes 0-4 in order, asap, linear, no sequence; the snapshot lane carries gain and low-pass.
    ramps.forEach((r, i) => expect(r).toMatchObject({ voiceId: Math.floor(i / 5), lane: i % 5, mask: i % 5 === LANE_SNAPSHOT ? 3 : 1, shape: 0, frameOffset: ASAP }));
    expect(ramps[LANE_RUNTIME]).toMatchObject({ gain: 1 });
    expect(ramps[LANE_SNAPSHOT]).toMatchObject({ gain: 1, lpHz: 24000 });
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
    // The mixer takes the new tree, then the host remaps (Master, Music, SFX, UI, Voice to Master, SFX, UI, Voice), as `Engine.create` does.
    r.mixer.configure(settings);
    expect(r.host.reconfigure(settings)!.map).toEqual(new Uint8Array([0, 0, 1, 2, 3]));
    expect(r.backend.debug().buses.slice(1, 3).map((b) => b.maxVoices)).toEqual([3, null]);
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
    r.host.releaseWorld(r.share!.key); // the last World goes: the host is idle
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
    r.host.releaseWorld(r.share!.key);
    r.host.attachWorld({ kind: "runtime" });
    r.frame();
    r.frame();
    expect(only(r.ops(), Op.RESET)).toHaveLength(0);
  });

  it("a volume set sends one runtime-lane BUS_RAMP; masterVolume and muted send BUS_RAMP on BUS_MASTER_OUT (Mx2)", () => {
    const r = rig();
    r.frame();
    r.ops();
    r.mixer.bus("Music").volume = 0.5;
    r.mixer.update(0.016); // onChange -> the lane writer
    r.backend.masterVolume = 0.25;
    r.backend.muted = true;
    r.frame();
    const ops = r.ops();
    const ramps = ops.filter((o) => o.op === Op.BUS_RAMP).map((o) => readBusRamp(o.view, o.off));
    expect(ramps).toHaveLength(3);
    expect(ramps[0]).toMatchObject({ voiceId: 1, lane: LANE_RUNTIME, gain: 0.5, frameOffset: ASAP });
    expect(ramps[0]!.frames).toBeGreaterThan(0);
    expect(ramps[1]).toMatchObject({ voiceId: 0xffff, lane: LANE_RUNTIME, gain: 0.25 });
    expect(ramps[2]).toMatchObject({ voiceId: 0xffff, lane: LANE_RUNTIME, gain: 0 });
    expect(ops.filter((o) => o.op === Op.MASTER)).toHaveLength(0);
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
    const plays = batches[0]!.records.filter((x) => x.op === Op.PLAY);
    expect(plays.map((x) => x.frameOffset)).toEqual([ASAP, 0]);
    // Dp1: no rule triggers on SFX, so its voices send no presence.
    expect(batches[0]!.records.filter((x) => x.op === Op.BUS_PRESENCE)).toHaveLength(0);
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
    // Facing engine forward (+Z, ADR 0164): a source at +X is on the right, listener-space +X.
    r.backend.setListener({ position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } });
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
    const ops = r.ops();
    const params = only(ops, Op.SET_PARAMS).map((o) => readSetParams(o.view, o.off));
    // A3.3: the volume moved the voice's audibility more than 3 dB, so selection re-sends its score too.
    expect(params).toHaveLength(4);
    expect(params[0]!.gain).toBeCloseTo(0.3);
    expect(params[1]!.pitch).toBe(16);
    expect(params[2]!.mask).toBe(SET_PARAMS_MASK_SCORE);
    expect(params[2]!.score).toBeCloseTo(row(r, v.id)!.audibility, 6);
    // G7a (§4.7): the voice is sounding, so its bus goes through the per-voice dip: stamped at B (after the asap
    // records), between its fade-out and fade-in.
    expect(params[3]!.bus).toBe(1);
    expect(params[3]!.frameOffset).not.toBe(ASAP);
    expect(only(ops, Op.FADE).map((o) => readFade(o.view, o.off).target)).toEqual([0, 0, 1]);
  });

  it("while the context is locked, plays wait (reason locked) and start when it runs", () => {
    const r = rig({ status: "locked" });
    r.frame();
    r.ops();
    const v = r.backend.play(req())!;
    expect(v.playing).toBe(true);
    expect(v.reason).toBe("locked");
    expect(row(r, v.id)!.state).toBe("locked");
    r.frame();
    expect(only(r.ops(), Op.PLAY)).toHaveLength(0);
    r.gesture();
    r.frame();
    expect(only(r.ops(), Op.PLAY)).toHaveLength(1);
    expect(v.reason).toBeNull();
  });

  // ADR 0291: the core session answers "may send" (a core listens now) and "may queue" (a core will keep what is written:
  // the frame's BATCH reaches a locked context's port and applies when it resumes). One row per lifecycle state: a play
  // starts only when it may send; automation (a global parameter) goes out whenever it may queue, locked included; the
  // fader's preview post (`flushNow`) only when it may send; nothing reaches a core during a rebuild, failed or disposed.
  const states: { state: string; enter(): ReturnType<typeof rig>; plays: "starts" | "waits" | "refused"; param: boolean; preview: boolean }[] = [
    { state: "running", enter: () => rig(), plays: "starts", param: true, preview: true },
    { state: "locked", enter: () => rig({ status: "locked" }), plays: "waits", param: true, preview: false },
    {
      state: "recovering",
      enter: () => {
        const r = rig();
        r.newCore = "silent";
        void r.rebuild();
        return r;
      },
      plays: "waits",
      param: false,
      preview: false,
    },
    { state: "failed", enter: () => rig({ status: "failed" }), plays: "refused", param: false, preview: false },
    {
      state: "disposed",
      enter: () => {
        const r = rig();
        r.backend.dispose();
        return r;
      },
      plays: "refused",
      param: false,
      preview: false,
    },
  ];
  it.each(states)("$state: what reaches the core follows the session's send rule (ADR 0291)", ({ enter, plays, param, preview }) => {
    const r = enter();
    r.frame();
    r.posted.take();
    // The fader's preview path: an edit, then `flushNow` posts at once when the session may send.
    r.mixer.apply({ op: "setBus", bus: "SFX", key: "volume", value: 0.5 });
    r.backend.flushNow();
    expect(r.posted.pending.length > 0, "preview post").toBe(preview);
    r.posted.take();
    const v = r.backend.play(req());
    if (plays === "refused") expect(v).toBeNull();
    else expect(v!.reason).toBe(plays === "starts" ? null : "locked");
    r.backend.automation!.setParam(0, 0, 0.5, 0);
    r.frame();
    const ops = r.ops();
    expect(only(ops, Op.PLAY), "PLAY").toHaveLength(plays === "starts" ? 1 : 0);
    expect(only(ops, Op.PARAM), "PARAM").toHaveLength(param ? 1 : 0);
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
    expect(r.backend.debug().core.currentFrame).toBe(9_600);
    r.frame();
    expect(r.backend.time).toBeGreaterThan(0);
  });

  it("the sent STATUS buffers go back as RECYCLE and BATCH seq numbers are shared with the link", () => {
    const r = rig();
    r.frame();
    r.backend.play(req());
    r.frame();
    const kinds = r.posted.take().map((b) => readEnvelope(b.records[0]!.view, 0));
    expect(kinds.length).toBeGreaterThan(0);
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
    // The host's lifecycle no longer reaches it: the last World leaving sends no idle reset.
    r.host.releaseWorld(r.share!.key);
    r.frame();
    expect(r.posted.pending).toHaveLength(0);
    expect(r.backend.play(req())).toBeNull();
  });

  it("a reused slot carries none of the old voice's fields", () => {
    const r = rig();
    const v = r.backend.play({ ...req(), volume: 0.2, position: { x: 1, y: 0, z: 0 } })!;
    v.stop();
    r.frame();
    r.status({ ended: [v.id] });
    r.frame();
    const w = r.backend.play(req())!;
    expect(idx(w.id)).toBe(idx(v.id));
    expect(w.reason).toBeNull();
    r.ops();
    r.frame();
    const play = only(r.ops(), Op.PLAY).find((o) => o.voiceId === w.id)!;
    const p = readPlay(play.view, play.off);
    expect(p.flags & 16).toBe(0); // not spatial
    expect(p.gain).toBe(1);
  });
});

describe("CoreBackend: ducking counts and Bus.peak (A2.3)", () => {
  const duckSettings = (): AudioSettings => ({ ...defaultAudioSettings(), ducking: [{ target: "Music", trigger: "Voice", amount: 0.4, attack: 0.1, release: 0.5 }] });

  /** Dp1: the BUS_PRESENCE masks sent since the last call. */
  const masks = (r: ReturnType<typeof rig>) => r.ops().filter((o) => o.op === Op.BUS_PRESENCE).map((o) => readBusPresence(o.view, o.off).mask);
  const VOICE_BIT = 1 << 4;

  it("a locked voice on the trigger bus still ducks (its presence bit goes to the core), and the duck lifts when it is freed", () => {
    const r = rig({ status: "locked", settings: duckSettings() });
    r.frame();
    const duck = r.ops().find((o) => o.op === Op.BUS_DUCK)!;
    expect(readBusDuck(duck.view, duck.off).rules).toEqual([{ target: 1, trigger: 4, flags: 0, thresholdDb: -30, amount: expect.closeTo(0.4, 6), attack: expect.closeTo(0.1, 6), release: 0.5 }]);
    const v = r.backend.play(req("v.wav", { bus: "Voice", loop: true }))!;
    expect(row(r, v.id)!.state).toBe("locked");
    expect(r.mixer.bus("Voice").activeVoices).toBe(1);
    r.frame();
    expect(masks(r)).toEqual([VOICE_BIT]);
    // The core's duck, from STATUS: main computes none of its own on this backend.
    for (let i = 0; i < 60; i++) r.mixer.update(0.1);
    expect(r.mixer.bus("Music").effectiveGain).toBe(1);
    r.status({ busDuck: [{ slot: 1, pad: 0, gain: 0.4 }] });
    expect(r.mixer.bus("Music").duckGain).toBeCloseTo(0.4, 6);
    expect(r.mixer.bus("Music").effectiveGain).toBeCloseTo(0.4, 6);
    v.stop(); // a locked voice is freed at once
    r.frame();
    expect(masks(r)).toEqual([0]);
    r.status({ busDuck: [{ slot: 1, pad: 0, gain: 1 }] });
    expect(r.mixer.bus("Music").effectiveGain).toBeCloseTo(1, 6);
  });

  it("a virtual voice on the trigger bus still ducks", () => {
    const r = rig({ settings: duckSettings() });
    const v = r.backend.play(req("v.wav", { bus: "Voice", loop: true }))!;
    r.frame();
    expect(masks(r)).toEqual([0, VOICE_BIT]);
    r.status({ demoted: [v.id] });
    r.frame();
    expect(row(r, v.id)!.state).toBe("virtual");
    expect(r.mixer.bus("Voice").activeVoices).toBe(1);
    // Dp1: demotion changes no presence (the voice still counts); the duck is the core's, read from STATUS.
    expect(masks(r)).toEqual([]);
    r.status({ busDuck: [{ slot: 1, pad: 0, gain: 0.4 }] });
    r.mixer.update(0.1);
    expect(r.mixer.bus("Music").effectiveGain).toBeCloseTo(0.4, 6);
  });

  it("an explicit stop clears the presence bit asap with its STOP; the natural end of another voice keeps it", () => {
    const r = rig({ settings: duckSettings() });
    const a = r.backend.play(req("v.wav", { bus: "Voice", loop: true }))!;
    const b = r.backend.play(req("w.wav", { bus: "Voice", loop: true }))!;
    r.frame();
    expect(masks(r), "the configure's mask, then the first start").toEqual([0, VOICE_BIT]);
    a.stop();
    r.frame();
    expect(masks(r), "one voice still on Voice").toEqual([]);
    b.stop();
    r.frame();
    const ops = r.ops();
    const stopAt = ops.findIndex((o) => o.op === Op.STOP);
    const presAt = ops.findIndex((o) => o.op === Op.BUS_PRESENCE);
    expect(presAt).toBeGreaterThanOrEqual(0);
    expect(stopAt).toBeGreaterThan(presAt);
    expect(readBusPresence(ops[presAt]!.view, ops[presAt]!.off)).toMatchObject({ mask: 0, frameOffset: ASAP });
    // Its end a STATUS later sends nothing more.
    r.status({ ended: [a.id, b.id] });
    r.frame();
    expect(masks(r)).toEqual([]);
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
    r.lock();
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
    // ADR 0221: the production assembly on the loopback, with its own mixer.
    const loop = await loopbackAudio({ mixer: "own", preset: { maxLogical: 256 }, decode: () => ({ channelData: [new Float32Array(4_800).fill(0.5)] }) });
    if (!loop) return ctx.skip();
    const { backend, mixer } = loop;
    const step = async (frames: number) => {
      for (let f = 0; f < frames; f++) {
        loop.mainFrame(0.003);
        loop.render(4);
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

describe("CoreBackend on the loopback host (loopbackAudio, ADR 0221)", () => {
  /** The real wasm, clip registry and shell routing, the core assembled as production does it; a clip of a constant 0.5. Null when the wasm can't load. */
  async function loopback(frames: number) {
    // ADR 0221: the production assembly on the loopback, with its own mixer.
    const loop = await loopbackAudio({ mixer: "own", preset: { maxLogical: 256 }, decode: () => ({ channelData: [new Float32Array(frames).fill(0.5)] }) });
    if (!loop) return null;
    return { loop, backend: loop.backend, mixer: loop.mixer };
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
      loop.tick(0.003);
      const { left, right } = loop.render(1);
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

  // A2.1: the core's buses apply the mixer's gains (BUS_RAMP): a bus at half volume halves its voice, a muted bus
  // silences its voice, and the root multiplies its children.
  it("bus gains reach the output: half volume halves a voice, mute silences one", async (ctx) => {
    const rig = await loopback(480);
    if (!rig) return ctx.skip();
    const { loop, backend, mixer } = rig;
    /** Steps `n` frames of 4 quanta each; returns the last quantum's level (every sample of it, both channels, agree). */
    const settle = async (n: number) => {
      let level = NaN;
      for (let f = 0; f < n; f++) {
        loop.mainFrame(0.003);
        for (let q = 0; q < 4; q++) {
          const { left, right } = loop.render(1);
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

/** The records of every REPLAY message posted since the last call (the rebuild's replay, `replay.ts`). */
function replayRecords(r: ReturnType<typeof rig>) {
  return r.posted.take().filter((b) => b.kind === Kind.REPLAY).flatMap((b) => b.records.map((x) => ({ op: x.opcode, voiceId: x.voiceId, off: x.off, view: x.view })));
}

describe("a stem voice across a hard rebuild (F-9b)", () => {
  it("replays at the dry gain the core held: volume × occlusion × the stem's level", async () => {
    const r = rig();
    r.frame();
    const voice = r.backend.play({ ...req("stem.wav"), volume: 0.8, loop: true })!;
    r.frame();
    voice.setOcclusion(0.5, 20_000);
    // The stem's level (asap, no ramp), then frames pass so it has landed, and a later stamped fade prunes its log entry.
    voice.paramsShaped({ gain: 0.25, seconds: 0 });
    for (let k = 0; k < 10; k++) r.frame();
    voice.fadeShaped({ to: 1, seconds: 0, law: "linear" });
    r.frame();
    r.posted.take();
    expect(await r.rebuild()).toBe("rebuilt");
    r.clips.settle(r.clips.ids.get("stem.wav")!, "ready");
    r.frame();
    const records = replayRecords(r).filter((x) => x.voiceId === voice.id);
    const play = records.find((x) => x.op === Op.PLAY)!;
    expect(play).toBeDefined();
    expect(readPlay(play.view, play.off).gain).toBeCloseTo(0.8 * 0.5 * 0.25, 6);
    // Nothing behind it puts a different gain back.
    const gains = records.filter((x) => x.op === Op.SET_PARAMS).map((x) => readSetParams(x.view, x.off)).filter((p) => (p.mask & 1) !== 0);
    for (const p of gains) expect(p.gain).toBeCloseTo(0.8 * 0.5 * 0.25, 6);
  });
});
