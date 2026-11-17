// ADR 0171/0172 (M5, task G7b; api-and-models §5.5, §7): a capture recorded through the real recorder on the core backend
// (the real wasm core on the loopback host, assembled as production assembles it: ADR 0221's `loopbackAudio`), with the backend's own keyframe source wired the way `capture.ts` wires it. The
// keyframe in the ring carries the voice table and the mixer's bus lanes; opened as a live capture through the Worker handler,
// the profiler's `reconstructVoices` at the keyframe gives the rows the table has, and the seek's keyframe reads by name
// (ADR 0227's follow-up): state names, pitch and audibility as numbers, each bus flag as the mixer holds it, the snapshot
// by id. Time is the loopback's rendered frames.
import { afterEach, describe, expect, it } from "vitest";
import { Lane } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { createEventSink, NO_NAME } from "../../runtime/capture/events";
import { assembleCapture, decodeKeyframe } from "../../runtime/capture/format";
import { createRecorder } from "../../runtime/capture/recorder";
import { decodeRecordAt, openLiveCapture } from "../../runtime/capture/reader";
import { SAMPLE_HEADER, SAMPLE_META } from "../../runtime/capture/testSupport";
import { closeLoopbackAudio, loopbackAudio } from "../../runtime/testing";
import { CaptureSource } from "./profilerSource";
import { inProcessWorker } from "./voiceSceneSupport";
import { nameLookup, reconstructVoices } from "./voiceTableModel";

const MiB = 1024 * 1024;
const RATE = 48_000;
const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

/** ADR 0221: the core as production assembles it, on the loopback with its own mixer; null when the wasm can't be loaded here. */
async function rig(settings: AudioSettings) {
  const audio = await loopbackAudio({
    mixer: "own",
    settings,
    preset: { maxLogical: 16, maxMixed: 8 },
    decode: () => ({ channelData: [new Float32Array(96_000).fill(0.25)] }),
    quantaPerFrame: 4,
    dt: 0.003,
  });
  if (!audio) return null;
  return { backend: audio.backend, mixer: audio.mixer, step: async (n: number) => void (await audio.step(n)) };
}

afterEach(closeLoopbackAudio);

describe("a capture recorded on the core backend carries the real keyframe", () => {
  it("voice rows equal the voice table and bus lanes equal the mixer's; reconstructVoices at the keyframe equals the table", async (ctx) => {
    const settings = defaultAudioSettings();
    settings.snapshots = [{ name: "Hush", volumes: { Music: 0.3 }, lowpass: {} }];
    const r = await rig(settings);
    if (!r) return ctx.skip();
    const { backend, mixer } = r;
    // The real recorder and sink, wired as `capture.ts` wires them: the keyframe source is the backend's own.
    const rec = createRecorder({ ringBytes: 8 * MiB });
    const sink = createEventSink(rec, { epochContext: () => ({ sampleRate: RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0, frame: backend.debug().core.currentFrame as number }) });
    rec.setKeyframeSource(() => backend.keyframe((table, name) => sink.name(table, name), NO_NAME));
    sink.epoch("start");
    rec.attach(backend);
    backend.setProfileSink(sink);

    const a = backend.play(req("a.wav", { priority: 50, volume: 0.5 }))!;
    const b = backend.play(req("b.wav", { priority: 200, bus: "Music", volume: 0.25 }))!;
    const c = backend.play(req("c.wav", { priority: 90, bus: "Voice", pitch: 2 }))!;
    mixer.bus("Music").volume = 0.5;
    mixer.snapshot("Hush", 0);
    await r.step(20);
    rec.requestKeyframe(); // the next STATUS opens a segment with a keyframe of the table as it stands now
    await r.step(2);
    const frame = rec.newestStatusFrame;
    expect(frame).toBeGreaterThan(rec.lastKeyframeFrame - 1);

    // The table and the lanes right now (nothing moved since the keyframe: the voices loop, the lanes settled).
    const debug = backend.debug();
    const slots = backend.buses.slots.slots;
    const metaBuses: Record<number, string> = {};
    slots.forEach((s, i) => { if (s.name !== null && s.state !== "free") metaBuses[i] = s.name; });
    const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, clips: {}, buses: metaBuses } };
    const headBytes = assembleCapture({ ...SAMPLE_HEADER, sampleRate: RATE }, meta, []);

    // (1) The keyframe record the ring holds, decoded: the rows.
    const decoder = openLiveCapture(headBytes);
    decoder.appendRecords(rec.takeSpan().bytes);
    const opened = decoder.contents;
    const last = decodeRecordAt(opened, opened.keyframes.at(-1)!);
    if (last.kind !== "keyframe") throw new Error("expected a keyframe");
    const kf = decodeKeyframe(new DataView(last.payload.buffer, last.payload.byteOffset, last.payload.byteLength), 0, last.payload.byteLength);
    const clipNames = opened.names.clips;
    expect(kf.voices).toHaveLength(3);
    for (const v of debug.voices) {
      const row = kf.voices.find((x) => x.id === v.id)!;
      expect(row, `voice ${v.id}`).toBeDefined();
      expect(clipNames.get(row.clip)).toBe(v.clip);
      expect(row.slot).toBe(debug.buses.findIndex((x) => x.name === v.bus));
      expect(row.priority).toBe(v.priority);
      expect(row.gain).toBe(Math.fround(v.gain));
      expect(row.pitch).toBe(Math.round(v.pitch * 4096));
    }
    for (const bus of kf.buses) {
      const name = slots[bus.slot]!.name!;
      expect(bus.lanes[2]).toBe(Math.fround(mixer.laneGain(name, Lane.runtime)));
      expect(bus.lanes[4]).toBe(Math.fround(mixer.laneGain(name, Lane.snapshot)));
    }
    expect(opened.names.snapshots.get(kf.mix.snapshotName)).toBe("Hush");

    // (2) The profiler's replay at the keyframe: the table's rows, named through the NAMES records and META's bus slots.
    const source = await CaptureSource.openLive(headBytes.slice().buffer, { worker: inProcessWorker() });
    await source.appendSegment(rec.takeSpan().bytes.slice().buffer);
    const state = await source.seek(frame / RATE);
    expect(state.keyframe).not.toBeNull();
    const replay = reconstructVoices(state, nameLookup(source.summary.names));
    expect(replay.fromKeyframe).toBe(true);
    const rows = replay.rows.map((x) => ({ id: x.id, clip: x.clipName, bus: x.busName, state: x.state, priority: x.priority, gain: x.gain })).sort((p, q) => p.id - q.id);
    const table = debug.voices.map((v) => ({ id: v.id, clip: v.clip, bus: v.bus, state: v.state, priority: v.priority, gain: Math.fround(v.gain) })).sort((p, q) => p.id - q.id);
    expect(rows).toEqual(table);
    expect(rows.map((x) => x.id)).toEqual([a.id, b.id, c.id].sort((p, q) => p - q));
    source.close();
    rec.detach();
    backend.dispose();
  });

  it("the seek answers the keyframe by name: pitch as a rate, audibility 0..1, the bus flags as booleans, the snapshot by id", async (ctx) => {
    const settings = defaultAudioSettings();
    settings.snapshots = [{ name: "Hush", volumes: { Music: 0.3 }, lowpass: {} }];
    settings.buses.find((x) => x.name === "UI")!.mute = true; // an authored mute
    const r = await rig(settings);
    if (!r) return ctx.skip();
    const { backend, mixer } = r;
    const rec = createRecorder({ ringBytes: 8 * MiB });
    const sink = createEventSink(rec, { epochContext: () => ({ sampleRate: RATE, limiterLatencyFrames: 0, outputLatencyFrames: 0, timeOffset: 0, frame: backend.debug().core.currentFrame as number }) });
    rec.setKeyframeSource(() => backend.keyframe((table, name) => sink.name(table, name), NO_NAME));
    sink.epoch("start");
    rec.attach(backend);
    backend.setProfileSink(sink);

    backend.play(req("a.wav", { priority: 50, volume: 0.5 }));
    backend.play(req("c.wav", { priority: 90, bus: "Voice", pitch: 2 }));
    mixer.bus("Music").mute = true; // a runtime mute
    mixer.setMonitor("SFX", { solo: true });
    mixer.snapshot("Hush", 0);
    await r.step(20);
    rec.requestKeyframe();
    await r.step(2);
    const frame = rec.newestStatusFrame;
    const debug = backend.debug();
    const slots = backend.buses.slots.slots;
    const metaBuses: Record<number, string> = {};
    slots.forEach((s, i) => { if (s.name !== null && s.state !== "free") metaBuses[i] = s.name; });
    const headBytes = assembleCapture({ ...SAMPLE_HEADER, sampleRate: RATE }, { ...SAMPLE_META, names: { ...SAMPLE_META.names, clips: {}, buses: metaBuses } }, []);

    const source = await CaptureSource.openLive(headBytes.slice().buffer, { worker: inProcessWorker() });
    await source.appendSegment(rec.takeSpan().bytes.slice().buffer);
    const kf = (await source.seek(frame / RATE)).keyframe!;
    expect(kf).not.toBeNull();

    // Voices: the table's state name, pitch and audibility (u4.12 and u0.16 on the wire, so within one step of each).
    expect(kf.voices).toHaveLength(2);
    for (const v of debug.voices) {
      const row = kf.voices.find((x) => x.id === v.id)!;
      expect(row.state).toBe(v.state);
      expect(Math.abs(row.pitch - v.pitch)).toBeLessThanOrEqual(1 / 4096);
      expect(Math.abs(row.audibility - v.audibility)).toBeLessThanOrEqual(1 / 65536);
      expect(row.audibility).toBeGreaterThanOrEqual(0);
      expect(row.audibility).toBeLessThanOrEqual(1);
    }
    expect(kf.voices.find((x) => x.slot === slots.findIndex((s) => s.name === "Voice"))!.pitch).toBe(2);

    // Buses: each flag by name, as the mixer holds it.
    const byName = new Map(kf.buses.map((x) => [slots[x.slot]!.name!, x]));
    for (const [name, row] of byName) {
      const lanes = mixer._lanes(name)!;
      expect({ name, authoredMute: row.authoredMute, runtimeMute: row.runtimeMute, monitorMute: row.monitorMute, monitorSolo: row.monitorSolo, tombstone: row.tombstone })
        .toEqual({ name, authoredMute: lanes.authoredMute, runtimeMute: lanes.runtimeMute, monitorMute: lanes.monitorMute, monitorSolo: lanes.monitorSolo, tombstone: false });
      expect(row.lanes.snapshot.value).toBe(Math.fround(mixer.laneGain(name, Lane.snapshot)));
    }
    expect(byName.get("UI")!.authoredMute).toBe(true);
    expect(byName.get("Music")!.runtimeMute).toBe(true);
    expect(byName.get("SFX")!.monitorSolo).toBe(true);
    expect(byName.get("Voice")).toMatchObject({ authoredMute: false, runtimeMute: false, monitorMute: false, monitorSolo: false });

    // The mix: the snapshot by its NAMES id, the monitor as a boolean.
    expect(kf.mix.snapshot).not.toBeNull();
    expect(new Map(source.summary.names.snapshots).get(kf.mix.snapshot!)).toBe("Hush");
    expect(kf.mix.monitorActive).toBe(true);
    expect(kf.mix.hiddenMute).toBe(false);
    source.close();
    rec.detach();
    backend.dispose();
  });
});
