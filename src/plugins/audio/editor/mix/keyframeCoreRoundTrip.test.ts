// ADR 0171/0172 (M5, task G7b; api-and-models §5.5, §7): a capture recorded through the real recorder on the core backend
// (the real wasm core on the loopback host), with the backend's own keyframe source wired the way `capture.ts` wires it. The
// keyframe in the ring carries the voice table and the mixer's bus lanes; opened as a live capture through the Worker handler,
// the profiler's `reconstructVoices` at the keyframe gives the rows the table has. Time is the loopback's rendered frames.
import { describe, expect, it } from "vitest";
import { Lane, Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings, type AudioSettings } from "../../../../engine/audio/settings";
import { createEventSink, NO_NAME } from "../../runtime/capture/events";
import { assembleCapture, decodeKeyframe } from "../../runtime/capture/format";
import { createRecorder } from "../../runtime/capture/recorder";
import { decodeRecordAt, openLiveCapture } from "../../runtime/capture/reader";
import { SAMPLE_HEADER, SAMPLE_META } from "../../runtime/capture/testSupport";
import type { CoreLink } from "../../runtime/core/context";
import { CoreBackend, type CoreBackendHost } from "../../runtime/core/coreBackend";
import { fakeDecoder } from "../../runtime/core/fakeDecoder";
import { CaptureSource } from "./profilerSource";
import { inProcessWorker } from "./voiceSceneSupport";
import { nameLookup, reconstructVoices } from "./voiceTableModel";

const MiB = 1024 * 1024;
const RATE = 48_000;
const req = (path: string, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", ...extra });

async function rig(settings: AudioSettings) {
  const testing = await import("../../runtime/testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost()) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("../../runtime/core/clipRegistry");
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames: 96_000, channels: 1, sampleRate: RATE, channelData: [new Float32Array(96_000).fill(0.25)] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link, status: "running", preset: { maxLogical: 16, maxMixed: 8 }, worldCount: 1, sampleRate: RATE,
    addLifecycleListener: (() => () => {}) as CoreBackendHost["addLifecycleListener"],
  };
  const mixer = new Mixer(settings);
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      loop.renderQuanta(4);
      await Promise.resolve();
    }
  };
  return { backend, mixer, step };
}

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
    const rows = replay.rows.map((x) => ({ id: x.id, clip: x.clipName, bus: x.busName, state: x.stateName, priority: x.priority, gain: x.gain })).sort((p, q) => p.id - q.id);
    const table = debug.voices.map((v) => ({ id: v.id, clip: v.clip, bus: v.bus, state: v.state, priority: v.priority, gain: Math.fround(v.gain) })).sort((p, q) => p.id - q.id);
    expect(rows).toEqual(table);
    expect(rows.map((x) => x.id)).toEqual([a.id, b.id, c.id].sort((p, q) => p - q));
    source.close();
    rec.detach();
    backend.dispose();
  });
});
