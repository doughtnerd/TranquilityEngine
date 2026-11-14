// ADR 0171 amended by 0172 (M5d, task So1, soak 4; architecture §4.2, §6, §7.3, §7.4 "real-scene capture rates"; record
// change 15): spike S3's capture measurement re-run on real scenes through the REAL core. Each sample's project is read from
// disk, its scene loaded in a headless Engine with its own scripts (ADR 0031), and the audio is the committed wasm on the
// loopback host behind a real `CoreBackend` (the project's buses, effects, rules and preset); `Audio.capture` records it as
// it records a game (the default ring, G7b's keyframe source, the real `EventSink`). Scenes:
//
// - **Sound Lab, Mixer page** (`samples/sound-lab`, `scenes/mixer.scene.json`): the page's beds plus its tour (key 3: the
//   voice, a burst, both, quiet), its three ducking rules and the project's metered buses. Clips: the sample's WAVs.
// - **Audio Stress** (`samples/stress`, `scenes/main.scene.json`, high preset): the storm (about 200 starts a second, 4,096
//   logical, 256 mixed), 32 buses with effects, churn, snapshots, emitters and streams. Clips: the sample's own generator
//   (`scripts/clips.ts`, 64 MiB of blob URLs, read back through `node:buffer`). Its readout (`scripts/hud.ts`, DOM) is stubbed.
//
// Each scene: a warm-up on the audio clock (the Stress storm needs its clip generation, warm-up and prefill), then 60 s of
// rendered audio recorded. Logged: bytes per minute (raw ring, the saved file deflated) against 0172's 0.27 / 0.84 / 2.45
// MB/min at 64 / 256 / 1,024 voices (W7 measured +12-19 %), and main's recorder cost per audio second (the tap: STATUS copy
// and keyframes; the sink's event writes) against §7.3's 1 ms. Never a wall-clock assertion: the cases assert the audio
// clock (60 s recorded), that the scene ran (voices live, the take saved and non-empty) and that the save opens. Run alone
// (about 3 to 6 minutes of wall time):
//
//   npx vitest run --config tools/audio-bench/soak.vitest.config.mts realScenes
import { readFileSync, existsSync } from "node:fs";
import { resolveObjectURL } from "node:buffer";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, Input, SceneManager } from "../../../../myco";
import { mixer } from "../../../../engine/audio/mixer";
import { parseAudioSettings } from "../../../../engine/audio/settings";
import { readProject } from "../../../../server/project";
import { setAudioBackend, type AudioBackend } from "../backend";
import type { AudioHost, CoreLink } from "../core/context";
import { presetFromSettings } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { createClipRegistry } from "../core/clipRegistry";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import { _resetHandleWarningsForTests } from "../core/handle";
import { events } from "../events/eventRuntime";
import { createLoopbackHost, type LoopbackHost } from "../testing";
import { audioCapture, releaseCapture, setCaptureProject, _setRecorderLoader, _setSaveEnv, type RecorderModule } from "./capture";
import { openCapture } from "./reader";
import type { Recorder } from "./recorder";
import { RecordType } from "./format";
import { FRAME_QUANTA, FRAME_SECONDS, RATE, bytesByType, memorySaveEnv, stat, timedCallOverheadUs, timedSink } from "./soakSupport";

// The Stress readout draws into the DOM; the soak runs in Node, so it is a no-op here (the storm itself is unchanged).
vi.mock("../../../../../samples/stress/scripts/hud", () => ({
  Hud: class {
    frame(): void {}
    toggle(): void {}
    toggleSoak(): void {}
    sample(): void {}
    setPlan(): void {}
    setLoading(): void {}
    stormStarted(): void {}
    /** The storm's own `info()` (phase, storm seconds), kept where the soak reads it. */
    api(info: () => unknown): unknown {
      (globalThis as { __so1StressInfo?: () => unknown }).__so1StressInfo = info;
      return {};
    }
    dispose(): void {}
  },
}));
// Both samples' scripts, registered as loading a project's scripts would.
import.meta.glob("../../../../../samples/sound-lab/scripts/behaviors/*.ts", { eager: true });
import.meta.glob("../../../../../samples/stress/scripts/behaviors/*.ts", { eager: true });

const SAMPLES = fileURLToPath(new URL("../../../../../samples/", import.meta.url));
const MEASURE_SECONDS = 60;
const RENDER = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;

/** 0172's sizes (S3's raw stream deflated, MB per minute) by voice count. */
const S3_DEFLATED: [number, number][] = [[64, 0.27], [256, 0.84], [1024, 2.45]];

/** A 16-bit PCM WAV's planar samples (the sample clips and the Stress generator's are all 16-bit PCM). */
function parseWav(bytes: ArrayBuffer): PlanarClip {
  const v = new DataView(bytes);
  let off = 12;
  let rate = 0;
  let channels = 1;
  for (;;) {
    const id = String.fromCharCode(v.getUint8(off), v.getUint8(off + 1), v.getUint8(off + 2), v.getUint8(off + 3));
    const size = v.getUint32(off + 4, true);
    if (id === "fmt ") {
      channels = v.getUint16(off + 10, true);
      rate = v.getUint32(off + 12, true);
    } else if (id === "data") {
      const frames = Math.floor(size / 2 / channels);
      const data = Array.from({ length: channels }, () => new Float32Array(frames));
      for (let f = 0; f < frames; f++) for (let c = 0; c < channels; c++) data[c]![f] = v.getInt16(off + 8 + (f * channels + c) * 2, true) / 32768;
      return { frames, channels, sampleRate: rate, channelData: data };
    }
    off += 8 + size + (size & 1);
  }
}

interface SceneSpec {
  name: string;
  sample: string;
  scene: string;
  /** Keys pressed once the scene has loaded. */
  keys: string[];
  /** Audio seconds before the take starts, or until `ready` says so (whichever is later), capped at `maxWarm`. */
  warm: number;
  maxWarm: number;
  ready?: () => boolean;
}

interface SceneResult {
  name: string;
  liveAvg: number;
  liveMax: number;
  mixedAvg: number;
  seconds: number;
  ringBytes: number;
  fileBytes: number;
  tapMsPerS: number;
  keyframeMsPerS: number;
  sinkMsPerS: number;
  sinkCallsPerS: number;
  /** `timedSink`'s own cost per call, µs. */
  overheadUs: number;
  byType: Record<string, number>;
  tap: { n: number; median: number; p95: number; max: number };
  events: number;
  keyframes: number;
  warmSeconds: number;
  wall: number;
}

let engine: Engine | null = null;
afterEach(() => {
  releaseCapture();
  if (engine) engine.world.render = undefined as never;
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  events()._reset();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

/** A blob URL's bytes, or a file of the sample. */
async function fetchFrom(dir: string, path: string): Promise<ArrayBuffer> {
  const url = path.startsWith("blob:") ? path : ((globalThis as { __stressClipSource?: { get(p: string): unknown } }).__stressClipSource?.get(path) as string | undefined);
  if (url?.startsWith("blob:")) {
    const blob = resolveObjectURL(url);
    if (!blob) throw new Error(`no blob for ${path}`);
    return blob.arrayBuffer();
  }
  const file = dir + path;
  if (!existsSync(file)) throw new Error(`no file ${path}`);
  const b = readFileSync(file);
  return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
}

async function runScene(spec: SceneSpec): Promise<SceneResult | null> {
  const wall0 = performance.now();
  const dir = SAMPLES + spec.sample + "/";
  const project = await readProject(dir);
  const parsed = parseAudioSettings((project.settings as { audio?: unknown }).audio ?? {});
  const settings = parsed.settings;
  const preset = presetFromSettings(settings);
  let loop: LoopbackHost & { link: CoreLink };
  try {
    loop = (await createLoopbackHost({ preset })) as typeof loop;
  } catch {
    return null;
  }
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _resetHandleWarningsForTests();
  events()._reset();
  const link = loop.link;
  const clips = createClipRegistry({
    send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes: (p) => fetchFrom(dir, p), decodeWorker: fakeDecoder(async (b) => parseWav(b)),
    nextFrame: (cb) => cb(), nextQuantum: (cb) => cb(),
  });
  mixer.configure(settings);
  const host: CoreBackendHost = {
    link, status: "running", preset: { maxLogical: preset.maxLogical, maxMixed: preset.maxMixed }, worldCount: 1, sampleRate: RATE,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  // The sink `Audio.capture` installs, wrapped to time each call (`timedSink`).
  const sinkTimer = { ms: 0, calls: 0 };
  const setSink = backend.setProfileSink.bind(backend);
  let sinkTarget: { eventsWritten: number } | null = null;
  backend.setProfileSink = (sink) => {
    if (!sink) return setSink(null);
    sinkTarget = sink as unknown as { eventsWritten: number };
    setSink(timedSink(sink, sinkTimer));
  };
  setAudioBackend(backend as AudioBackend);

  Assets.clearSources();
  Assets.addSource(project.assets);
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = RENDER;
  await SceneManager.load(spec.scene);

  let audioSeconds = 0;
  let liveSum = 0;
  let liveMax = 0;
  let mixedSum = 0;
  let statusN = 0;
  const step = async (record: boolean): Promise<void> => {
    engine!.step(FRAME_SECONDS);
    await new Promise<void>((r) => setImmediate(r)); // clip fetches and decodes resolve
    loop.renderQuanta(FRAME_QUANTA);
    if (record) {
      for (const s of loop.statuses) {
        liveSum += s.liveVoices;
        mixedSum += s.mixedVoices;
        liveMax = Math.max(liveMax, s.liveVoices);
        statusN++;
      }
    }
    loop.statuses.length = 0;
    audioSeconds += FRAME_SECONDS;
  };
  await step(false);
  for (const key of spec.keys) {
    Input.simulate("down", key);
    await step(false);
    Input.simulate("up", key);
    await step(false);
  }
  while (audioSeconds < spec.maxWarm && (audioSeconds < spec.warm || (spec.ready && !spec.ready()))) await step(false);
  const warmSeconds = audioSeconds;

  // The take, on the product's path.
  let rec: Recorder | null = null;
  const restoreLoader = _setRecorderLoader(async () => {
    const m = await import("./recorder");
    return { ...m, createRecorder: (o?: Parameters<RecorderModule["createRecorder"]>[0]) => (rec = m.createRecorder(o)) } as RecorderModule;
  });
  const env = memorySaveEnv();
  const restoreEnv = _setSaveEnv(env);
  setCaptureProject(() => ({ name: spec.name, version: "So1" }));
  await audioCapture.start();
  const r = rec as unknown as Recorder;
  const tap = backend.recorderTap!;
  const tapUs: number[] = [];
  let tapMs = 0;
  let keyframeMs = 0;
  let firstTapFrame = -1;
  backend.recorderTap = (data, byteLength, view) => {
    if (firstTapFrame < 0) firstTapFrame = (view ?? new DataView(data)).getFloat64(16, true);
    const kf = r.lastKeyframeFrame;
    const t0 = performance.now();
    tap(data, byteLength, view);
    const dt = performance.now() - t0;
    tapMs += dt;
    if (r.lastKeyframeFrame !== kf) keyframeMs += dt;
    else tapUs.push(dt * 1000);
  };
  sinkTimer.ms = 0;
  sinkTimer.calls = 0;
  const startEvents = sinkTarget ? (sinkTarget as { eventsWritten: number }).eventsWritten : 0;
  const frames = Math.round(MEASURE_SECONDS / FRAME_SECONDS);
  for (let f = 0; f < frames; f++) await step(true);
  const seconds = (r.newestStatusFrame - firstTapFrame) / RATE + (FRAME_QUANTA * 128) / RATE; // blocks from the first one taken to the last, each 768 frames
  const sinkMsTotal = sinkTimer.ms;
  const sinkCalls = sinkTimer.calls;
  const eventCount = (sinkTarget ? (sinkTarget as { eventsWritten: number }).eventsWritten : 0) - startEvents;
  backend.recorderTap = tap;
  audioCapture.stop();
  const ringBytes = r.ring.usedBytes;
  expect(r.ring.evicted, "the 60 s fit the default ring").toBe(0);
  expect(r.ring.dropped).toBe(0);
  await audioCapture.save(spec.name.replace(/\W+/g, "-"));
  const file = env.files[0]!.bytes;
  const opened = await openCapture(file);
  _setRecorderLoader(restoreLoader);
  _setSaveEnv(restoreEnv);
  expect(Math.abs(seconds - MEASURE_SECONDS)).toBeLessThan(0.05);
  expect(opened.keyframes.length, "a keyframe a second of rendered frames").toBeGreaterThanOrEqual(MEASURE_SECONDS - 1);
  const result: SceneResult = {
    name: spec.name, liveAvg: liveSum / Math.max(1, statusN), liveMax, mixedAvg: mixedSum / Math.max(1, statusN), seconds, ringBytes, fileBytes: file.byteLength,
    tapMsPerS: tapMs / seconds, keyframeMsPerS: keyframeMs / seconds, sinkMsPerS: sinkMsTotal / seconds, sinkCallsPerS: sinkCalls / seconds, overheadUs: timedCallOverheadUs(), byType: bytesByType(opened, RecordType), tap: stat(tapUs), events: eventCount, keyframes: opened.keyframes.length, warmSeconds,
    wall: (performance.now() - wall0) / 1000,
  };
  backend.dispose();
  return result;
}

function s3For(voices: number): string {
  // 0172's deflated size at the nearest of S3's scenes by live voices (log scale), with W7's +12-19 %.
  let best = S3_DEFLATED[0]!;
  for (const row of S3_DEFLATED) if (Math.abs(Math.log(row[0] / Math.max(1, voices))) < Math.abs(Math.log(best[0] / Math.max(1, voices)))) best = row;
  return `${best[1]} (${best[0]} voices; +12-19 %: ${(best[1] * 1.12).toFixed(2)}-${(best[1] * 1.19).toFixed(2)})`;
}

function report(r: SceneResult): string {
  const mbMin = (bytes: number) => ((bytes / r.seconds) * 60 / 1e6).toFixed(3);
  return [
    `So1 soak 4, S3 on a real scene: ${r.name}, through the real core, default ring, ${r.seconds.toFixed(1)} s recorded after ${r.warmSeconds.toFixed(1)} s warm-up (container, wall ${r.wall.toFixed(0)} s)`,
    "| measure | value |",
    "|---|---|",
    `| live voices avg / max; mixed avg | ${r.liveAvg.toFixed(0)} / ${r.liveMax}; ${r.mixedAvg.toFixed(0)} |`,
    `| ring MB/min raw | ${mbMin(r.ringBytes)} |`,
    `| saved file (deflated) MB/min | ${mbMin(r.fileBytes)} |`,
    `| 0172's deflated MB/min at the nearest S3 scene | ${s3For(r.liveAvg)} |`,
    `| ring MB/min by record type | ${Object.entries(r.byType).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${mbMin(v)}`).join(", ")} |`,
    `| STATUS blocks/s through the tap (keyframes); events/s | ${((r.tap.n + r.keyframes) / r.seconds).toFixed(1)} (${r.keyframes}); ${(r.events / r.seconds).toFixed(0)} |`,
    `| tap per STATUS-only block us (median / p95 / max) | ${r.tap.median.toFixed(1)} / ${r.tap.p95.toFixed(1)} / ${r.tap.max.toFixed(0)} |`,
    `| main recorder ms per audio s: tap (of which keyframe blocks) + sink = total (allowance 1 ms at 1,024 voices) | ${r.tapMsPerS.toFixed(3)} (${r.keyframeMsPerS.toFixed(3)}) + ${r.sinkMsPerS.toFixed(3)} = ${(r.tapMsPerS + r.sinkMsPerS).toFixed(3)} |`,
    `| sink calls/s x the timing wrapper's own ${r.overheadUs.toFixed(3)} us = ms/s inside the sink figure | ${r.sinkCallsPerS.toFixed(0)} x ${r.overheadUs.toFixed(3)} = ${((r.sinkCallsPerS * r.overheadUs) / 1000).toFixed(3)} |`,
  ].join("\n");
}

describe("soak 4: spike S3's capture measurement on real scenes through the real core (§7.4)", () => {
  it("the Sound Lab's Mixer page, its tour running", async (ctx) => {
    const r = await runScene({ name: "Sound Lab Mixer page (tour)", sample: "sound-lab", scene: "scenes/mixer.scene.json", keys: ["3"], warm: 5, maxWarm: 5 });
    if (!r) return ctx.skip();
    expect(r.liveMax).toBeGreaterThanOrEqual(3); // the two beds and the tour's voice or burst
    console.log(report(r));
  });

  it("the Audio Stress sample's storm (high preset)", async (ctx) => {
    // The take starts once the storm runs (its clips generated and warmed) and its 12 s prefill has filled the logical voices.
    const info = (): { phase?: string; stormSeconds?: number } => ((globalThis as { __so1StressInfo?: () => { phase?: string; stormSeconds?: number } }).__so1StressInfo?.() ?? {});
    const r = await runScene({
      name: "Audio Stress storm (high preset)", sample: "stress", scene: "scenes/main.scene.json", keys: [], warm: 20, maxWarm: 300,
      ready: () => info().phase === "running" && (info().stormSeconds ?? 0) >= 15,
    });
    if (!r) return ctx.skip();
    expect(info().phase).toBe("running");
    expect(r.liveAvg).toBeGreaterThan(1000);
    console.log(report(r));
  });
});
