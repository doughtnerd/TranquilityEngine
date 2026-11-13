// The HRTF loopback rig, shared by hrtfLoopback.test.ts (state and frame counts, in `npm test`) and
// hrtfCost.bench.ts (the wall-clock cost of an HRTF voice, run apart from `npm test`).
import { fakeDecoder } from "./fakeDecoder";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import type { AudioHost } from "./context";
import { type CoreLink } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { createHrirLoader } from "./hrir";

/** The most frames `until` steps before it gives up (an escape hatch for a hung load, not a time budget). */
const UNTIL_FRAMES = 20_000;

export const att = { minDistance: 1, maxDistance: 100, rolloff: "inverse" as const };
export const req = (path: string, x: number, z: number, extra: object = {}) => ({ path, url: path, loop: true, stream: false, bus: "SFX", attenuation: att, position: { x, y: 0, z }, ...extra });

export async function readAsset(): Promise<ArrayBuffer> {
  const nodeFs = "node:fs/promises";
  const { readFile } = (await import(/* @vite-ignore */ nodeFs)) as { readFile(url: URL): Promise<Uint8Array> };
  const bytes = await readFile(new URL("../wasm/myco_hrir.bin", import.meta.url));
  return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
}

export async function rig(opts: { spatial?: "hrtf" | "equalPower"; hrtf?: number; failFetch?: boolean } = {}) {
  const testing = await import("../testing");
  let loop: Awaited<ReturnType<typeof testing.createLoopbackHost>> & { link: CoreLink };
  try {
    loop = (await testing.createLoopbackHost()) as typeof loop;
  } catch {
    return null;
  }
  const { createClipRegistry } = await import("./clipRegistry");
  const link = loop.link;
  const frames = 48_000;
  const tone = new Float32Array(frames).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames, channels: 1, sampleRate: 48_000, channelData: [tone] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  let fetches = 0;
  const warnings: string[] = [];
  const hrir = createHrirLoader({
    clips,
    sampleRate: 48_000,
    warn: (m) => warnings.push(m),
    fetchBytes: async () => {
      fetches++;
      if (opts.failFetch) throw new Error("HTTP 404");
      return readAsset();
    },
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 256, maxMixed: 32 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const settings = defaultAudioSettings();
  settings.spatial = opts.spatial ?? "hrtf";
  settings.voices = { ...settings.voices, hrtf: opts.hrtf ?? 16 };
  const mixer = new Mixer(settings);
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer, hrir });
  const hrtfSeen: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      loop.renderQuanta(4);
      hrtfSeen.push(backend.mirror.hrtfVoices);
      await new Promise((r) => setImmediate(r)); // a macrotask turn for the HRIR file read; no timer, no clock
    }
  };
  /**
   * Steps one frame at a time until `done()` (work done: the table resident, a counter read), yielding a real
   * millisecond between frames so the HRIR read and decode get CPU when the machine is busy. The frame budget is an
   * escape hatch for a hung load, never the measure: the assertions count frames and state, not wall time.
   */
  const until = async (done: () => boolean, what: string) => {
    for (let k = 0; k < UNTIL_FRAMES && !done(); k++) {
      await step(1);
      if (!done()) await new Promise((res) => setTimeout(res, 1));
    }
    if (!done()) throw new Error(`gave up waiting for ${what}`);
  };
  return { loop, backend, mixer, step, until, fetches: () => fetches, warnings, hrtfSeen };
}
