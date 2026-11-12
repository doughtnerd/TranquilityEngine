// Synthetic scene generator for the capture spike. Produces the same three streams a recorder would see:
// STATUS blocks (real wire layout via writeStatus), main-side events, and the main-side voice table.
// SYNTHETIC: no real core runs here (the loopback host needs the vitest/TS pipeline; see README "what is not measured").
import { writeStatus } from "../../../src/plugins/audio/runtime/wire.generated.ts";
import { EV } from "./codec.mjs";

export const QUANTUM = 128, RATE = 48000, BLOCK_QUANTA = 6;
export const BLOCK_US = (BLOCK_QUANTA * QUANTUM * 1e6) / RATE; // 16,000 us
export const BLOCKS_PER_MIN = Math.round(60e6 / BLOCK_US); // 3,750

/** Scene presets: live voices N, mean voice life (s), mixed cap (the preset the engine would pick), buses. */
export const SCENES = {
  64: { N: 64, life: 3.0, mixedCap: 64, buses: 8, loopFrac: 0.25, name: "64 live (low preset; sound-lab-like)" },
  256: { N: 256, life: 2.5, mixedCap: 128, buses: 12, loopFrac: 0.3, name: "256 live (default preset)" },
  1024: { N: 1024, life: 2.0, mixedCap: 256, buses: 16, loopFrac: 0.3, name: "1,024 live (stress)" },
};

export function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }

export function newBlock() {
  return {
    currentFrame: 0, dateMs: 0, pingSeq: 0, pingFrameLo: 0, underruns: 0, lateCommands: 0, workUnits: 0, workUnitsMax: 0, mixedVoices: 0, liveVoices: 0, flags: 0x10,
    mixedCap: 0, loadPermille: 0, traps: 0, minSlackFrames: 0, underrunFrames: 0, arenaUsedKB: 0, arenaLargestFreeKB: 0, abiVersion: 1, maxLatenessFrames: 0, hrtfVoices: 0, hrtfLoadFailure: 0,
    bedVoices: 0, fxVoices: 0, ambisonicVoices: 0, zonesActive: 0, zonesRinging: 0, bedsRefused: 0, m3Shed: 0, zoneUsedKB: 0, workBed: 0, workZones: 0, musicRingsOpen: 0, streamStartsLate: 0,
    groupsLate: 0, groupsHeld: 0, groupsAbandoned: 0, curvePoolFull: 0, maxSlipFrames: 0, splitQuanta: 0, voiceSplits: 0, reserved: 0,
    ended: [], demoted: [], starved: [], playheads: [], clipEvents: [], streamEvents: [], peaks: [], beds: [], zones: [], zoneEvents: [], musicRings: [], groupStarts: [],
  };
}

/**
 * Runs `seconds` of the scene. Callbacks (all optional): onStatus(tUs, block), onEvent(tUs,type,a,b,c,d,f), onKeyframe(tUs,n,table).
 * `block` is reused between calls (like the engine's StatusReader), so a callback that keeps it must copy.
 */
export function runScene(scene, seconds, cb, seed = 1) {
  const { N, life, mixedCap, buses, loopFrac } = scene;
  const rand = rng(seed);
  const tbl = { id: new Uint32Array(N), clip: new Uint16Array(N), bus: new Uint8Array(N), state: new Uint8Array(N), prio: new Uint8Array(N), gain: new Float32Array(N), pitch: new Float32Array(N), aud: new Float32Array(N), playhead: new Uint32Array(N) };
  const loop = new Uint8Array(N), start = new Float64Array(N);
  let nextId = 1, nextInst = 1, workWalk = 40, music = 0;
  const loopers = []; // slot indices that loop (reported in playheads, round-robin)
  const spawn = (slot, tUs, frame, cause) => {
    const id = nextId++;
    tbl.id[slot] = id; tbl.clip[slot] = (rand() * 400) | 0; tbl.bus[slot] = (rand() * buses) | 0; tbl.prio[slot] = (rand() * 128) | 0;
    tbl.gain[slot] = Math.fround(0.2 + rand() * 0.8); tbl.pitch[slot] = rand() < 0.9 ? 1 : 0.8 + rand() * 0.4; tbl.aud[slot] = rand();
    tbl.state[slot] = 0; loop[slot] = rand() < loopFrac ? 1 : 0; start[slot] = frame;
    if (cb.onEvent) cb.onEvent(tUs, EV.VOICE_START, id, tbl.clip[slot], tbl.bus[slot], tbl.prio[slot], 0);
    return id;
  };
  let frame = 0;
  for (let i = 0; i < N; i++) spawn(i, 0, 0);
  const blk = newBlock();
  blk.mixedCap = mixedCap;
  const peak = new Float32Array(buses * 2);
  let rr = 0;
  const nBlocks = Math.round((seconds * 1e6) / BLOCK_US);
  const startsPerBlock = (N / life) * (BLOCK_US / 1e6);
  let kfDue = 0;
  for (let k = 0; k < nBlocks; k++) {
    const tUs = k * BLOCK_US;
    frame = k * BLOCK_QUANTA * QUANTUM;
    const ended = blk.ended, demoted = blk.demoted;
    ended.length = 0; demoted.length = 0; blk.starved.length = 0;
    // churn: voices end and are replaced (main spawns the new ones in the same frame, as a game would)
    let n = Math.floor(startsPerBlock) + (rand() < startsPerBlock % 1 ? 1 : 0);
    for (let j = 0; j < n; j++) {
      const slot = (rand() * N) | 0;
      const oldId = tbl.id[slot];
      ended.push(oldId);
      const t2 = tUs + rand() * BLOCK_US;
      if (cb.onEvent) {
        const r = rand();
        if (r < 0.03) cb.onEvent(t2, EV.VOICE_STEAL, oldId, nextId, r < 0.02 ? 0 : 1, 0, 0);
        else cb.onEvent(t2, EV.VOICE_STOP, oldId, rand() < 0.8 ? 0 : 1, 0, 0, 0);
      }
      const id = spawn(slot, t2, frame);
      if (rand() < 0.03) { demoted.push(id); tbl.state[slot] = 1; if (cb.onEvent) cb.onEvent(t2, EV.VOICE_VIRT, id, 0, 0, 0, 0); }
      if (rand() < 0.08 && cb.onEvent) { const inst = nextInst++; cb.onEvent(t2, EV.EVT_START, inst, (rand() * 60) | 0, 0, 0, 0); if (rand() < 0.5) cb.onEvent(t2 + 300000, EV.EVT_STOP, inst, 0, 0, 0, 0); }
    }
    // slow events: parameters 30/s, bus mix 12/s (fades step per frame while active), music 0.2/s
    if (cb.onEvent) {
      const p = 30 * (BLOCK_US / 1e6), q = 12 * (BLOCK_US / 1e6);
      if (rand() < p) cb.onEvent(tUs + 100, EV.PARAM, (rand() * 20) | 0, (rand() * 8) | 0, 0, 0, Math.fround(rand()));
      if (rand() < q) cb.onEvent(tUs + 200, EV.BUS_MIX, (rand() * buses) | 0, 0, (rand() < 0.1 ? 800 : 24000), 20, Math.fround(rand()));
      if (rand() < 0.2 * (BLOCK_US / 1e6)) cb.onEvent(tUs + 300, EV.MUSIC, 1, music, ++music, 1, 0);
    }
    // loopers list (cheap rebuild each block would be wasteful: rebuild when churn touched it; N small enough to rebuild per 16 blocks)
    if (k % 16 === 0) { loopers.length = 0; for (let i = 0; i < N; i++) if (loop[i]) loopers.push(i); }
    // STATUS block
    blk.currentFrame = frame; blk.dateMs = 1.7e12 + Math.round((tUs + (rand() - 0.5) * 400) / 1000 * 1000) / 1000;
    blk.liveVoices = N; blk.mixedVoices = Math.min(N, mixedCap);
    workWalk = Math.max(5, Math.min(100, workWalk + (rand() - 0.5) * 4));
    blk.workUnits = Math.round(workWalk * 100 * (blk.mixedVoices / 64)); blk.workUnitsMax = Math.max(blk.workUnitsMax, blk.workUnits);
    blk.minSlackFrames = 90 + ((rand() * 20) | 0); blk.mixedCap = mixedCap;
    blk.fxVoices = (blk.mixedVoices * 0.2) | 0; blk.zonesActive = 2; blk.bedVoices = 8; blk.musicRingsOpen = 3; blk.zoneUsedKB = 640; blk.arenaUsedKB = 1200 + (k >> 6);
    blk.pingSeq = (k / 40) | 0;
    blk.playheads.length = 0;
    const cap = Math.min(256, loopers.length);
    for (let i = 0; i < cap; i++) {
      const slot = loopers[(rr + i) % loopers.length];
      const clip = Math.floor((frame - start[slot]) * tbl.pitch[slot]);
      blk.playheads.push({ id: tbl.id[slot], clipFrame: Math.max(0, clip) % 2000000 });
    }
    rr = (rr + cap) % Math.max(1, loopers.length);
    blk.peaks.length = 0;
    for (let b = 0; b < buses; b++) {
      for (let c = 0; c < 2; c++) {
        const i = b * 2 + c;
        const nv = rand() < 0.3 ? Math.fround(rand() * 0.5) : 0;
        peak[i] = Math.fround(Math.max(peak[i] * 0.9967, nv)); // 20 dB/s fall at 62.5 blocks/s
      }
      blk.peaks.push({ l: peak[b * 2], r: peak[b * 2 + 1] });
    }
    blk.zones.length = 0; blk.musicRings.length = 0; blk.beds.length = 0;
    blk.zones.push({ kernelId: 0xffff0200, state: 3, pad: 0, quantaSinceInput: k % 50, wetPeak: Math.fround(peak[0] * 0.3) }, { kernelId: 0xffff0201, state: 4, pad: 0, quantaSinceInput: 20, wetPeak: 0 });
    for (let i = 0; i < 3; i++) blk.musicRings.push({ streamId: 100 + i, epochFlags: 0xc0000000 + 1 });
    blk.beds.push({ bus: 2, voices: 8, work: 300 });
    if (cb.onStatus) cb.onStatus(tUs, blk, frame);
    if (cb.onKeyframe && tUs >= kfDue) {
      for (let i = 0; i < N; i++) tbl.playhead[i] = loop[i] ? Math.max(0, Math.floor((frame - start[i]) * tbl.pitch[i])) % 2000000 : Math.max(0, frame - start[i]);
      cb.onKeyframe(tUs, N, tbl); kfDue += 1e6;
    }
  }
  return { tbl, blocks: nBlocks };
}

/** Wire bytes of a block (real layout). */
const rawView = new DataView(new ArrayBuffer(1 << 15));
export const rawBytes = new Uint8Array(rawView.buffer);
export function wireWrite(blk, seq) { return writeStatus(rawView, 0, blk, seq); }
