// ADR 0162 E4 acceptance (api-and-models §10 E4): the §7 debug-panel rows against the loopback host. `Audio.debug()`
// is built by the real core backend (ADR 0221: the production assembly, `loopbackAudio`) over the real mixer wasm (two bed-capable buses, zone slots, wide rings), a zone
// preset kernel from the real decoder, and the real occlusion pass with a wall at x = 5 between the listener and one
// of the voices. Every sample goes to the panel's monitor (ADR 0220), and every §7 row of its view must appear with a sane
// value; then the overlay is built from the same data.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { defaultAudioSettings } from "../../../engine/audio/settings";
import { Assets, BoxCollider, Engine, GameObject, SceneManager } from "../../../myco";
import { AudioOccluder } from "../runtime/AudioOccluder";
import { AudioReverbZone } from "../runtime/AudioReverbZone";
import { ListenerFrame } from "../runtime/core/spatial";
import { createZoneIrService } from "../runtime/core/zoneIr";
import { createDecoderHandler } from "../runtime/decoder/handler";
import type { DecoderReply, IrFailedMessage, IrPreparedMessage, StreamPortLike } from "../runtime/decoder/protocol";
import hash from "../runtime/wasm/hash.json";
import { type LoopbackAudio, loopbackAudio, closeLoopbackAudio } from "../runtime/testing";
import { AudioDebugMonitor, type Section } from "./audioDebugMonitor";
import { gainColor, occlusionColors, occlusionOverlay, occludedVoices, type OcclusionScene } from "./occlusionRays";
import { theme } from "../../../editor/sdk";

const DECODER = readFileSync(fileURLToPath(new URL("../runtime/wasm/myco_audio_decode.wasm", import.meta.url)));

async function rig(slots: number, maxActive: number, standby: number) {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", settings: { physics: "3d" }, nodes: [] } }));
  const engine = await Engine.create({ headless: true, project: { physics: { gravity: [0, -10], layers: ["Default"], collisionMatrix: { Default: ["Default"] } } } });
  await SceneManager.load("s.json");
  // The decoder worker in-process: its worklet port delivers into the shell as the real port would (`workletPort`).
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
  const port: StreamPortLike = { onmessage: null, postMessage: (m: unknown) => audio!.workletPort.postMessage(m) };
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
  // ADR 0221: the production assembly on the loopback, on the page's mixer with the backend registered, so the panel's
  // monitor reads `Audio.debug()` as it does in the editor. The test runs the frame's passes itself (a fixed listener pose).
  audio = await loopbackAudio({
    settings,
    preset: { maxZoneSlots: slots, zoneMaxSeconds: 1, maxBeds: 1, maxWide: 1 },
    decode: () => ({ channelData: [tone] }),
    backend: { zoneIr },
  });
  if (!audio) throw new Error("the loopback core did not load");
  const loop = audio;
  const { backend, mixer } = audio;
  const frame = new ListenerFrame();
  let world: import("../../../engine/core/World").World | null = null;
  const pose = { position: { x: 0, y: 0, z: 0 }, forward: { x: 0, y: 0, z: 1 }, up: { x: 0, y: 1, z: 0 } };
  const step = async () => {
    mixer.update(0.016);
    backend.frameAttenuate(0.016);
    backend.collectSpatialVoices();
    frame.set(world, 0, null, pose, 0.016);
    backend.zones.run(frame, backend.spatialVoices, mixer.audioSettings);
    backend.occlusion.run(frame, backend.spatialVoices, mixer.audioSettings);
    backend.frameSelect();
    backend.framePickPanners();
    backend.frameStageFx();
    backend.frameStageListener(frame);
    backend.frameCommit();
    loop.render(6);
    await Promise.all(pending.splice(0));
    await new Promise((r) => setTimeout(r, 0));
  };
  // A real box collider wall in the 3D physics World, found by the occlusion pass's own ray query.
  const wall = GameObject.create("Wall");
  wall.transform!.position.x = 5;
  wall.addBehavior(BoxCollider).size.set(0.5, 4, 4);
  wall.addBehavior(AudioOccluder, { material: "concrete" });
  engine.step(1 / 60);
  const zone = (name: string, x: number, preset: string) => {
    const node = GameObject.create(name);
    node.transform!.position = [x, 0, 0];
    world = node.world;
    return node.addBehavior(AudioReverbZone, { preset });
  };
  return { Audio: audio.Audio, backend, step, zone, pose, warnings, restore: () => (console.warn = warn) };
}

afterEach(async () => {
  await closeLoopbackAudio();
  vi.restoreAllMocks();
});

const req = (x: number) => ({ path: "tone", url: "tone", loop: true, stream: false, bus: "SFX", attenuation: { minDistance: 1, maxDistance: 50, rolloff: "inverse" as const }, position: { x, y: 0, z: 0 } });
const section = (s: Section[], id: Section["id"]) => s.find((x) => x.id === id)!;
const value = (s: Section, row: string) => s.rows.find((r) => r.id === row)!.cells[1]!;

describe("E4: the §7 debug rows against the loopback host", () => {
  it("every row appears with a sane value", async () => {
    const r = await rig(1, 1, 0);
    try {
      r.zone("A", 0, "room");
      r.zone("B", 30, "hall");
      r.backend.play(req(0));
      r.backend.play(req(30));
      const behindWall = r.backend.play(req(10))!;
      expect(behindWall).not.toBeNull();
      const monitor = new AudioDebugMonitor();
      let info = r.Audio.debug();
      for (let f = 0; f < 120; f++) {
        await r.step();
        info = r.Audio.debug();
        monitor.observe(info);
      }
      const view = monitor.view()!;
      const sections = view.sections;
      expect(sections.map((s) => s.id)).toEqual(["m3Counters", "ladder", "beds", "zones", "occlusion", "memory", "musicTotals", "music", "mixCaps", "cpu", "mix", "mixSlots", "ducking", "recorder"]);
      for (const s of sections) expect(s.tip.length, s.id).toBeGreaterThan(20);

      // Counters: the numbers the loopback run produced, each with a health.
      const counters = section(sections, "m3Counters");
      for (const id of ["zonesActive", "zonesFaded", "zoneMemoryKB", "kernelRefused", "irFailures", "occlusionRays", "occlusionUsedMs", "oldestOcclusionAgeFrames", "occlusionOverruns", "dopplerClamps", "wideStarved"]) {
        expect(counters.rows.find((x) => x.id === id), id).toBeDefined();
      }
      expect(Number(value(counters, "occlusionRays").text.replace(/,/g, ""))).toBeGreaterThan(0);
      expect(value(counters, "irFailures").health).toBe("ok");
      expect(value(counters, "kernelRefused").health).toBe("ok");
      expect(value(counters, "zonesFaded").health).toBe(info.counters.zonesFaded ? "warn" : "ok");
      expect(["ok", "warn", "bad"]).toContain(value(counters, "oldestOcclusionAgeFrames").health);

      // Ladder: idle on a quiet core, no shed steps.
      const ladder = section(sections, "ladder");
      expect(value(ladder, "ladderState").text).toBe(String(info.core.ladderState));
      expect(value(ladder, "m3Shed")).toMatchObject({ text: "0", health: "ok" });

      // Beds: the loopback has one bed slot; the row names its bus and voice count.
      const beds = section(sections, "beds");
      expect(info.beds).toBeDefined();
      expect(beds.columns!.map((c) => c.label)).toEqual(["Slot", "Bus", "Sharing", "Denied", "Voices", "Clips", "Cost"]);
      expect(beds.rows).toHaveLength(info.beds!.length);
      for (const row of beds.rows) {
        expect(row.cells).toHaveLength(beds.columns!.length);
        expect(row.cells[1]!.text).not.toBe("");
      }

      // Zones: both zones are listed; on a full house one is faded and says why; the active one has a slot and a kernel.
      const zones = section(sections, "zones");
      expect(zones.rows).toHaveLength(2);
      const whys = zones.rows.map((x) => x.cells[9]!.text);
      expect(whys.filter((w) => w.startsWith("faded"))).toHaveLength(1);
      const active = zones.rows.find((x) => x.cells[2]!.text === "active")!;
      expect(active.cells[1]!.text).toBe("0");
      expect(active.cells[4]!.text).toMatch(/s$/);
      expect(zones.rows.find((x) => x.cells[9]!.text.startsWith("faded"))!.health).toBe("warn");

      // Occlusion: enabled, a ray count within the budget, an age.
      const occ = section(sections, "occlusion");
      expect(value(occ, "enabled")).toMatchObject({ text: "on", health: "ok" });
      expect(info.occlusion!.rays).toBeLessThanOrEqual(info.occlusion!.budgetRays);
      expect(value(occ, "oldestAge").text).toMatch(/frames$/);

      // Memory: the preset's regions.
      const memory = section(sections, "memory");
      expect(memory.rows.map((x) => x.id)).toEqual(["beds", "zones", "kernels", "wideRings"]);
      for (const row of memory.rows) expect(row.cells[1]!.text, row.id).toMatch(/KB|MB/);

      // Voice columns: the row of the voice behind the wall carries its occlusion gain, cutoff and low-pass owner.
      const table = view.voices;
      const voiceRows = [...table.groups.flatMap((g) => g.voices), ...table.ungrouped];
      const cellsOf = (id: number) => {
        const row = voiceRows.find((x) => x.id === String(id))!;
        expect(row.cells).toHaveLength(table.columns.length);
        return Object.fromEntries(table.columns.map((c, i) => [c.label, row.cells[i]!]));
      };
      const mine = info.voices.find((v) => v.id === behindWall.id)!;
      const cells = cellsOf(mine.id);
      expect(mine.occlusion!.gain).toBeLessThan(1);
      expect(cells.Occlusion!.text).toMatch(/^\d\.\d\d · /);
      expect(cells.Occlusion!.tip).toMatch(/concrete/);
      expect(cells["Low-pass"]!.text).toMatch(/\(occlusion\)$/);
      expect(["flat", "equalPower", "hrtf", "bed", "ambisonic"]).toContain(cells.Panner!.text);
      // A voice in the open reads "open".
      const open = info.voices.find((v) => v.occlusion && v.occlusion.gain >= 0.9995)!;
      expect(cellsOf(open.id).Occlusion!.text).toBe("open");
      // The zone sends of the voice at the listener name the zone.
      expect(info.voices.some((v) => v.sends?.some((s) => s.zone === "A") && cellsOf(v.id).Sends!.text.includes("A "))).toBe(true);

      // The overlay, from the same debug data: one ray (to the listener) and a hit cross at the wall for the occluded voice.
      // (The rig's World has no audio key, so its voices read world null; the overlay matches voices by the World's key.)
      const voices = info.voices.map((v) => ({ ...v, world: "1" }));
      const scene: OcclusionScene = {
        worldKey: 1,
        sourceOf: (id) => (id === behindWall.id ? [10, 0, 0] : null),
        listener: [0, 0, 0],
        hitOf: (_id, from, to) => [5, from[1] + (to[1] - from[1]) / 2, 0],
      };
      expect(occludedVoices(voices, 1).map((v) => v.id)).toContain(behindWall.id);
      const overlay = occlusionOverlay(voices, scene, occlusionColors(theme.peek()));
      expect(overlay.lines).toHaveLength(4); // the ray and the three arms of the cross
      expect(overlay.lines[0]!.points).toEqual([[10, 0, 0], [0, 0, 0]]);
      expect(overlay.lines[0]!.color).toBe(gainColor(mine.occlusion!.gain, occlusionColors(theme.peek())));
    } finally {
      r.restore();
    }
  }, 60_000);
});
