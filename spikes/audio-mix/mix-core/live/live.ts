// S4 question 3: live mix edits through the REAL core (the committed myco_audio.wasm in the Node loopback host of
// src/plugins/audio/runtime/testing.ts). Each scenario plays two looping tone voices (one on Music, one on SFX), applies one
// edit at a quantum boundary exactly as main would send it (BUS_CONFIG and/or BUS_MIX and/or SET_PARAMS and/or PLAY/STOP in
// one batch), and compares the output with an identical run without the edit.
import { createLoopbackHost, LOOPBACK_PRESET, LOOPBACK_RATE, type LoopbackHost } from "../../../../src/plugins/audio/runtime/testing";
import {
  ASAP, Kind, PLAY_FLAGS_LOOP, PLAY_FLAGS_MIXED, SET_PARAMS_MASK_BUS,
  writeBatchHeader, writeBusConfig, writeBusMix, writeClipBegin, writeClipChunk, writeEnvelope, writePlay, writeSetParams, writeStop,
  type BusConfigBuses, type BusMixBuses,
} from "../../../../src/plugins/audio/runtime/wire.generated";

const Q = 128;
const FRAMES = 48_000; // 1 s clips of whole cycles: the loop seam is seamless
type Writer = (view: DataView, off: number) => number;
type Fx = { type: number; p: number[] };
const LP = (hz: number, q = 1): Fx => ({ type: 0, p: [hz, q, 0, 0, 0, 0, 0] });
const HP = (hz: number, q = 1): Fx => ({ type: 1, p: [hz, q, 0, 0, 0, 0, 0] });
const COMP = (thr: number): Fx => ({ type: 2, p: [thr, 6, 4, 0.003, 0.25, 0, 0] });
const REV = (send: number): Fx => ({ type: 3, p: [send, 0, 0, 0, 0, 0, 0] });
type Tree = { parent: number; fx: Fx[] }[];
const ROOT = 0xffff;

const clipData = (tones: [number, number][]): Float32Array => {
  const out = new Float32Array(FRAMES);
  for (let i = 0; i < FRAMES; i++) {
    let v = 0;
    for (const [hz, a] of tones) v += a * Math.sin((2 * Math.PI * hz * i) / LOOPBACK_RATE);
    out[i] = v;
  }
  return out;
};

class Rig {
  seq = 1;
  host!: LoopbackHost;
  left: Float32Array[] = [];
  static async create(): Promise<Rig> {
    const r = new Rig();
    // limiter look-ahead 0: the output is the mix itself, with no delay and nothing limited (the tones sum under 0.7)
    r.host = await createLoopbackHost({ preset: { ...LOOPBACK_PRESET, limiterLookaheadMs: 0, maxBuses: 8 } });
    r.clip(1, clipData([[220, 0.15], [880, 0.1], [1760, 0.05]]));
    r.clip(2, clipData([[330, 0.15], [990, 0.1], [1650, 0.05]]));
    return r;
  }
  clip(id: number, data: Float32Array): void {
    const begin = new ArrayBuffer(16 + 20);
    const bv = new DataView(begin);
    writeEnvelope(bv, 0, { kind: Kind.CLIP_BEGIN, seq: this.seq++, bodyBytes: 20 });
    writeClipBegin(bv, 0, { clipId: id, frames: FRAMES, channels: 1, sampleRate: LOOPBACK_RATE, format: 0 });
    this.host.send(begin);
    for (let f = 0; f < FRAMES; f += 2048) {
      const n = Math.min(2048, FRAMES - f);
      const chunk = new ArrayBuffer(16 + 16 + n * 4);
      const cv = new DataView(chunk);
      writeEnvelope(cv, 0, { kind: Kind.CLIP_CHUNK, seq: this.seq++, bodyBytes: 16 + n * 4 });
      writeClipChunk(cv, 0, { clipId: id, frameOffset: f, frames: n, reserved: 0 });
      new Uint8Array(chunk, 32).set(new Uint8Array(data.buffer, f * 4, n * 4));
      this.host.send(chunk);
    }
    this.host.renderQuanta(1 + Math.ceil((FRAMES * 4) / (256 * 1024))); // the worklet drains clip chunks at 256 KB a quantum
  }
  send(...records: Writer[]): void {
    const scratch = new ArrayBuffer(32 + 8192);
    const view = new DataView(scratch);
    let at = 32;
    for (const w of records) at += w(view, at);
    writeEnvelope(view, 0, { kind: Kind.BATCH, seq: this.seq++, bodyBytes: at - 16 });
    writeBatchHeader(view, 0, { firstFrame: this.host.frame, count: records.length, flags: 0 });
    this.host.send(scratch.slice(0, at));
  }
  run(q: number): void {
    this.left.push(this.host.renderQuanta(q).left);
  }
  output(): Float32Array {
    const out = new Float32Array(this.left.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of this.left) { out.set(p, at); at += p.length; }
    return out;
  }
}

const busConfig = (tree: Tree): Writer => (v, o) => writeBusConfig(v, o, { voiceId: 0, frameOffset: ASAP, buses: tree.map((b): BusConfigBuses => ({ parent: b.parent, effects: b.fx })) });
const busMix = (gains: number[], ramp: number, lp: number[] = []): Writer => (v, o) => writeBusMix(v, o, { voiceId: 0, frameOffset: ASAP, rampFrames: ramp, buses: gains.map((g, i): BusMixBuses => ({ gain: g, lpHz: lp[i] ?? 24_000 })) });
const voiceId = (n: number) => 0x0001_0000 | n;
const play = (n: number, clip: number, bus: number): Writer => (v, o) =>
  writePlay(v, o, { voiceId: voiceId(n), frameOffset: ASAP, clip, bus, flags: PLAY_FLAGS_MIXED | PLAY_FLAGS_LOOP, group: 0, gate: 0, gain: 1, pitch: 1, dirX: 0, dirY: 0, dirZ: -1, lpHz: 20_000, score: 0, startOffsetFrames: 0 });
const stop = (n: number): Writer => (v, o) => writeStop(v, o, { voiceId: voiceId(n), frameOffset: ASAP, fadeFrames: 0, reason: 0 });
const setBus = (n: number, bus: number): Writer => (v, o) =>
  writeSetParams(v, o, { voiceId: voiceId(n), frameOffset: ASAP, mask: SET_PARAMS_MASK_BUS, gain: 0, pitch: 0, dirX: 0, dirY: 0, dirZ: 0, lpHz: 0, score: 0, bus, rampFrames: 0, flags: 0 });

const RAMP = 800; // rampFrames at 60 fps (clock.ts: the frame interval, clamped 5..50 ms)
const base = (): Tree => [{ parent: ROOT, fx: [] }, { parent: 0, fx: [LP(8000)] }, { parent: 0, fx: [COMP(-24)] }];
const GAINS = [1, 0.8, 1];

interface Scenario {
  name: string;
  /** What the edit is, in the words of the design. */
  note: string;
  tree?: Tree;
  edit(r: Rig): void;
  /** Whether the edit should be audibly a level change (so settle time is meaningful). */
  level?: boolean;
}

const sc: Scenario[] = [
  { name: "control: no-op (BUS_CONFIG + BUS_MIX resent unchanged)", note: "main resends the whole tree on any edit", edit: (r) => r.send(busConfig(base()), busMix(GAINS, RAMP)) },
  { name: "control: bus gain jump, rampFrames 0", note: "positive control for the click metric", level: true, edit: (r) => r.send(busMix([1, 0.4, 1], 0)) },
  { name: "bus volume 0.8->0.4, rampFrames 800 (60 fps)", note: "BUS_MIX", level: true, edit: (r) => r.send(busMix([1, 0.4, 1], RAMP)) },
  { name: "bus volume 0.8->0.4, rampFrames 128", note: "BUS_MIX", level: true, edit: (r) => r.send(busMix([1, 0.4, 1], Q)) },
  { name: "lowpass cutoff 8000->1200 Hz", note: "BUS_CONFIG, same slot kind", edit: (r) => r.send(busConfig([base()[0]!, { parent: 0, fx: [LP(1200)] }, base()[2]!]), busMix(GAINS, RAMP)) },
  { name: "lowpass cutoff 8000->300 Hz, Q 12 dB", note: "BUS_CONFIG, resonant", edit: (r) => r.send(busConfig([base()[0]!, { parent: 0, fx: [LP(300, 12)] }, base()[2]!]), busMix(GAINS, RAMP)) },
  { name: "compressor threshold -24->-30 dB", note: "BUS_CONFIG, same slot", level: true, edit: (r) => r.send(busConfig([base()[0]!, base()[1]!, { parent: 0, fx: [COMP(-30)] }]), busMix(GAINS, RAMP)) },
  { name: "compressor threshold -24->-50 dB", note: "BUS_CONFIG, same slot", level: true, edit: (r) => r.send(busConfig([base()[0]!, base()[1]!, { parent: 0, fx: [COMP(-50)] }]), busMix(GAINS, RAMP)) },
  { name: "add effect: highpass 400 Hz after the lowpass", note: "BUS_CONFIG, new slot", edit: (r) => r.send(busConfig([base()[0]!, { parent: 0, fx: [LP(8000), HP(400)] }, base()[2]!]), busMix(GAINS, RAMP)) },
  { name: "remove effect: lowpass 8000 off the bus", note: "BUS_CONFIG, slot dropped", edit: (r) => r.send(busConfig([base()[0]!, { parent: 0, fx: [] }, base()[2]!]), busMix(GAINS, RAMP)) },
  { name: "remove the first of two effects (LP+HP -> HP)", note: "BUS_CONFIG, slots shift", tree: [{ parent: ROOT, fx: [] }, { parent: 0, fx: [LP(3000), HP(150)] }, { parent: 0, fx: [COMP(-24)] }], edit: (r) => r.send(busConfig([{ parent: ROOT, fx: [] }, { parent: 0, fx: [HP(150)] }, { parent: 0, fx: [COMP(-24)] }]), busMix(GAINS, RAMP)) },
  { name: "insert an effect before the lowpass (HP 150, LP 8000)", note: "BUS_CONFIG, slots shift", edit: (r) => r.send(busConfig([base()[0]!, { parent: 0, fx: [HP(150), LP(8000)] }, base()[2]!]), busMix(GAINS, RAMP)) },
  { name: "add a bus at the end (empty, unity)", note: "BUS_CONFIG, count 3->4", edit: (r) => r.send(busConfig([...base(), { parent: 0, fx: [] }]), busMix([...GAINS, 1], RAMP)) },
  { name: "add a bus at the end and move the SFX voice to it", note: "BUS_CONFIG + SET_PARAMS bus", edit: (r) => r.send(busConfig([...base(), { parent: 0, fx: [] }]), busMix([...GAINS, 1], RAMP), setBus(2, 3)) },
  { name: "change parent: SFX moves under Music (gain 0.8, lowpass 8000)", note: "BUS_CONFIG, new tree order", level: true, edit: (r) => r.send(busConfig([base()[0]!, base()[1]!, { parent: 1, fx: [COMP(-24)] }]), busMix(GAINS, RAMP)) },
  { name: "insert a bus in the middle (indices shift, voices re-routed)", note: "BUS_CONFIG + SET_PARAMS bus x2", edit: (r) => r.send(busConfig([base()[0]!, { parent: 0, fx: [] }, base()[1]!, base()[2]!]), busMix([1, 1, 0.8, 1], RAMP), setBus(1, 2), setBus(2, 3)) },
  { name: "reverb send 0.3->0.8 (reverb already on)", note: "BUS_CONFIG, send level", level: true, tree: [{ parent: ROOT, fx: [] }, base()[1]!, { parent: 0, fx: [COMP(-24), REV(0.3)] }], edit: (r) => r.send(busConfig([{ parent: ROOT, fx: [] }, base()[1]!, { parent: 0, fx: [COMP(-24), REV(0.8)] }]), busMix(GAINS, RAMP)) },
  { name: "add the first reverb send (convolver off -> on)", note: "BUS_CONFIG, has_reverb 0->1", level: true, edit: (r) => r.send(busConfig([base()[0]!, base()[1]!, { parent: 0, fx: [COMP(-24), REV(0.5)] }]), busMix(GAINS, RAMP)) },
  { name: "remove the last reverb send (convolver on -> off, tail mid-flight)", note: "BUS_CONFIG, has_reverb 1->0", level: true, tree: [{ parent: ROOT, fx: [] }, base()[1]!, { parent: 0, fx: [COMP(-24), REV(0.5)] }], edit: (r) => r.send(busConfig(base()), busMix(GAINS, RAMP)) },
];

function analyse(ref: Float32Array, got: Float32Array, from: number, level: boolean) {
  const n = ref.length;
  let refStep = 0, gotStep = 0, dStep = 0, onset = -1, dPeak = 0;
  for (let i = from; i < n; i++) {
    refStep = Math.max(refStep, Math.abs(ref[i]! - ref[i - 1]!));
    gotStep = Math.max(gotStep, Math.abs(got[i]! - got[i - 1]!));
    const d = got[i]! - ref[i]!, dp = got[i - 1]! - ref[i - 1]!;
    dStep = Math.max(dStep, Math.abs(d - dp));
    dPeak = Math.max(dPeak, Math.abs(d));
    if (onset < 0 && Math.abs(d) > 1e-5) onset = i - from;
  }
  const rms = (a: Float32Array, s: number, e: number) => { let t = 0; for (let i = s; i < e; i++) t += a[i]! * a[i]!; return Math.sqrt(t / (e - s)); };
  const qn = Math.floor((n - from) / Q);
  const fin = rms(got, n - 4 * Q, n);
  let settleQ = 0, maxDev = 0;
  for (let k = 0; k < qn; k++) {
    const dev = Math.abs(20 * Math.log10(rms(got, from + k * Q, from + (k + 1) * Q) / fin));
    maxDev = Math.max(maxDev, dev);
    if (dev >= 1) settleQ = k + 1;
  }
  const prePeak = (() => { let m = 0; for (let i = 0; i < from; i++) m = Math.max(m, Math.abs(ref[i]! - got[i]!)); return m; })();
  return {
    preEditIdentical: prePeak === 0,
    refMaxStep: +refStep.toFixed(5),
    jumpRatio: +(gotStep / refStep).toFixed(2),
    abrupt: dPeak > 1e-5 ? +(dStep / dPeak).toFixed(2) : 0,
    stepDbfs: dStep > 0 ? +(20 * Math.log10(dStep)).toFixed(1) : -200,
    onsetFrames: onset,
    diffPeak: +dPeak.toFixed(4),
    settleMs: level && maxDev >= 1 ? +(((settleQ * Q) / LOOPBACK_RATE) * 1000).toFixed(1) : null,
  };
}

async function runOne(s: Scenario, withEdit: boolean, warm: number): Promise<Float32Array> {
  const r = await Rig.create();
  const tree = s.tree ?? base();
  r.send(busConfig(tree), busMix(GAINS, 0), play(1, 1, 1), play(2, 2, 2));
  r.run(warm); // warm: filters, compressor and (if present) the reverb tail are running
  if (withEdit) s.edit(r);
  else if (s.name.startsWith("control: no-op")) { /* the reference stays untouched */ }
  r.run(64 - warm);
  return r.output();
}

// The edit lands at quantum 12..19 (the tones' phase differs at each, so a jump's step is not hidden by a zero crossing);
// the worst of the eight is reported (clickRatio, jumpRatio, diffPeak: max; onset: min; settle: max).
const rows: unknown[] = [];
for (const s of sc) {
  const rs = [];
  for (const warm of [12, 13, 14, 15, 16, 17, 18, 19]) {
    const ref = await runOne(s, false, warm);
    const got = await runOne(s, true, warm);
    rs.push(analyse(ref, got, warm * Q, !!s.level));
  }
  const worst = (k: keyof (typeof rs)[0]) => Math.max(...rs.map((r) => Number(r[k] ?? -1)));
  rows.push({
    edit: s.name, via: s.note,
    preEditIdentical: rs.every((r) => r.preEditIdentical),
    abrupt: worst("abrupt"), stepDbfs: worst("stepDbfs"), verdict: worst("abrupt") > 0.3 ? "CLICK" : worst("abrupt") === 0 ? "identical" : "smooth", jumpRatio: worst("jumpRatio"), diffPeak: worst("diffPeak"),
    onsetFramesMin: Math.min(...rs.map((r) => r.onsetFrames)), settleMs: rs.some((r) => r.settleMs !== null) ? worst("settleMs") : null,
  });
}

// Reverb tail when the last send goes: removed at E with the dry voices stopped at the same time, back 20 quanta later with silent input.
// The reference keeps the send throughout (the tail rings out). The compressor's 6 ms pre-delay flushes in the first 3 quanta, so the
// windows start 4 quanta after the edit.
{
  const withRev: Tree = [{ parent: ROOT, fx: [] }, base()[1]!, { parent: 0, fx: [COMP(-24), REV(0.5)] }];
  const go = async (remove: boolean): Promise<Float32Array> => {
    const r = await Rig.create();
    r.send(busConfig(withRev), busMix(GAINS, 0), play(1, 1, 1), play(2, 2, 2));
    r.run(60);
    r.send(remove ? busConfig(base()) : busConfig(withRev), busMix(GAINS, RAMP), stop(1), stop(2));
    r.run(20);
    r.send(busConfig(withRev), busMix(GAINS, RAMP));
    r.run(8);
    return r.output();
  };
  const ref = await go(false), got = await go(true);
  const peak = (a: Float32Array, q0: number, q1: number) => { let m = 0; for (let i = q0 * Q; i < q1 * Q; i++) m = Math.max(m, Math.abs(a[i]!)); return +m.toExponential(2); };
  rows.push({
    edit: "reverb tail when the last send is removed (dry stopped), then the send returns 20 quanta later",
    tailRingingInReference_q64to70: peak(ref, 64, 70), tailAfterRemoval_q64to70: peak(got, 64, 70),
    outputWhileSendIsBack_afterReAdd_q80to88: peak(got, 80, 88), referenceSameWindow: peak(ref, 80, 88),
    verdict: peak(got, 64, 70) === 0 && peak(ref, 64, 70) > 1e-3 ? "tail cut to silence in one quantum" : "tail rings out",
    staleTailReplaysOnReAdd: peak(got, 80, 88) > 1e-3,
  });
}
console.log(JSON.stringify(rows));
