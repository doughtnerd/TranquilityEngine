// ADR 0162 C5 acceptance (api-and-models §10 C5): a voice, with the listener, walks from zone A to B to C on the
// loopback host: the real mixer wasm with zone slots laid out, the real decoder wasm generating the preset kernels
// (`generateIr`) and sending them to the worklet as format 3 clips, C2b's `ZoneIrService`, and the core backend's
// zone manager. Both slot paths (OD2): high and default with a standby slot (the outgoing zone rings out beside the
// incoming one), low with one slot (the outgoing zone is evicted with the 150 ms fade, and the incoming zone waits for
// the slot and its kernel). The sends reach the slots only in a wasm with C4 (core sends): run it on a build that has it.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { defaultAudioSettings } from "../../../../engine/audio/settings";
import { Assets, Engine, GameObject, SceneManager } from "../../../../myco";
import { AudioReverbZone } from "../AudioReverbZone";
import { createDecoderHandler } from "../decoder/handler";
import type { DecoderReply, IrFailedMessage, IrPreparedMessage, StreamPortLike } from "../decoder/protocol";
import hash from "../wasm/hash.json";
import { type LoopbackAudio, type LoopbackStreamPort, loopbackAudio, closeLoopbackAudio } from "../testing";
import { ZoneState } from "../wire.generated";
import { stepAudioFrame } from "../audioFrame";
import { ListenerFrame } from "./spatial";
import { createZoneIrService } from "./zoneIr";

const DECODER = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));

async function rig(slots: number, maxActive: number, standby: number) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] } }));
  await Engine.create({ headless: true });
  await SceneManager.load("s.json");
  // The decoder worker in-process (the zones' kernels) on a channel this test owns: its worklet end goes to the shell as the
  // backend hands it over (`CoreLink.connectStreamPort`, ADR 0223), and messages cross it at once, both ways.
  let audio: LoopbackAudio | null = null;
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
  const worklet: LoopbackStreamPort = { onmessage: null, postMessage: (m: unknown) => port.onmessage?.({ data: m }) };
  const port: StreamPortLike = {
    onmessage: null,
    postMessage: (m: unknown) => {
      if (!worklet.onmessage) throw new Error("the loopback didn't take the stream port");
      worklet.onmessage({ data: m });
    },
  };
  await handler.handle({ type: "connectWorklet", port } as never);
  const pending: Promise<void>[] = [];
  const zoneIr = createZoneIrService({
    sampleRate: 48_000,
    decoder: {
      postIr: (req) => void pending.push(handler.handle(req)),
      onIr: (l) => (listeners.push(l), () => {}),
    },
  });
  const tone = new Float32Array(48_000).map((_, i) => 0.2 * Math.sin((2 * Math.PI * 440 * i) / 48_000));
  const settings = defaultAudioSettings();
  settings.zones = { maxActive, standby, maxIrSeconds: 1 };
  const warnings: string[] = [];
  const warn = console.warn;
  console.warn = (m: string) => void warnings.push(String(m));
  // ADR 0221: the production assembly on the loopback, with its own mixer. ADR 0434: each step runs the main-thread frame
  // (`stepAudioFrame`) with a listener frame of this test's own, which holds the zones' World.
  audio = await loopbackAudio({ mixer: "own", settings, preset: { maxZoneSlots: slots, zoneMaxSeconds: 1 }, decode: () => ({ channelData: [tone] }), backend: { zoneIr } });
  if (!audio) throw new Error("the loopback core did not load");
  audio.link.connectStreamPort(worklet as unknown as MessagePort);
  const loop = audio;
  const { backend, mixer } = audio;
  const frame = new ListenerFrame();
  const parts = { mixer, playlists: null, backend, frame };
  let world: import("../../../../engine/core/World").World | null = null;
  const pose = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };
  const step = async () => {
    frame.set(world, 0, null, pose, 0.016);
    stepAudioFrame(parts, 0.016);
    loop.render(6);
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
  const tables: string[] = [];
  let wetHeard = 0;
  for (const x of [0, 30, 60]) {
    voice.setPosition({ x, y: 0, z: 0 });
    r.pose.position.x = x;
    for (let f = 0; f < framesPerRoom; f++) {
      await r.step();
      const zones = r.loop.link.lastStatus?.zones ?? [];
      const t = zones.map((z) => z.state).join("");
      if (tables.at(-1) !== t) tables.push(t);
      for (const z of zones) if (z.state === ZoneState.Active && z.wetPeak > 0) wetHeard++;
    }
  }
  return { tables, wetHeard, debug: r.backend.zones.debug()! };
}

afterEach(closeLoopbackAudio);

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
      expect(r.loop.link.lastStatus!.zonesRinging + r.loop.link.lastStatus!.zonesActive).toBeGreaterThan(0);
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
