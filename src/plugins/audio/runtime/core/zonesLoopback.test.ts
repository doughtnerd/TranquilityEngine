// ADR 0162 C7 (api-and-models §9 "Golden" zone rows, §10 C7): the zone goldens C3 left native because the sends weren't in
// yet. Blend, ring-out and rebuild through the real mixer wasm on the loopback host with real sends (SET_VOICE_FX), the
// kernels from the real decoder wasm's built-in presets (`generateIr`, sent to the worklet as format 3 clips), and the
// ZONE_CONFIG table written the way the zone manager writes it. Each flow asserts its behaviour and compares its output
// with `golden/zones/zones-<flow>.json` (the exact SHA-256 of the f32 output and per-block levels, the format of
// `audioGolden.test.ts`; `golden/replay.ts` owns the digest and each suite its own folder).
//
// Update path: UPDATE_GOLDENS=1 npx vitest run src/plugins/audio/runtime/core/zonesLoopback.test.ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createDecoderHandler } from "../decoder/handler";
import type { DecoderReply, IrFailedMessage, IrPreparedMessage, StreamPortLike } from "../decoder/protocol";
import { createLoopbackHost, LOOPBACK_PRESET, LOOPBACK_RATE, type LoopbackHost, type LoopbackStreamPort } from "../testing";
import { levelDigest, matchLevelGolden } from "../golden/replay";
import hash from "../wasm/hash.json";
import {
  ASAP,
  ClipEvent,
  Kind,
  PLAY_FLAGS_LOOP,
  PLAY_FLAGS_MIXED,
  PLAY_FLAGS_SPATIAL,
  readClipBegin,
  SET_VOICE_FX_MASK_SENDS,
  writeBatchHeader,
  writeClipBegin,
  writeClipChunk,
  writeEnvelope,
  writePlay,
  writeReset,
  writeSetVoiceFx,
  writeStop,
  writeZoneConfig,
  ZONE_KERNEL_ID_FIRST,
  ZoneSlotState,
  ZoneState,
  type ZoneConfigSlots,
} from "../wire.generated";

const DECODER = readFileSync(fileURLToPath(new URL("../wasm/myco_audio_decode.wasm", import.meta.url)));
const Q = 128;

/** Zone slots: the high and default presets' `maxActive + standby`; IRs up to 1 s (the presets' 0.4-0.9 s fit). */
const PRESET = { ...LOOPBACK_PRESET, maxZoneSlots: 3, zoneMaxSeconds: 1 };
const K1 = ZONE_KERNEL_ID_FIRST;
const K2 = ZONE_KERNEL_ID_FIRST + 1;
const CLIP = 1;
const CLIP_FRAMES = 12_000;

type Writer = (view: DataView, off: number) => number;
const voice = (n: number): number => 0x0001_0000 | n;

/** Two sines and a little integer-built noise, quiet enough that the master limiter never acts (so the sums are linear). */
function clip(): Float32Array {
  const out = new Float32Array(CLIP_FRAMES);
  let state = 0x1234_5678;
  for (let i = 0; i < CLIP_FRAMES; i++) {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    const noise = (state >>> 8) / 0x100_0000 - 0.5;
    out[i] = 0.2 * Math.sin((2 * Math.PI * 220 * i) / LOOPBACK_RATE) + 0.15 * Math.sin((2 * Math.PI * 1760 * i) / LOOPBACK_RATE) + 0.1 * noise;
  }
  return out;
}

/** The loopback host with zone slots, the clip from main, and the decoder worker's IR path on its stream port to the worklet. */
class Rig {
  private seq = 1;
  private token = 1;
  private readonly lefts: Float32Array[] = [];
  private readonly rights: Float32Array[] = [];
  private readonly replies: (IrPreparedMessage | IrFailedMessage)[] = [];
  /** Clips begun on the worklet (the clip and the kernels). */
  private readonly begun = new Set<number>();
  private handler!: ReturnType<typeof createDecoderHandler>;
  host!: LoopbackHost;

  static async create(): Promise<Rig> {
    const r = new Rig();
    r.host = await createLoopbackHost({ preset: PRESET });
    r.handler = createDecoderHandler({
      post: (m: DecoderReply) => {
        if (m.type === "irPrepared" || m.type === "irFailed") r.replies.push(m);
      },
      expectedSourceHash: hash.sourceHash,
      fetchBytes: async () => {
        throw new Error("no assets here");
      },
    });
    await r.handler.handle({ type: "init", wasmBytes: DECODER.buffer.slice(DECODER.byteOffset, DECODER.byteOffset + DECODER.byteLength) as ArrayBuffer });
    // The decoder worker's channel, owned here: its worklet end goes to the shell as the backend hands it over
    // (`CoreLink.connectStreamPort`, ADR 0223), and the kernels cross it at once, both ways. The clip comes from main.
    const worklet: LoopbackStreamPort = { onmessage: null, postMessage: (m: unknown) => port.onmessage?.({ data: m }) };
    const port: StreamPortLike = {
      onmessage: null,
      postMessage: (m: unknown) => {
        if (!worklet.onmessage) throw new Error("the loopback didn't take the stream port");
        r.noteBegun(m as ArrayBuffer);
        worklet.onmessage({ data: m });
      },
    };
    r.host.link.connectStreamPort(worklet as unknown as MessagePort);
    await r.handler.handle({ type: "connectWorklet", port } as never);
    r.loadClip();
    return r;
  }

  loadClip(): void {
    const data = clip();
    const begin = new ArrayBuffer(16 + 20);
    const view = new DataView(begin);
    writeEnvelope(view, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++, bodyBytes: 20 });
    writeClipBegin(view, 0, { clipId: CLIP, frames: CLIP_FRAMES, channels: 1, sampleRate: LOOPBACK_RATE, format: 0 });
    this.fromMain(begin);
    for (let frame = 0; frame < CLIP_FRAMES; frame += 2048) {
      const n = Math.min(2048, CLIP_FRAMES - frame);
      const chunk = new ArrayBuffer(16 + 16 + n * 4);
      const cv = new DataView(chunk);
      writeEnvelope(cv, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++, bodyBytes: 16 + n * 4 });
      writeClipChunk(cv, 0, { clipId: CLIP, frameOffset: frame, frames: n, reserved: 0 });
      new Uint8Array(chunk, 32).set(new Uint8Array(data.buffer, frame * 4, n * 4));
      this.fromMain(chunk);
    }
  }

  /** Notes the clip a clip message begins, if it begins one. */
  private noteBegun(buffer: ArrayBuffer): void {
    const view = new DataView(buffer);
    if (view.getUint16(6, true) === Kind.CLIP_BEGIN) this.begun.add(readClipBegin(view, 0).clipId);
  }

  /** A clip message from main, as the clip registry sends it (over the link). */
  private fromMain(buffer: ArrayBuffer): void {
    this.noteBegun(buffer);
    this.host.send(buffer);
  }

  /**
   * Whether a STATUS has reported every clip begun resident. The worklet commits clip chunks at 256 KB a quantum
   * (`CLIP_BYTES_PER_QUANTUM`) and the core reports the last one's commit in the next STATUS, so this turns true up to
   * a STATUS interval (6 quanta) after the last chunk lands.
   */
  allResident(): boolean {
    const resident = new Set(this.host.statuses.flatMap((s) => s.clipEvents.filter((e) => e.code === ClipEvent.Resident).map((e) => e.clipId)));
    return [...this.begun].every((id) => resident.has(id));
  }

  /** `generateIr`: the decoder worker prepares `preset`'s kernel and sends it to the worklet as format 3 chunks. Returns its frames. */
  async kernel(kernelId: number, preset: string): Promise<number> {
    const token = this.token++;
    await this.handler.handle({ type: "generateIr", token, kernelId, preset, contextRate: LOOPBACK_RATE, maxFrames: LOOPBACK_RATE });
    const reply = this.replies.find((m) => m.token === token);
    if (!reply || reply.type !== "irPrepared") throw new Error(`kernel ${preset} failed: ${JSON.stringify(reply)}`);
    return reply.frames;
  }

  /** One BATCH of the records, asap at the current frame. */
  send(...records: Writer[]): void {
    const scratch = new ArrayBuffer(32 + 8192);
    const view = new DataView(scratch);
    let at = 32;
    for (const write of records) at += write(view, at);
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: this.seq++, bodyBytes: at - 16 });
    writeBatchHeader(view, 0, { firstFrame: this.host.frame, count: records.length, flags: 0 });
    this.host.send(scratch.slice(0, at));
  }

  run(quanta: number): void {
    const { left, right } = this.host.renderQuanta(quanta);
    this.lefts.push(left);
    this.rights.push(right);
  }

  output(): { left: Float32Array; right: Float32Array } {
    const join = (parts: Float32Array[]): Float32Array => {
      const out = new Float32Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    };
    return { left: join(this.lefts), right: join(this.rights) };
  }

  /** The slots' STATE as the newest STATUS block says, as a digit string ("33" = two active). */
  table(): string {
    const b = this.host.statuses.at(-1)!;
    return b.zones.map((z) => z.state).join("");
  }

  wetPeak(k: number): number {
    return this.host.statuses.at(-1)!.zones[k]?.wetPeak ?? 0;
  }
}

const play = (id: number, gain: number): Writer => (view, off) =>
  writePlay(view, off, {
    voiceId: id, frameOffset: ASAP, clip: CLIP, bus: 0, flags: PLAY_FLAGS_MIXED | PLAY_FLAGS_LOOP | PLAY_FLAGS_SPATIAL, group: 0, gate: 0, gain, pitch: 1,
    dirX: 0, dirY: 0, dirZ: -1, lpHz: 20_000, score: 0, startOffsetFrames: 0,
  });

/** The zone sends of a voice: `[slot 0, 1, 2, 3]` linear levels. */
const sends = (id: number, send: [number, number, number, number]): Writer => (view, off) =>
  writeSetVoiceFx(view, off, { voiceId: id, frameOffset: ASAP, mask: SET_VOICE_FX_MASK_SENDS, rampFrames: 0, hpHz: 0, send, yaw: 0, auxLevel: 0, auxBus: 0xffff, reserved: 0 });

const slot = (kernelId: number, state: number, wet: number, irFrames: number): ZoneConfigSlots => ({ kernelId, returnBus: 0, state, reserved: 0, wet, irFrames });
const config = (slots: ZoneConfigSlots[], shared = 1): Writer => (view, off) => writeZoneConfig(view, off, { voiceId: 0, frameOffset: ASAP, sharedReturnGain: shared, rampFrames: 0, slots });
const reset: Writer = (view, off) => writeReset(view, off, { voiceId: 0, frameOffset: ASAP, keepClips: 0 });
const stop = (id: number): Writer => (view, off) => writeStop(view, off, { voiceId: id, frameOffset: ASAP, fadeFrames: 0, reason: 0 });

// --- Goldens (`golden/zones/`, the format of audioGolden.test.ts: `golden/replay.ts`' level digest) -------------------

function checkGolden(scene: string, r: Rig): void {
  const { left, right } = r.output();
  for (const x of left) expect(Number.isFinite(x)).toBe(true);
  for (const x of right) expect(Number.isFinite(x)).toBe(true);
  const want = matchLevelGolden("zones", levelDigest(scene, left, right), "npx vitest run src/plugins/audio/runtime/core/zonesLoopback.test.ts");
  if (want) expect(want.peak).toBeGreaterThan(0.01);
}

const energy = (x: Float32Array, from = 0, to = x.length): number => {
  let s = 0;
  for (let i = from; i < to; i++) s += x[i]! * x[i]!;
  return s;
};

// --- The flows ---------------------------------------------------------------------------------------------------------

/** Two voices (1 and 2) of the clip, dry gain 0.4, voice 1 sending `a` into slot 0 and voice 2 `b` into slot 1. */
async function blend(zones: { a: boolean; b: boolean }): Promise<Rig> {
  const r = await Rig.create();
  // Both kernels go up in every run, in the same order, and the table follows 4 quanta later, while the worklet is still
  // draining the corridor's chunks (256 KB a quantum): slot 1 waits for its kernel and starts, fading in, when it lands
  // (C5). Every run of the four has the same arrival times, so the additivity below is exact. Another order, or a kernel
  // left out, moves an arrival and so the output, legitimately: see "kernel arrival" below.
  const fa = await r.kernel(K1, "room");
  const fb = await r.kernel(K2, "corridor");
  const slots: ZoneConfigSlots[] = [slot(zones.a ? K1 : 0, ZoneSlotState.Active, zones.a ? 1 : 0, zones.a ? fa : 0)];
  if (zones.b) slots.push(slot(K2, ZoneSlotState.Active, 0.5, fb));
  r.run(4);
  r.send(play(voice(1), 0.1), play(voice(2), 0.1));
  r.send(sends(voice(1), [0.5, 0, 0, 0]), sends(voice(2), [0, 0.5, 0, 0]));
  if (zones.a || zones.b) r.send(config(slots));
  r.run(200);
  return r;
}

const ARRIVAL_ORDERS = [
  [
    [K1, "room"],
    [K2, "corridor"],
  ],
  [
    [K2, "corridor"],
    [K1, "room"],
  ],
] as const;
type Order = (typeof ARRIVAL_ORDERS)[number];

/**
 * Blend's two zones (slot 0 room fed by voice 1, slot 1 corridor fed by voice 2), the kernels uploaded in `order`, the
 * table sent 4 quanta later (`"blend"`, as `blend`) or once every kernel chunk is committed (`"resident"`). Notes the
 * frame of the table, the frame by which the last kernel landed, and the longest kernel's IR support (its head and
 * tail partitions, in frames).
 */
async function arrival(order: Order, when: "blend" | "resident", quanta: number): Promise<Rig & { configured: number; landed: number; support: number }> {
  const r = await Rig.create();
  const frames = new Map<number, number>();
  for (const [id, preset] of order) frames.set(id, await r.kernel(id, preset));
  r.run(4);
  while (when === "resident" && !r.allResident()) r.run(1);
  const configured = r.host.frame;
  r.send(play(voice(1), 0.1), play(voice(2), 0.1));
  r.send(sends(voice(1), [0.5, 0, 0, 0]), sends(voice(2), [0, 0.5, 0, 0]));
  r.send(config([slot(K1, ZoneSlotState.Active, 1, frames.get(K1)!), slot(K2, ZoneSlotState.Active, 0.5, frames.get(K2)!)]));
  let landed = configured;
  for (let q = 0; q < quanta; q++) {
    // A chunk committed while rendering this quantum makes its slot start before the convolution (drained first). The
    // STATUS that reports the last kernel resident bounds that from above (by at most its 6-quantum interval).
    if (!r.allResident()) landed = r.host.frame + Q;
    r.run(1);
  }
  expect(r.allResident()).toBe(true);
  const partitions = (n: number): number => 4096 + Math.ceil(Math.max(0, n - 4096) / 2048) * 2048;
  const support = Math.max(...[...frames.values()].map(partitions));
  return Object.assign(r, { configured, landed, support });
}

describe("zones through the real wasm with real sends (C7)", () => {
  it("blend: two zones, each fed by its own voice's sends, add linearly into the dry mix", async () => {
    const both = await blend({ a: true, b: true });
    const dry = await blend({ a: false, b: false });
    const onlyA = await blend({ a: true, b: false });
    const onlyB = await blend({ a: false, b: true });
    const [b, d, a, c] = [both.output(), dry.output(), onlyA.output(), onlyB.output()];
    expect(both.table().startsWith("33")).toBe(true);
    expect(both.wetPeak(0)).toBeGreaterThan(0);
    expect(both.wetPeak(1)).toBeGreaterThan(0);
    // wet(both) = wet(A alone) + wet(B alone): slots are independent and add on their return bus (the limiter never acts at this level).
    let worst = 0;
    for (let i = 0; i < b.left.length; i++) worst = Math.max(worst, Math.abs(b.left[i]! - (d.left[i]! + (a.left[i]! - d.left[i]!) + (c.left[i]! - d.left[i]!))));
    expect(worst, `worst deviation`).toBeLessThan(1e-5);
    // The zones are heard, and they differ: each wet part is a real fraction of the dry level.
    let diffAB = 0;
    for (let i = 0; i < a.left.length; i++) diffAB += (a.left[i]! - c.left[i]!) ** 2;
    expect(diffAB).toBeGreaterThan(1e-3 * energy(d.left));
    checkGolden("zones-blend", both);
  }, 60_000);

  it("kernel order: with both kernels resident before ZONE_CONFIG, the upload order changes no bit", async () => {
    const outs: { left: Float32Array; right: Float32Array }[] = [];
    for (const order of [ARRIVAL_ORDERS[0], ARRIVAL_ORDERS[1]]) {
      const r = await arrival(order, "resident", 200);
      outs.push(r.output());
    }
    expect(Buffer.from(outs[0]!.left.buffer).equals(Buffer.from(outs[1]!.left.buffer))).toBe(true);
    expect(Buffer.from(outs[0]!.right.buffer).equals(Buffer.from(outs[1]!.right.buffer))).toBe(true);
  }, 60_000);

  it("kernel arrival: a kernel landing after ZONE_CONFIG starts its slot then, so the output differs until that start's tail has passed", async () => {
    // C7's finding, explained. The worklet commits clip chunks at 256 KB a quantum, so with blend's timing (the table 4
    // quanta after both uploads) the kernel uploaded second is still arriving when ZONE_CONFIG lands: its slot waits
    // (C5's table) and starts, fading in over 100 ms, a quantum or two later, without the sends of the quanta it waited
    // through. Upload order decides which slot is late, so the outputs differ (by up to the wet level) and are both
    // correct. Once every input a late slot missed has left its IR (the start, plus the IR's partitions), only f32
    // rounding of the shared transform blocks is left, and two tail blocks (4,096 frames) later not one bit.
    const runs = await Promise.all(ARRIVAL_ORDERS.map((order) => arrival(order, "blend", 470)));
    const [a, b] = runs.map((r) => r.output()) as [{ left: Float32Array; right: Float32Array }, { left: Float32Array; right: Float32Array }];
    const lateStart = Math.max(...runs.map((r) => r.landed));
    expect(lateStart).toBeGreaterThan(runs[0]!.configured);
    const support = Math.max(...runs.map((r) => r.support));
    const worst = (from: number, to = a.left.length): number => {
      let w = 0;
      for (let i = from; i < to; i++) w = Math.max(w, Math.abs(a.left[i]! - b.left[i]!), Math.abs(a.right[i]! - b.right[i]!));
      return w;
    };
    expect(worst(0, lateStart + 4800)).toBeGreaterThan(1e-3);
    expect(worst(lateStart + support)).toBeLessThan(1e-6);
    expect(worst(lateStart + support + 4096)).toBe(0);
    expect(a.left.length - (lateStart + support + 4096)).toBeGreaterThan(4096);
  }, 60_000);

  it("ring-out: a released zone keeps its tail for the IR's length, ignores sends, then its slot is off", async () => {
    const r = await Rig.create();
    const frames = await r.kernel(K1, "room");
    r.run(2);
    r.send(play(voice(1), 0.4), sends(voice(1), [0.8, 0, 0, 0]), config([slot(K1, ZoneSlotState.Active, 1, frames)]));
    r.run(100);
    expect(r.table()[0]).toBe(String(ZoneState.Active));
    // Release (and silence the dry voice): the sends are ignored, the tail rings out.
    r.send(stop(voice(1)), config([slot(K1, ZoneSlotState.Release, 1, frames)]));
    r.run(6);
    expect(r.table()[0]).toBe(String(ZoneState.RingingOut));
    // A voice sending into the ringing-out slot adds nothing to it: compare with a twin that never starts it.
    const tailStart = r.output().left.length;
    r.run(Math.ceil(frames / Q / 2));
    const mid = r.output().left;
    expect(energy(mid, tailStart + 4 * Q)).toBeGreaterThan(0);
    r.run(Math.ceil(frames / Q) + 80);
    expect(r.table()[0]).toBe(String(ZoneState.Off));
    const all = r.output().left;
    // The very end is exact silence (the slot stopped convolving; the dry voice is stopped).
    expect(energy(all, all.length - 8 * Q)).toBe(0);
    checkGolden("zones-ringout", r);
  }, 60_000);

  it("rebuild: RESET, the table waiting for its kernel, the kernel, the fade-in, the voices replayed", async () => {
    const r = await Rig.create();
    const frames = await r.kernel(K1, "hall");
    r.run(2);
    r.send(play(voice(1), 0.4), sends(voice(1), [0.5, 0, 0, 0]), config([slot(K1, ZoneSlotState.Active, 1, frames)]));
    r.run(80);
    expect(r.table()[0]).toBe(String(ZoneState.Active));
    // A hard rebuild (REPLAY): RESET frees the slots and the clips; the table arrives first and the slot waits for its kernel.
    r.send(reset);
    r.run(2);
    expect(r.table()[0]).toBe(String(ZoneState.Off));
    r.send(config([slot(K1, ZoneSlotState.Active, 1, frames)]));
    r.run(6);
    expect(r.table()[0]).toBe(String(ZoneState.WaitingKernel));
    // The clip, the voice and its send replay, then the kernel is prepared again (the worker kept the preset) and the slot starts and fades in.
    r.loadClip();
    r.send(play(voice(1), 0.4), sends(voice(1), [0.5, 0, 0, 0]));
    await r.kernel(K1, "hall");
    r.run(12);
    expect(["2", "3"]).toContain(r.table()[0]);
    r.run(100);
    expect(r.table()[0]).toBe(String(ZoneState.Active));
    expect(r.wetPeak(0)).toBeGreaterThan(0);
    checkGolden("zones-rebuild", r);
  }, 60_000);
});
