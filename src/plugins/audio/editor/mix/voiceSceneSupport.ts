// @internal Tests only (Pf2): a recorded synthetic voice scene with its ground truth, shared by `cursorModel.test.ts` and
// `voiceTableModel.test.ts`. Voices start, stop, are stolen and go virtual and real; a KEYFRAME (Rc1b's codec, built with
// `format.ts`'s encoders) opens each epoch and then every ~1 s. The truth is kept by a plain replay of the same operations,
// written independently of the model under test.
import { EventKind, RecordType, assembleCapture, type CaptureRecordInit, type KeyframeVoice } from "../../runtime/capture/format";
import { CaptureSource, type CaptureWorkerLike } from "./profilerSource";
import { createCaptureWorkerHandler, type CaptureRequest, type CaptureResponse } from "../../runtime/capture/worker";
import { SAMPLE_HEADER, SAMPLE_META, SAMPLE_RATE, statusBytesWith } from "../../runtime/capture/testSupport";
import type { StatusBlock } from "../../runtime/wire.generated";

export const FRAMES = 768; // one STATUS block
export const KEYFRAME_FRAMES = [768, 63 * FRAMES, 126 * FRAMES, 188 * FRAMES]; // 768, 48384, 96768, 144384
export const BLOCKS = 250;

/** Voice operations, in frames. busRef = gen 2 << 8 | slot. */
export type Op =
  | { frame: number; op: "start"; id: number; clip: number; slot: number; gain: number }
  | { frame: number; op: "stop"; id: number; reason: number }
  | { frame: number; op: "steal"; victim: number; thief: number; reason: number }
  | { frame: number; op: "virtual"; id: number; reason: number }
  | { frame: number; op: "real"; id: number; reason: number }
  | { frame: number; op: "eventStart"; id: number; asset: number }
  | { frame: number; op: "eventStop"; id: number };

export const OPS: readonly Op[] = [
  { frame: 1000, op: "start", id: 1, clip: 1, slot: 1, gain: 0.5 },
  { frame: 1500, op: "start", id: 2, clip: 2, slot: 1, gain: 0.75 },
  { frame: 2000, op: "eventStart", id: 10, asset: 5 },
  { frame: 30000, op: "start", id: 3, clip: 1, slot: 2, gain: 1 },
  { frame: 40000, op: "steal", victim: 1, thief: 3, reason: 3 },
  { frame: 47000, op: "virtual", id: 2, reason: 2 },
  { frame: 49000, op: "stop", id: 1, reason: 2 },
  { frame: 50000, op: "start", id: 4, clip: 3, slot: 2, gain: 0.25 },
  { frame: 60000, op: "real", id: 2, reason: 1 },
  { frame: 70000, op: "start", id: 5, clip: 2, slot: 1, gain: 0.125 },
  { frame: 80000, op: "stop", id: 3, reason: 1 },
  { frame: 90000, op: "virtual", id: 4, reason: 1 },
  { frame: 95000, op: "start", id: 6, clip: 3, slot: 1, gain: 0.5 },
  { frame: 96000, op: "steal", victim: 5, thief: 6, reason: 1 },
  { frame: 97000, op: "stop", id: 2, reason: 4 },
  { frame: 98000, op: "eventStart", id: 11, asset: 6 },
  { frame: 120000, op: "start", id: 7, clip: 1, slot: 2, gain: 0.5 },
  { frame: 121000, op: "eventStop", id: 10 },
  { frame: 150000, op: "stop", id: 4, reason: 3 },
  { frame: 150500, op: "stop", id: 6, reason: 1 },
];

export const NAMES = {
  clips: { 1: "jump.ogg", 2: "Land.ogg", 3: "footstep_grass.ogg" },
  buses: { 0: "Master", 1: "Music", 2: "SFX" },
  events: { 5: "PlayerJump", 6: "Ambience" },
};

/** What the table should hold: the recorded fields only. */
export interface TruthVoice { id: number; clip: number; slot: number; state: number; reason: number; gain: number; thief: number | null; stealFrame: number }

/** The voices after every op with frame <= `frame` (or < with `strict`), by a plain replay. */
export function truthAt(frame: number, strict = false): TruthVoice[] {
  const m = new Map<number, TruthVoice>();
  for (const o of OPS) {
    if (strict ? o.frame >= frame : o.frame > frame) continue;
    if (o.op === "start") m.set(o.id, { id: o.id, clip: o.clip, slot: o.slot, state: 0, reason: 0, gain: o.gain, thief: null, stealFrame: -1 });
    else if (o.op === "stop") m.delete(o.id);
    else if (o.op === "steal") Object.assign(m.get(o.victim)!, { state: 2, reason: o.reason, thief: o.thief, stealFrame: o.frame });
    else if (o.op === "virtual") Object.assign(m.get(o.id)!, { state: 1, reason: o.reason });
    else if (o.op === "real") Object.assign(m.get(o.id)!, { state: 0, reason: o.reason });
  }
  return [...m.values()].sort((a, b) => a.id - b.id);
}

/** Event instances after the ops at or before `frame`, as [id, asset] pairs. */
export function truthEventsAt(frame: number, strict = false): [number, number][] {
  const m = new Map<number, number>();
  for (const o of OPS) {
    if (strict ? o.frame >= frame : o.frame > frame) continue;
    if (o.op === "eventStart") m.set(o.id, o.asset);
    else if (o.op === "eventStop") m.delete(o.id);
  }
  return [...m].sort((a, b) => a[0] - b[0]);
}

export const priorityOf = (id: number): number => (id % 4) + 1;
export const audibilityOf = (id: number): number => (id * 4096) / 65536; // exact in u0.16

/** The recorded scene: STATUS every `FRAMES` with counters from `status`, keyframes before their STATUS, one EVENT per op, two markers. */
export function sceneRecords(status: (block: number, frame: number) => Partial<StatusBlock> = () => ({})): CaptureRecordInit[] {
  type Item = { frame: number; rank: number; make: (seq: number) => CaptureRecordInit };
  const items: Item[] = [];
  items.push({ frame: 0, rank: 0, make: (seq) => ({ seq, type: RecordType.EPOCH, epoch: 0, frame: 0, payload: { reason: 0, sampleRate: SAMPLE_RATE, limiterLatencyFrames: 64, outputLatencyFrames: 480, timeOffset: 0, perfMs: 1000 } }) });
  for (const kf of KEYFRAME_FRAMES) {
    items.push({
      frame: kf, rank: 1,
      make: (seq) => {
        const voices: KeyframeVoice[] = truthAt(kf, true).map((v) => ({
          id: v.id, clip: v.clip, slot: v.slot, state: v.state, priority: priorityOf(v.id), reason: v.reason, gain: v.gain,
          pitch: 4096 + v.id * 16, audibility: v.id * 4096, playheadFrames: v.id === 3 ? 1 : v.id * 1000,
        }));
        const events = truthEventsAt(kf, true).map(([id, asset]) => ({ id, asset, voices: 1, state: 1, paramsHash: 0 }));
        return {
          seq, type: RecordType.KEYFRAME, epoch: 0, frame: kf,
          payload: { voices, buses: [], metered: [], events, music: [], mix: { slotTableVersion: 1, monitorActive: 0, loudnessPausedMask: 0, targetIndex: 0, snapshotName: 0, masterVolume: 1, hiddenMute: 0 } },
        };
      },
    });
  }
  for (let i = 1; i <= BLOCKS; i++) {
    const frame = i * FRAMES;
    items.push({ frame, rank: 2, make: (seq) => ({ seq, type: RecordType.STATUS, epoch: 0, frame, payload: statusBytesWith({ currentFrame: frame, playheads: [{ id: 3, clipFrame: frame >> 1 }], ...status(i, frame) }) }) });
  }
  for (const o of OPS) {
    items.push({
      frame: o.frame, rank: 3,
      make: (seq) => {
        const base = { seq, type: RecordType.EVENT, epoch: 0, frame: o.frame } as const;
        const e = (kind: number, reason: number, args: number[], f32?: number) => ({ ...base, payload: { perfMs: 1000 + o.frame / 48, kind, reason, args, ...(f32 === undefined ? {} : { f32 }) } });
        switch (o.op) {
          case "start": return e(EventKind.voiceStart, 0, [o.id, o.clip, (2 << 8) | o.slot, 0, o.frame], o.gain);
          case "stop": return e(EventKind.voiceStop, o.reason, [o.id]);
          case "steal": return e(EventKind.voiceSteal, o.reason, [o.victim, o.thief]);
          case "virtual": return e(EventKind.voiceVirtual, o.reason, [o.id]);
          case "real": return e(EventKind.voiceReal, o.reason, [o.id]);
          case "eventStart": return e(EventKind.eventStart, 0, [o.id, o.asset]);
          case "eventStop": return e(EventKind.eventStop, 0, [o.id]);
        }
      },
    });
  }
  for (const [frame, text] of [[20000, "wave one"], [100000, "Boss Door"]] as const) {
    items.push({ frame, rank: 3, make: (seq) => ({ seq, type: RecordType.MARKER, epoch: 0, frame, payload: { perfMs: 1000 + frame / 48, text } }) });
  }
  items.sort((a, b) => a.frame - b.frame || a.rank - b.rank);
  return items.map((it, i) => it.make(i + 1));
}

export function sceneFile(status?: (block: number, frame: number) => Partial<StatusBlock>): Uint8Array {
  const meta = { ...SAMPLE_META, names: { ...SAMPLE_META.names, clips: NAMES.clips, buses: NAMES.buses, events: NAMES.events } };
  return assembleCapture(SAMPLE_HEADER, meta, sceneRecords(status), { index: true });
}

/** A Worker stand-in running the real handler in process (as `profilerSource.test.ts`). */
export function inProcessWorker(): CaptureWorkerLike {
  const w: CaptureWorkerLike & { terminated: boolean } = {
    onmessage: null,
    onerror: null,
    terminated: false,
    postMessage(message, transfer) {
      const copy = structuredClone(message, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.terminated) void handler.handle(copy as CaptureRequest); }, 0);
    },
    terminate() {
      w.terminated = true;
    },
  };
  const handler = createCaptureWorkerHandler({
    post: (r: CaptureResponse, transfer) => {
      const copy = structuredClone(r, { transfer: transfer as Transferable[] });
      setTimeout(() => { if (!w.terminated) w.onmessage?.({ data: copy }); }, 0);
    },
  });
  return w;
}

export async function openScene(status?: (block: number, frame: number) => Partial<StatusBlock>): Promise<CaptureSource> {
  return CaptureSource.openFile(sceneFile(status).slice().buffer, { worker: inProcessWorker() });
}
