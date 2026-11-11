// ADR 0162 B6: ambisonic clips end to end on the loopback host (the real mixer wasm, the real decoder worker run
// in-process, the clip registry and the core backend). The clips are generated at run time by the Sound Lab's
// `makeAmbisonic.mjs` (a tone encoded at an azimuth, AmbiX and its FuMa twin) and decoded from WAV bytes with their
// sidecars. Checks the image sits at the encoded azimuth through a bed and through a private decoder (the left and
// right energies are the interaural level difference, which grows monotonically with the azimuth and mirrors for the
// opposite side), that turning the listener 90 degrees moves it by 90 degrees, and that a FuMa twin plays the same
// as its AmbiX clip once B2's import gain is applied. No MagLS filters are loaded, so beds and private decoders decode
// through the baked matrix (R9).
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { Assets } from "../../../../engine/scene/Assets";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
// @ts-expect-error a plain ES module with no declarations: the Sound Lab's generator
import { ambisonicWav, channelsOf, encodeTone, fumaFromAmbix, tone } from "../../../../../samples/sound-lab/tools/makeAmbisonic.mjs";
import { createDecoderClient, type WorkerLike } from "../decoder/decoderClient";
import { createDecoderHandler } from "../decoder/handler";
import type { DecoderRequest } from "../decoder/protocol";
import hash from "../wasm/hash.json";
import type { AudioHost } from "./context";
import { ambisonicImportGain, createClipRegistry } from "./clipRegistry";
import { CoreBackend, type CoreBackendHost } from "./coreBackend";

const RATE = 48_000;
const WASM = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const wasmBytes = () => WASM.buffer.slice(WASM.byteOffset, WASM.byteOffset + WASM.byteLength) as ArrayBuffer;

/** An in-process decoder worker around the real handler (as clipRegistryWorker.test.ts). */
function inProcessWorker(): () => WorkerLike {
  return () => {
    const worker: WorkerLike = {
      onmessage: null,
      onerror: null,
      postMessage(message: DecoderRequest, transfer) {
        void handler.handle(structuredClone(message, { transfer: transfer ?? [] }));
      },
      terminate() {},
    };
    const handler = createDecoderHandler({
      post: (reply, transfer) => {
        const cloned = structuredClone(reply, { transfer: transfer ?? [] });
        queueMicrotask(() => worker.onmessage?.({ data: cloned }));
      },
      expectedSourceHash: hash.sourceHash,
    });
    return worker;
  };
}

const toBuffer = (b: Buffer): ArrayBuffer => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
/** A 0.4 s 440 Hz tone, looped by the voice so every render sees it. */
const MONO = tone(440, 0.4, RATE, 0.5) as Float32Array;

type Where = "bed" | "decoder";

async function rig(where: Where, files: Record<string, ArrayBuffer>) {
  const testing = await import("../testing");
  const preset = { ...testing.LOOPBACK_PRESET, limiterLookaheadMs: 0, maxBeds: where === "bed" ? 1 : 0, maxWide: 1 };
  const loop = await testing.createLoopbackHost({ preset });
  const link = loop.link;
  const client = createDecoderClient({ workerFactory: inProcessWorker(), wasmBytes: wasmBytes() });
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async (path: string) => {
      const f = files[path];
      if (!f) throw new Error("HTTP 404");
      return f.slice(0);
    },
    decodeWorker: client,
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { maxLogical: 16, maxMixed: 8, maxBeds: preset.maxBeds, maxWide: preset.maxWide },
    worldCount: 1,
    sampleRate: RATE,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const mixer = new Mixer(defaultAudioSettings());
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const left: number[] = [];
  const right: number[] = [];
  const step = async (n: number) => {
    for (let f = 0; f < n; f++) {
      mixer.update(0.003);
      backend.update(0.003);
      const out = loop.renderQuanta(4);
      left.push(...out.left);
      right.push(...out.right);
      await new Promise((r) => setTimeout(r, 1));
    }
  };
  /** The energies of what was rendered since the last call (the tail: after the clip's upload and its fade-in). */
  const measure = () => {
    const from = Math.max(0, left.length - 4800);
    let l = 0;
    let r = 0;
    for (let i = from; i < left.length; i++) {
      l += left[i]! ** 2;
      r += right[i]! ** 2;
    }
    left.length = 0;
    right.length = 0;
    return { l, r, ild: (l - r) / (l + r || 1) };
  };
  /** The head turned `deg` degrees to the left (a cut): the world to listener quaternion about +Y. */
  const turnHead = (deg: number) => {
    const a = (-deg * Math.PI) / 360;
    backend.writer.listener(0, Math.sin(a), 0, Math.cos(a), 0, true);
  };
  return { backend, step, measure, turnHead, loop, client, clips };
}

const wavs = (order: 1 | 2 | 3, az: number, el = 0) => {
  const ambix = encodeTone(MONO, az, el, order) as Float32Array[];
  return { ambix: toBuffer(ambisonicWav(ambix, RATE)), fuma: toBuffer(ambisonicWav(fumaFromAmbix(ambix), RATE)) };
};

/** Registers `name`'s sidecar and plays it (looping, ambisonic, on the master bus) at the import volume. */
async function playAmbisonic(r: Awaited<ReturnType<typeof rig>>, name: string, convention: "ambix" | "fuma", yaw?: number) {
  Assets.addSource(Assets.fromObject({ [`${name}.meta.json`]: { format: "myco.import@1", ambisonic: { convention } } }));
  // Load first: a FuMa clip's import gain is known once its decode has reported (a play before that would miss it).
  r.clips.acquire(name);
  await r.step(20);
  return r.backend.play({ path: name, url: name, loop: true, stream: false, bus: "Master", ambisonic: true, volume: ambisonicImportGain(name), ...(yaw === undefined ? {} : { yaw }) })!;
}

afterEach(() => Assets.clearSources());

/** Plays an AmbiX clip encoded at `az` through `where` and returns its image after `turn` degrees of head turn. */
async function image(where: Where, order: 1 | 2 | 3, az: number, turn = 0) {
  const name = `a${order}-${az}.wav`;
  const r = await rig(where, { [name]: wavs(order, az).ambix });
  const voice = await playAmbisonic(r, name, "ambix");
  expect(voice).not.toBeNull();
  await r.step(30);
  expect(r.backend.mirror.ambisonicVoices).toBe(1);
  // The decode ran where it should: a hosted bed on the master bus, or none (a private decoder); both cost work_bed.
  expect(r.backend.mirror.bedCount).toBe(where === "bed" ? 1 : 0);
  expect(r.backend.mirror.workBed).toBeGreaterThan(0);
  if (turn !== 0) {
    r.turnHead(turn);
    await r.step(30);
  }
  r.measure();
  await r.step(30);
  const m = r.measure();
  r.client.dispose();
  return m;
}

describe("ambisonic clips on the loopback host (B6)", () => {
  for (const where of ["bed", "decoder"] as const) {
    for (const order of [1, 2, 3] as const) {
      it(`${channelsOf(order)} channels through a ${where}: the image sits at the encoded azimuth`, async () => {
        const front = await image(where, order, 0);
        expect(front.l + front.r).toBeGreaterThan(1e-3); // audible
        expect(Math.abs(front.ild)).toBeLessThan(0.01);
        let last = 0;
        for (const az of [30, 60, 90, 120]) {
          const a = await image(where, order, az);
          const b = await image(where, order, -az);
          // Mirror images: the opposite azimuth swaps the sides.
          expect(a.ild).toBeCloseTo(-b.ild, 2);
          expect(a.ild).toBeGreaterThan(0); // positive azimuth is to the left
          if (az <= 90) expect(a.ild).toBeGreaterThan(last); // more to the side as it goes round
          last = a.ild;
        }
      });

      it(`${channelsOf(order)} channels through a ${where}: a 90 degree head turn moves the image by 90 degrees`, async () => {
        // The head turns left: a source in front goes to the right, one on the left comes to the front.
        const frontToRight = await image(where, order, 0, 90);
        const leftToFront = await image(where, order, 90, 90);
        const sideAlone = await image(where, order, -90);
        expect(frontToRight.ild).toBeCloseTo(sideAlone.ild, 2);
        expect(Math.abs(leftToFront.ild)).toBeLessThan(0.01);
        expect(frontToRight.ild).toBeLessThan(-0.2);
      });
    }
  }

  it("a clip's yaw turns the field to the left, as a head turn to the right would", async () => {
    const r = await rig("decoder", { "y.wav": wavs(3, 0).ambix });
    await playAmbisonic(r, "y.wav", "ambix", 90);
    await r.step(30);
    r.measure();
    await r.step(30);
    expect(r.measure().ild).toBeGreaterThan(0.2);
    r.client.dispose();
  });

  for (const where of ["bed", "decoder"] as const) {
    for (const order of [1, 2, 3] as const) {
      it(`a FuMa twin of the ${channelsOf(order)}-channel clip plays the same as its AmbiX clip through a ${where}`, async () => {
        const w = wavs(order, 50, 20);
        const ambix = await rig(where, { "t.wav": w.ambix });
        await playAmbisonic(ambix, "t.wav", "ambix");
        await ambix.step(40);
        ambix.measure();
        await ambix.step(30);
        const want = ambix.measure();
        expect(ambisonicImportGain("t.wav")).toBe(1);
        ambix.client.dispose();
        Assets.clearSources();

        const fuma = await rig(where, { "t-fuma.wav": w.fuma });
        await playAmbisonic(fuma, "t-fuma.wav", "fuma");
        await fuma.step(40);
        expect(ambisonicImportGain("t-fuma.wav")).toBeCloseTo(Math.SQRT2, 6);
        fuma.measure();
        await fuma.step(30);
        const got = fuma.measure();
        fuma.client.dispose();
        expect(want.l + want.r).toBeGreaterThan(1e-3);
        expect(got.l / want.l).toBeCloseTo(1, 1);
        expect(got.r / want.r).toBeCloseTo(1, 1);
      });
    }
  }
});
