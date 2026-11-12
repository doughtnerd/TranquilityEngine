// F-40: the Sound Lab spatial page's Doppler pass-by (samples/sound-lab, scenes/spatial.scene.json) on the loopback
// host: the real scene, its 3D physics World and occluders, the three reverb zones with the decoder wasm's kernels,
// HRTF with the shipped table, the real core wasm and the core backend, driven by `engine.step` (6 quanta a frame).
// Only the flyover plays (the page's 0, then V), its clip a 200 Hz sine, with the listener standing in room 1 (the
// Walker's `room` station) or room 2 (`corridor`).
//
// The owner heard a click or two as the ball reached room 3. It was the cave zone's send starting and settling at 0
// while the occlusion low-pass ran: the voice chain moved the dry gain across the filters (before them without a send,
// after them with one) and the filters' history kept the old units: a step of 0.13 to 0.15 when the send settled, 0.008
// when it started. Without the clicks the output's largest second difference (x[n] - 2x[n-1] + x[n-2]) over the run
// from 0.25 s is 1.6e-3; the bound is 5e-3.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Assets, AudioSource, Engine, GameObject, SceneManager } from "../../../../myco";
import { readProject } from "../../../../server/project";
import "../../../../../samples/sound-lab/scripts/behaviors/Door";
import "../../../../../samples/sound-lab/scripts/behaviors/ListeningBench";
import "../../../../../samples/sound-lab/scripts/behaviors/PassBy";
import "../../../../../samples/sound-lab/scripts/behaviors/SceneSwitch";
import "../../../../../samples/sound-lab/scripts/behaviors/Toggle";
import { Walker } from "../../../../../samples/sound-lab/scripts/behaviors/Walker";
import { mixer as globalMixer, registerCoreBackend, resetCoreFallbackState, setAudioBackend } from "../backend";
import { createDecoderHandler } from "../decoder/handler";
import type { DecoderReply, IrFailedMessage, IrPreparedMessage, StreamPortLike } from "../decoder/protocol";
import hash from "../wasm/hash.json";
import { createClipRegistry } from "./clipRegistry";
import { presetFromSettings, type AudioHost } from "./context";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";
import { fakeDecoder } from "./fakeDecoder";
import { createHrirLoader } from "./hrir";
import { createZoneIrService } from "./zoneIr";

const SAMPLE = fileURLToPath(new URL("../../../../../samples/sound-lab", import.meta.url));
const DECODER = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const HRIR = readFileSync(fileURLToPath(new URL("../wasm/myco_hrir.bin", import.meta.url)));
const RATE = 48_000;
const QUANTA_PER_FRAME = 6;
const DT = (QUANTA_PER_FRAME * 128) / RATE;
/** The run: the ball enters the cave zone at about 1.1 s, leaves it at 1.75 s, comes back at 2.7 s and leaves at 3.35 s. */
const SECONDS = 4;
const BOUND = 5e-3;
const slice = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

let undo: (() => void) | null = null;
let engine: Engine | null = null;
beforeEach(() => {
  setAudioBackend(null);
  resetCoreFallbackState();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});
afterEach(() => {
  undo?.();
  undo = null;
  if (engine) engine.world.render = undefined as never;
  engine?.dispose();
  engine = null;
  Assets.clearSources();
  setAudioBackend(null);
  resetCoreFallbackState();
  vi.restoreAllMocks();
});

/** Runs the pass-by with the listener held at `station`; returns the output, planar, from the flyover's start. */
async function passBy(station: "room" | "corridor"): Promise<{ left: number[]; right: number[] }> {
  const project = await readProject(SAMPLE);
  Assets.clearSources();
  Assets.addSource(project.assets);
  engine = await Engine.create({ headless: true, project: project.settings });
  engine.world.render = { release() {}, warmUp: async () => {}, preloadTextures: async () => {} } as never;
  const preset = presetFromSettings(globalMixer.audioSettings);
  const testing = await import("../testing");
  const loop = await testing.createLoopbackHost({ preset });
  const link = loop.link;
  // The decoder worker in-process (the zones' kernels), its worklet port delivering into the shell.
  const irListeners: ((r: IrPreparedMessage | IrFailedMessage) => void)[] = [];
  const handler = createDecoderHandler({
    post: (r: DecoderReply) => {
      if (r.type === "irPrepared" || r.type === "irFailed") for (const l of irListeners) l(r);
    },
    expectedSourceHash: hash.sourceHash,
    fetchBytes: async () => {
      throw new Error("no assets here");
    },
  });
  await handler.handle({ type: "init", wasmBytes: slice(DECODER) });
  const port: StreamPortLike = { onmessage: null, postMessage: (m: unknown) => loop.send(m as ArrayBuffer) };
  await handler.handle({ type: "connectWorklet", port } as never);
  const pending: Promise<void>[] = [];
  const zoneIr = createZoneIrService({ sampleRate: RATE, decoder: { postIr: (req) => void pending.push(handler.handle(req)), onIr: (l) => (irListeners.push(l), () => {}) } });
  // Every clip decodes to a 200 Hz sine (a whole number of cycles: it loops without a seam).
  const tone = new Float32Array(RATE).map((_, i) => 0.3 * Math.sin((2 * Math.PI * 200 * i) / RATE));
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames: tone.length, channels: 1, sampleRate: RATE, channelData: [tone] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const hrir = createHrirLoader({ clips, sampleRate: RATE, warn: () => {}, fetchBytes: async () => slice(HRIR) });
  const host: CoreBackendHost = { link, status: "running", preset, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer: globalMixer, zoneIr, hrir });
  undo = registerCoreBackend(() => backend);
  await SceneManager.load("scenes/spatial.scene.json");
  const walker = GameObject.findObjectOfType(Walker)!;
  const left: number[] = [];
  const right: number[] = [];
  const step = async (frames: number, record: boolean) => {
    for (let f = 0; f < frames; f++) {
      walker.transform.position.z = walker[station];
      engine!.step(DT);
      const out = loop.renderQuanta(QUANTA_PER_FRAME);
      if (record) {
        for (const s of out.left) left.push(s);
        for (const s of out.right) right.push(s);
      }
      await Promise.all(pending.splice(0));
      for (let k = 0; k < 4; k++) await Promise.resolve();
    }
  };
  await step(30, false); // the zones' kernels and the HRTF table load
  const sources = GameObject.findObjectsOfType(AudioSource);
  const flyover = sources.find((s) => String(s.clip).includes("hum-loop"))!;
  for (const s of sources) if (s !== flyover) s.stop();
  flyover.play();
  await step(Math.ceil(SECONDS / DT), true);
  // The run crossed the cave zone with the occlusion low-pass running (what clicked).
  expect(backend.zones.counters.irPrepares).toBe(3);
  return { left, right };
}

/** The largest |x[n] - 2x[n-1] + x[n-2]| of either channel, from `from`, and where. */
function worstSecondDifference(out: { left: number[]; right: number[] }, from: number): { value: number; at: number } {
  let value = 0;
  let at = -1;
  for (const x of [out.left, out.right]) {
    for (let i = Math.max(2, from); i < x.length; i++) {
      const d = Math.abs(x[i]! - 2 * x[i - 1]! + x[i - 2]!);
      if (d > value) {
        value = d;
        at = i;
      }
    }
  }
  return { value, at };
}

describe("the Sound Lab pass-by on the loopback host (F-40)", () => {
  it.each(["corridor", "room"] as const)("does not click with the listener at the %s station", async (station) => {
    const out = await passBy(station);
    expect(out.left.length).toBe(Math.ceil(SECONDS / DT) * QUANTA_PER_FRAME * 128);
    // From 0.25 s: the first quanta hold the page going quiet (the other sources' stops) and the flyover's start.
    const worst = worstSecondDifference(out, RATE / 4);
    expect(worst.value, `at ${(worst.at / RATE).toFixed(3)} s`).toBeLessThan(BOUND);
  }, 120_000);
});
