// The selection bench's fixture, shared by `selectionBench.test.ts` (work counts, in `npm test`) and
// `selectionBench.bench.ts` (the wall-clock p99 gate, run apart from `npm test`; see tools/audio-bench).
// 4,096 logical voices on the core, a tenth of the gains moving every frame (sources moving, fades), a few voices
// crossing the cap each frame. `spatial` adds the gain refresh for every voice (listener moving each frame: distance
// model and listener-space direction) to show the whole per-frame bookkeeping.
import { ListenerBasis, Selection, type SelectionSink, type SelectionStats } from "./selection";
import { DistanceEffect } from "./spatial";
import { VoiceFlag, VoiceState, VoiceTable } from "./voiceTable";

export const VOICES = 4096;

/** Seeded generator (mulberry32). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface RigRun {
  /** SET_MIXED changes the sink saw over the whole run (warmup included). */
  changes: number;
}

/**
 * Builds the table, runs `warmup + frames` frames of `Selection.run`, and calls `observe(frameIndex, stats, dtMs)` for
 * each frame after the warmup. `dtMs` is the `performance.now()` span of the frame's selection work (the spatial
 * refresh included when `spatial`); the test ignores it, the bench gates its p99.
 */
export function runRig(
  cap: number,
  spatial: boolean,
  seed: number,
  warmup: number,
  frames: number,
  observe: (frame: number, stats: SelectionStats, dtMs: number) => void,
): RigRun {
  const r = rng(seed);
  const table = new VoiceTable(VOICES);
  const sel = new Selection(table);
  let changes = 0;
  const sink: SelectionSink = {
    setMixed: () => void changes++,
    steal: () => {},
    setScore: () => {}, // A3.3: the score refresh runs in the same loop
  };
  for (let k = 0; k < VOICES; k++) {
    const i = table.allocate(k % 8, Math.floor(r() * 256), 1 + (k % 4), VoiceState.WAITING_FOR_DATA) & 0xffff;
    table.gain[i] = r();
    table.posX[i] = (r() - 0.5) * 200;
    table.posY[i] = (r() - 0.5) * 20;
    table.posZ[i] = (r() - 0.5) * 200;
    table.flags[i] = VoiceFlag.SPATIAL | (k % 3 === 0 ? VoiceFlag.LOOP : 0);
    table.state[i] = sel.admit(i, cap) ? VoiceState.PLAYING : VoiceState.VIRTUAL;
    sel.noteScoreSent(i, table.audibility[i]!); // as the PLAY would carry it
  }
  for (let b = 0; b < 8; b++) sel.busGain[b] = 0.5 + b / 16;
  const basis = new ListenerBasis();
  const distance = new DistanceEffect();
  const pos = [0, 0, 0];
  const fwd = [0, 0, 1];
  const up = [0, 1, 0];
  let t = 0;
  for (let f = 0; f < warmup + frames; f++) {
    // A tenth of the gains move a little; a few jump (a sound starting, a fade landing).
    for (let k = 0; k < VOICES / 10; k++) {
      const i = Math.floor(r() * VOICES);
      const g = table.gain[i]! * (0.9 + 0.2 * r());
      table.gain[i] = g > 1 ? 1 : g;
    }
    for (let k = 0; k < 4; k++) table.gain[Math.floor(r() * VOICES)] = r();
    const t0 = performance.now();
    if (spatial) {
      t += 1 / 60;
      pos[0] = 50 * Math.sin(t);
      pos[2] = 50 * Math.cos(t);
      fwd[0] = Math.cos(t);
      fwd[2] = -Math.sin(t);
      basis.set(pos, fwd, up);
      for (let i = 0; i < VOICES; i++) {
        basis.locate(table.posX[i]!, table.posY[i]!, table.posZ[i]!);
        distance.refDistance = 1;
        distance.maxDistance = 100;
        table.gain[i] = Math.max(0, distance.gain(basis.distance));
        table.dirX[i] = basis.dirX;
        table.dirY[i] = basis.dirY;
        table.dirZ[i] = basis.dirZ;
      }
    }
    const stats = sel.run(cap, sink);
    const dt = performance.now() - t0;
    if (f >= warmup) observe(f - warmup, stats, dt);
  }
  return { changes };
}
