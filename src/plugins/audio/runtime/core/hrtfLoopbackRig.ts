// The HRTF loopback rig, shared by hrtfLoopback.test.ts (state and frame counts, in `npm test`) and
// hrtfCost.bench.ts (the wall-clock cost of an HRTF voice, run apart from `npm test`).
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { createHrirLoader } from "./hrir";
import { inProcessSpatialPrepare, loopbackAudio } from "../testing";

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

export async function rig(opts: { spatial?: "hrtf" | "equalPower"; hrtf?: number; failFetch?: boolean; clip?: Float32Array } = {}) {
  const frames = 48_000;
  const tone = opts.clip ?? new Float32Array(frames).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  let fetches = 0;
  const warnings: string[] = [];
  const settings = defaultAudioSettings();
  settings.spatial = opts.spatial ?? "hrtf";
  settings.voices = { ...settings.voices, hrtf: opts.hrtf ?? 16 };
  // ADR 0221: the production assembly on the loopback, with its own mixer; the HRIR loader on the rig's registry.
  const audio = await loopbackAudio({
    mixer: "own",
    settings,
    decode: () => ({ channelData: [tone] }),
    recovery: { now: () => 0, warn: () => {} },
    backend: (clips) => ({
      hrir: createHrirLoader({
        clips,
        sampleRate: 48_000,
        prepare: inProcessSpatialPrepare(),
        warn: (m) => warnings.push(m),
        fetchBytes: async () => {
          fetches++;
          if (opts.failFetch) throw new Error("HTTP 404");
          return readAsset();
        },
      }),
    }),
  });
  if (!audio) return null;
  const { backend, mixer, link } = audio;
  const hrtfSeen: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      audio.tick(0.003);
      audio.render(4);
      hrtfSeen.push(link.lastStatus?.hrtfVoices ?? 0);
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
  return { loop: audio, host: audio.host, backend, mixer, step, until, fetches: () => fetches, warnings, hrtfSeen };
}
