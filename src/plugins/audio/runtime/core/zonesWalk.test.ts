// ADR 0162 C5 acceptance (api-and-models §10 C5): a voice, with the listener, walks from zone A to B to C on the
// loopback host: the real mixer wasm with zone slots laid out, the real decoder wasm generating the preset kernels
// (`generateIr`) and sending them to the worklet as format 3 clips, C2b's `ZoneIrService`, and the core backend's
// zone manager. Both slot paths (OD2): high and default with a standby slot (the outgoing zone rings out beside the
// incoming one), low with one slot (the outgoing zone is evicted with the 150 ms fade, and the incoming zone waits for
// the slot and its kernel). The sends reach the slots only in a wasm with C4 (core sends): run it on a build that has it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { Mixer } from "../../../../engine/audio/mixer";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import { AudioReverbZone } from "../AudioReverbZone";
import type { AudioHost } from "./context";
import type { CoreBackendHost } from "./coreBackend";
import { fakeDecoder } from "./fakeDecoder";
import { createDecoderHandler } from "../decoder/handler";
import type { DecoderReply, IrFailedMessage, IrPreparedMessage, StreamPortLike } from "../decoder/protocol";
import hash from "../wasm/hash.json";
import { LOOPBACK_PRESET } from "../testing";
import { ZoneState } from "../wire.generated";
import { ListenerFrame } from "./spatial";
import { createZoneIrService } from "./zoneIr";

const DECODER = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));

async function rig(slots: number, maxActive: number, standby: number) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  await Engine.create({ headless: true });
  await SceneManager.load("s.json");
  const testing = await import("../testing");
  const loop = await testing.createLoopbackHost({ preset: { ...LOOPBACK_PRESET, maxZoneSlots: slots, zoneMaxSeconds: 1 } });
  // The decoder worker in-process: its worklet port delivers into the shell as the real port would.
  const listeners: ((r: IrPreparedMessage | IrFailedMessage) => void)[] = [];
  const handler = createDecoderHandler({
    post: (r: DecoderReply) => {
      if (r.type === "irPrepared" || r.type === "irFailed") for (const l of listeners) l(r);
    },
    expectedSourceHash: hash.sourceHash,
    fetchBytes: async () => {
      throw new Error("no assets here");
    },
  });
  await handler.handle({ type: "init", wasmBytes: DECODER.buffer.slice(DECODER.byteOffset, DECODER.byteOffset + DECODER.byteLength) as ArrayBuffer });
  const port: StreamPortLike = { onmessage: null, postMessage: (m: unknown) => loop.send(m as ArrayBuffer) };
  await handler.handle({ type: "connectWorklet", port } as never);
  const pending: Promise<void>[] = [];
  const zoneIr = createZoneIrService({
    sampleRate: 48_000,
    decoder: {
      postIr: (req) => void pending.push(handler.handle(req)),
      onIr: (l) => (listeners.push(l), () => {}),
    },
  });
  const { createClipRegistry } = await import("./clipRegistry");
  const { CoreBackend } = await import("./coreBackend");
  const link = loop.link;
  const tone = new Float32Array(48_000).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const clips = createClipRegistry({
    send: (m) => link.post(m),
    nextSeq: () => link.nextSeq(),
    fetchBytes: async () => new ArrayBuffer(8),
    decodeWorker: fakeDecoder(async () => ({ frames: tone.length, channels: 1, sampleRate: 48_000, channelData: [tone] })),
    nextFrame: (cb) => cb(),
    nextQuantum: (cb) => cb(),
  });
  const host: CoreBackendHost = {
    link,
    status: "running",
    preset: { ...LOOPBACK_PRESET, maxZoneSlots: slots, zoneMaxSeconds: 1 },
    worldCount: 1,
    sampleRate: 48_000,
    addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"],
  };
  const settings = defaultAudioSettings();
  settings.zones = { maxActive, standby, maxIrSeconds: 1 };
  const mixer = new Mixer(settings);
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warnings.push(String(m));
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer, zoneIr });
  const frame = new ListenerFrame();
  let world: import("../../../../engine/core/World").World | null = null;
  const pose = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: -1 }, up: { x: 0, y: 1, z: 0 } };
  const step = async () => {
    mixer.update(0.016);
    backend.frameAttenuate(0.016);
    backend.collectSpatialVoices();
    frame.set(world, 0, null, pose, 0.016);
    backend.zones.run(frame, backend.spatialVoices, mixer.audioSettings);
    backend.frameSelect();
    backend.framePickPanners();
    backend.frameStageFx();
    backend.frameStageListener(frame);
    backend.frameCommit();
    loop.renderQuanta(6);
    await Promise.all(pending.splice(0));
    await new Promise((r) => setTimeout(r, 0));
  };
  const zone = (name: string, x: number, preset: string) => {
    const node = GameObject.create(name);
    node.transform!.position = [x, 0, 0];
    world = node.world;
    return node.addBehavior(AudioReverbZone, { preset });
  };
  return { loop, backend, step, zone, pose, warnings, restore: () => (console.warn = warn) };
}

/** Walks A (x 0) → B (30) → C (60), recording each distinct core slot table (`ZoneState` per slot) and the wet peaks. */
async function walk(r: Awaited<ReturnType<typeof rig>>, framesPerRoom: number) {
  r.zone("A", 0, "room");
  r.zone("B", 30, "corridor");
  r.zone("C", 60, "cave");
  const voice = r.backend.play({ path: "tone", url: "tone", loop: true, stream: false, bus: "SFX", attenuation: { minDistance: 1, maxDistance: 50, rolloff: "inverse" }, position: { x: 0, y: 0, z: 0 } })!;
  expect(voice).not.toBeNull();
  const m = r.backend.mirror;
  const tables: string[] = [];
  let wetHeard = 0;
  for (const x of [0, 30, 60]) {
    voice.setPosition({ x, y: 0, z: 0 });
    r.pose.position.x = x;
    for (let f = 0; f < framesPerRoom; f++) {
      await r.step();
      const t = [...m.zoneState.subarray(0, m.zoneCount)].join("");
      if (tables.at(-1) !== t) tables.push(t);
      for (let k = 0; k < m.zoneCount; k++) if (m.zoneState[k] === ZoneState.Active && m.zoneWetPeak[k]! > 0) wetHeard++;
    }
  }
  return { tables, wetHeard, debug: r.backend.zones.debug()! };
}

describe("zone walk A → B → C on the real wasm (C5 acceptance)", () => {
  it("high and default: the standby slot takes the incoming zone while the outgoing one rings out", async () => {
    const r = await rig(3, 2, 1);
    try {
      const { tables, wetHeard, debug } = await walk(r, 120);
      // A ringing out (4) beside B active (3); then B ringing out beside C.
      expect(tables.some((t) => t.includes("4") && t.includes("3"))).toBe(true);
      expect(tables.join(",")).not.toContain("5"); // never evicted
      expect(wetHeard).toBeGreaterThan(0);
      expect(debug.find((z) => z.node === "C")!.state).toBe("active");
      expect(debug.find((z) => z.node === "A")!.slot).toBe(-1);
      expect(r.backend.zones.counters.irPrepares).toBe(3);
      expect(r.backend.mirror.zonesRinging + r.backend.mirror.zonesActive).toBeGreaterThan(0);
    } finally {
      r.restore();
    }
  }, 60_000);

  it("low: the outgoing zone is evicted with the fade before the incoming zone's kernel takes the only slot", async () => {
    const r = await rig(1, 1, 0);
    try {
      const { tables, wetHeard, debug } = await walk(r, 120);
      const seq = tables.join(",");
      // active → evicting → off → (waiting / fading in) → active, twice.
      expect(seq).toMatch(/3,5,0,(1,)?(2,)?3,5,0,(1,)?(2,)?3/);
      expect(wetHeard).toBeGreaterThan(0);
      expect(debug.find((z) => z.node === "C")!.state).toBe("active");
      expect(r.backend.zones.counters.irPrepares).toBe(3);
    } finally {
      r.restore();
    }
  }, 60_000);

  it("a zone faded on a full house is warned about once", async () => {
    const r = await rig(1, 1, 0);
    try {
      r.zone("A", 0, "room");
      r.zone("B", 30, "hall");
      const req = (x: number) => ({ path: "tone", url: "tone", loop: true, stream: false, bus: "SFX", attenuation: { minDistance: 1, maxDistance: 50, rolloff: "inverse" as const }, position: { x, y: 0, z: 0 } });
      r.backend.play(req(0));
      r.backend.play(req(30));
      r.pose.position.x = 5;
      for (let f = 0; f < 120; f++) await r.step();
      const faded = r.warnings.filter((w) => /Reverb zone "(A|B)" faded/.test(w));
      expect(faded).toHaveLength(1);
      expect(r.backend.zones.debug()!.filter((z) => z.why.startsWith("faded"))).toHaveLength(1);
    } finally {
      r.restore();
    }
  }, 60_000);
});
