// ADR 0158 E3.5: event goldens. Each scene plays an audio event through the real event runtime and the real
// `CoreBackend` over the loopback host (the committed wasm in Node, no AudioContext), renders a fixed number of frames,
// and compares the output with `runtime/golden/event-<scene>.json` the way `audioGolden.test.ts` does: the exact
// SHA-256 of the f32 output (left then right), plus RMS and peak per 1,024-frame block so a failure says how far
// the levels moved. Inputs are integer-built sawtooth clips (no libm in the clips), the seed is fixed, and every frame
// waits for a macrotask, so clip loading (decode, upload) finishes at the same frame on every run.
//
// Update path (after E3.4's Rust evaluator changes, or any intended change to the core's output or the runtime):
//   UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/events/eventGolden.test.ts
// then review the diff of `golden/event-*.json`: an unexpected change means the output moved.
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Assets, Engine, SceneManager } from "../../../../myco";
import { mixer } from "../../../../engine/audio/mixer";
import { setAudioBackend } from "../backend";
import { Audio } from "../index";
import { _resetHandleWarningsForTests } from "../core/handle";
import { createClipRegistry } from "../core/clipRegistry";
import { fakeDecoder, type PlanarClip } from "../core/fakeDecoder";
import type { AudioHost } from "../core/context";
import { CoreBackend, type CoreBackendHost } from "../core/coreBackend";
import { createLoopbackHost } from "../testing";
import { events } from "./eventRuntime";
import type { AudioEventHandle } from "../backend";

const F = "myco.audioevent@1";
const RATE = 48_000;
const GOLDEN_DIR = fileURLToPath(new URL("../golden/", import.meta.url));
const UPDATE = process.env.UPDATE_GOLDENS === "1";
const BLOCK = 1024;
/** One frame of the script: 4 quanta (512 samples, 10.7 ms). */
const FRAME_QUANTA = 4;

/** Clips by name: a sawtooth of `period` samples, `frames` long. Integer-built, so every platform makes the same floats. */
const CLIPS: Record<string, { frames: number; period: number; amp: number }> = {
  "a.wav": { frames: 24_000, period: 96, amp: 0.5 },
  "b.wav": { frames: 24_000, period: 64, amp: 0.4 },
  "c.wav": { frames: 4_800, period: 40, amp: 0.5 },
  "d.wav": { frames: 4_800, period: 56, amp: 0.5 },
  "e.wav": { frames: 4_800, period: 72, amp: 0.5 },
};
const NAMES = Object.keys(CLIPS);
const saw = ({ frames, period, amp }: { frames: number; period: number; amp: number }): Float32Array => Float32Array.from({ length: frames }, (_, k) => ((k % period) / period - 0.5) * amp);
const clipData = new Map(NAMES.map((n) => [n, saw(CLIPS[n]!)]));
/** The fake fetch answers a clip's name as a byte length (its index + 1), which the fake decode maps back. */
const decode = fakeDecoder(async (bytes): Promise<PlanarClip> => {
  const name = NAMES[bytes.byteLength - 1]!;
  const data = clipData.get(name)!;
  return { frames: data.length, channels: 1, sampleRate: RATE, channelData: [data] };
});
const fetchBytes = async (path: string) => new ArrayBuffer(NAMES.indexOf(path) + 1);

interface Rig {
  readonly backend: CoreBackend;
  /** Runs `n` frames (event tick, core update, 4 quanta, one macrotask); `each(frame)` runs first in every frame. */
  frames(n: number, each?: (frame: number) => void): Promise<void>;
  output(): { left: Float32Array; right: Float32Array };
}

async function rig(): Promise<Rig | null> {
  let loop;
  try {
    loop = await createLoopbackHost({ preset: { maxLogical: 64, maxMixed: 32, maxBuses: 8, arenaInitialBytes: 1 << 20, clipCeilingBytes: 16 << 20, limiterLookaheadMs: 0, maxBeds: 0, maxZoneSlots: 0, zoneMaxSeconds: 0, maxWide: 0, maxMusicRings: 0 } });
  } catch {
    return null;
  }
  const link = loop.link;
  const clips = createClipRegistry({ send: (m) => link.post(m), nextSeq: () => link.nextSeq(), fetchBytes, decodeWorker: decode, nextFrame: (cb) => cb(), nextQuantum: (cb) => cb() });
  const host: CoreBackendHost = { link, status: "running", preset: { maxLogical: 64, maxMixed: 32 }, worldCount: 1, sampleRate: RATE, addLifecycleListener: (() => () => {}) as AudioHost["addLifecycleListener"] };
  const backend = new CoreBackend(host, { clips, clock: loop.clock, mixer });
  const left: number[] = [];
  const right: number[] = [];
  let frame = 0;
  return {
    backend,
    async frames(n, each) {
      for (let f = 0; f < n; f++, frame++) {
        each?.(frame);
        events().update(0.0107);
        backend.update(0.0107);
        const out = loop.renderQuanta(FRAME_QUANTA);
        for (const s of out.left) left.push(s);
        for (const s of out.right) right.push(s);
        await new Promise<void>((r) => setTimeout(r, 0));
      }
    },
    output: () => ({ left: Float32Array.from(left), right: Float32Array.from(right) }),
  };
}

async function boot(assets: Record<string, unknown>): Promise<void> {
  Assets.clearSources();
  Assets.addSource(Assets.fromObject({ "s.json": { format: "myco.scene@1", nodes: [] }, ...Object.fromEntries(NAMES.map((n) => [n, "data:,"])), ...assets }));
  const engine = await Engine.create({ headless: true, project: { audio: { buses: [{ name: "Master" }, { name: "SFX", parent: "Master" }], seed: 7, backend: "core" } } });
  await SceneManager.load("s.json");
  engine.world.render = {} as never;
}

const clip = (c: string, extra: Record<string, unknown> = {}) => ({ type: "clip", clip: c, ...extra });

interface Scene {
  assets: Record<string, unknown>;
  run(r: Rig): Promise<void>;
}

const SCENES: Record<string, Scene> = {
  // Two clips at once under one instance: different volumes and a pitch, stopped with a fade.
  "event-layered": {
    assets: { "e.audioevent.json": { format: F, bus: "SFX", volume: 0.8, root: { type: "layer", children: [clip("a.wav", { volume: 0.6, loop: true }), clip("b.wav", { volume: 0.5, pitch: 1.5, loop: true })] } } },
    async run(r) {
      let h!: AudioEventHandle;
      await r.frames(100, (f) => {
        if (f === 0) h = Audio.play("e.audioevent.json");
        if (f === 70) h.stop(0.1);
      });
    },
  },
  // A blend of two loops on a parameter: the core crosses them as Speed moves 0 -> 5 -> 10 with a seek speed.
  "event-blend": {
    assets: { "e.audioevent.json": { format: F, bus: "SFX", parameters: [{ name: "Speed", min: 0, max: 10, default: 0, seekSpeed: 40 }],
      root: { type: "blend", parameter: "Speed", children: [clip("a.wav", { range: [0, 4], fade: 2, loop: true }), clip("b.wav", { range: [6, 10], fade: 2, loop: true })] } } },
    async run(r) {
      let h!: AudioEventHandle;
      await r.frames(120, (f) => {
        if (f === 0) h = Audio.play("e.audioevent.json");
        if (f === 40) h.setParameter("Speed", 5);
        if (f === 80) h.setParameter("Speed", 10);
      });
    },
  },
  // A continuous random container of short clips (seed 7). Silent plays first load the clips, so their lengths are known
  // and each next clip is scheduled with `at` (gapless); the late-start path is covered on the fake backend.
  "event-continuous": {
    assets: {
      "e.audioevent.json": { format: F, bus: "SFX", root: { type: "random", mode: "continuous", avoidRepeat: 1, children: [clip("c.wav"), clip("d.wav"), clip("e.wav")] } },
      // Silent loops keep the clips resident (a clip is released when its last voice ends), so their lengths stay known.
      ...Object.fromEntries(["c", "d", "e"].map((c) => [`hold-${c}.audioevent.json`, { format: F, root: clip(`${c}.wav`, { loop: true }) }])),
    },
    async run(r) {
      let h!: AudioEventHandle;
      await r.frames(100, (f) => {
        if (f === 0) for (const c of ["c", "d", "e"]) Audio.play(`hold-${c}.audioevent.json`, { volume: 0 });
        if (f === 20) h = Audio.play("e.audioevent.json");
        if (f === 90) h.stop(0.05);
      });
      expect(events().lateStartTotal).toBe(0);
    },
  },
  // A sustained clip loops a region, then release lets it play on to its tail (SET_LOOP on the frame).
  "event-sustain-release": {
    assets: { "e.audioevent.json": { format: F, bus: "SFX", root: clip("a.wav", { sustain: true, loopRegion: [0.1, 0.2] }) } },
    async run(r) {
      let h!: AudioEventHandle;
      await r.frames(100, (f) => {
        if (f === 0) h = Audio.play("e.audioevent.json");
        if (f === 50) h.release();
      });
    },
  },
};

// --- Digests (the same rule as audioGolden.test.ts) ----------------------------------------------------------------

interface Golden {
  scene: string;
  frames: number;
  sha256: string;
  peak: number;
  rms: number;
  /** Per block of 1,024 frames: [rmsL, peakL, rmsR, peakR]. */
  blocks: number[][];
}

const sig = (v: number): number => Number(v.toPrecision(6));

function digest(scene: string, left: Float32Array, right: Float32Array): Golden {
  const hash = createHash("sha256");
  hash.update(new Uint8Array(left.buffer, left.byteOffset, left.byteLength));
  hash.update(new Uint8Array(right.buffer, right.byteOffset, right.byteLength));
  const stat = (x: Float32Array, from: number, to: number): [number, number] => {
    let sum = 0;
    let peak = 0;
    for (let i = from; i < to; i++) {
      sum += x[i]! * x[i]!;
      peak = Math.max(peak, Math.abs(x[i]!));
    }
    return [Math.sqrt(sum / (to - from)), peak];
  };
  const blocks: number[][] = [];
  for (let from = 0; from < left.length; from += BLOCK) {
    const to = Math.min(left.length, from + BLOCK);
    const [rl, pl] = stat(left, from, to);
    const [rr, pr] = stat(right, from, to);
    blocks.push([sig(rl), sig(pl), sig(rr), sig(pr)]);
  }
  const [rmsL, peakL] = stat(left, 0, left.length);
  const [rmsR, peakR] = stat(right, 0, right.length);
  return { scene, frames: left.length, sha256: hash.digest("hex"), peak: sig(Math.max(peakL, peakR)), rms: sig(Math.sqrt((rmsL * rmsL + rmsR * rmsR) / 2)), blocks };
}

const dB = (v: number): number => 20 * Math.log10(Math.max(v, 1e-12));

function explain(want: Golden, got: Golden): string {
  const lines = [`scene "${got.scene}": output differs from golden/${got.scene}.json`, `  sha256 ${want.sha256.slice(0, 16)}... -> ${got.sha256.slice(0, 16)}...`];
  if (want.frames !== got.frames) lines.push(`  frames ${want.frames} -> ${got.frames}`);
  lines.push(`  overall peak ${dB(want.peak).toFixed(2)} -> ${dB(got.peak).toFixed(2)} dBFS, rms ${dB(want.rms).toFixed(2)} -> ${dB(got.rms).toFixed(2)} dBFS`);
  let first = -1;
  let moved = 0;
  let worst = 0;
  for (let b = 0; b < Math.max(want.blocks.length, got.blocks.length); b++) {
    const w = want.blocks[b];
    const g = got.blocks[b];
    const differs = !w || !g || w.some((v, k) => Math.abs(v - g[k]!) > 1e-6);
    if (!differs) continue;
    moved++;
    if (first < 0) first = b;
    if (w && g) for (let k = 0; k < 4; k++) worst = Math.max(worst, Math.abs(dB(g[k]!) - dB(w[k]!)));
  }
  lines.push(moved === 0 ? "  every block's level is within 1e-6: the bits changed, the levels did not" : `  ${moved} blocks moved; the first is block ${first} (frame ${first * BLOCK}); largest level change ${worst.toFixed(2)} dB`);
  lines.push("  If intended, rerun with UPDATE_GOLDENS=1 and review the diff of golden/event-*.json.");
  return lines.join("\n");
}

async function capture(name: string): Promise<Golden | null> {
  const scene = SCENES[name]!;
  vi.spyOn(console, "warn").mockImplementation(() => {});
  _resetHandleWarningsForTests();
  events()._reset();
  await boot(scene.assets);
  const r = await rig();
  if (!r) return null;
  setAudioBackend(r.backend);
  await scene.run(r);
  const { left, right } = r.output();
  for (const s of left) expect(Number.isFinite(s)).toBe(true);
  r.backend.dispose();
  return digest(name, left, right);
}

afterEach(() => {
  events()._reset();
  setAudioBackend(null);
  vi.restoreAllMocks();
});

describe("event goldens (the real core on the loopback host)", () => {
  it.each(Object.keys(SCENES))("%s matches its golden digest", { timeout: 60_000 }, async (name, ctx) => {
    void ctx;
    const got = await capture(name);
    if (!got) return;
    const path = `${GOLDEN_DIR}${name}.json`;
    if (UPDATE) {
      mkdirSync(GOLDEN_DIR, { recursive: true });
      writeFileSync(path, `${JSON.stringify(got)}\n`);
      return;
    }
    if (!existsSync(path)) throw new Error(`no golden for scene "${name}": run UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/events/eventGolden.test.ts`);
    const want = JSON.parse(readFileSync(path, "utf8")) as Golden;
    if (want.sha256 !== got.sha256) throw new Error(explain(want, got));
  });

  it("every event scene is audible", () => {
    for (const name of Object.keys(SCENES)) {
      const path = `${GOLDEN_DIR}${name}.json`;
      if (!existsSync(path)) continue;
      expect((JSON.parse(readFileSync(path, "utf8")) as Golden).peak, name).toBeGreaterThan(0.01);
    }
  });

  it("golden/ holds exactly the event scenes' files", () => {
    if (UPDATE) return;
    const files = existsSync(GOLDEN_DIR) ? readdirSync(GOLDEN_DIR).filter((f) => f.startsWith("event-") && f.endsWith(".json")).sort() : [];
    expect(files).toEqual(Object.keys(SCENES).map((n) => `${n}.json`).sort());
  });

  it("a render is repeatable within one process", { timeout: 60_000 }, async () => {
    const a = await capture("event-continuous");
    events()._reset();
    setAudioBackend(null);
    const b = await capture("event-continuous");
    expect(a && b && a.sha256).toBe(b && b.sha256);
  });
});
