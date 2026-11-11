// Throwaway spike code: the occlusion pass as the audio system would run it on the main thread.
// Rays go through the engine's own API (Physics.raycast -> World service -> core -> Rapier backend).
import { Physics, type Level, MATERIALS, OCCLUDER, type Pt } from "./scene";

export const GAIN_LIN = Float64Array.from(MATERIALS, (m) => Math.pow(10, -m.db / 20));
export const LP_LOG2 = Float64Array.from(MATERIALS, (m) => Math.log2(m.lpHz));
export const LP_OPEN_LOG2 = Math.log2(20000);

const now = () => performance.now();

/** Ray pattern: offsets (m) at the source, perpendicular to the ray. R=1 centre; 3 adds +-1 m lateral; 5 adds +-1 m vertical. */
const PATTERN: Record<number, number[][]> = {
  1: [[0, 0]],
  3: [[0, 0], [1, 0], [-1, 0]],
  5: [[0, 0], [1, 0], [-1, 0], [0, 1], [0, -1]],
};

export interface CastOptions { R: number; layers: string[] | undefined; chain: number }

export interface SchedOptions {
  R: number;
  layers: string[] | undefined;
  /** Sources recast every frame, ranked by audibility. */
  tier: number;
  /** Share of the budget the tier may use (0..1). */
  tierShare: number;
  roundRobin: boolean;
  /** Time budget (ms of main thread, rays + hit processing) OR a count budget (source-casts per frame). */
  budgetMs?: number;
  budgetCasts?: number;
  /** Smoothing time constant (s) for gain and cutoff. */
  tau: number;
}

export class Occlusion {
  readonly S: number;
  gain: Float64Array; lpLog: Float64Array;
  tgtGain: Float64Array; tgtLp: Float64Array;
  outGain: Float32Array; outLp: Float32Array;
  stamp: Int32Array; centerHit: Uint8Array;
  cursor = 0;
  private top: Int32Array; private topScore: Float64Array;
  private o = { x: 0, y: 0, z: 0 }; private d = { x: 0, y: 0, z: 0 };
  rays = 0;

  constructor(readonly level: Level, readonly pos: Float64Array, readonly loud: Float64Array, readonly listener: Pt, readonly opt: SchedOptions) {
    this.S = pos.length / 3;
    const S = this.S;
    this.gain = new Float64Array(S).fill(1); this.lpLog = new Float64Array(S).fill(LP_OPEN_LOG2);
    this.tgtGain = new Float64Array(S).fill(1); this.tgtLp = new Float64Array(S).fill(LP_OPEN_LOG2);
    this.outGain = new Float32Array(S).fill(1); this.outLp = new Float32Array(S).fill(20000);
    this.stamp = new Int32Array(S).fill(-1); this.centerHit = new Uint8Array(S);
    this.top = new Int32Array(Math.max(1, opt.tier)); this.topScore = new Float64Array(Math.max(1, opt.tier));
  }

  /** One source's rays (R of them, each up to `chain` casts), updating the targets for that source. */
  castSource(i: number, frame: number, R = this.opt.R, layers = this.opt.layers, chain = 1): void {
    const L = this.listener, P = this.pos, mats = this.level.materialOf, o = this.o, d = this.d;
    const sx = P[i * 3], sy = P[i * 3 + 1], sz = P[i * 3 + 2];
    // Unit direction source -> listener; lateral = up x dir (normalised); vertical = dir x lateral.
    let dx = L.x - sx, dy = L.y - sy, dz = L.z - sz;
    const dist = Math.hypot(dx, dy, dz) || 1;
    dx /= dist; dy /= dist; dz /= dist;
    let lx = dz, lz = -dx; // (0,1,0) x (dx,dy,dz) = (dz, 0, -dx)
    const ll = Math.hypot(lx, lz) || 1; lx /= ll; lz /= ll;
    const vx = dy * lz, vy = dz * lx - dx * lz, vz = -dy * lx; // dir x lateral
    const pat = PATTERN[R];
    let gSum = 0, lpSum = 0, centerHit = 0;
    for (let k = 0; k < pat.length; k++) {
      const a = pat[k][0], b = pat[k][1];
      let ox = sx + lx * a + vx * b, oy = sy + vy * b, oz = sz + lz * a + vz * b;
      // Direction from the offset origin to the listener.
      let rx = L.x - ox, ry = L.y - oy, rz = L.z - oz;
      let rem = Math.hypot(rx, ry, rz) || 1;
      rx /= rem; ry /= rem; rz /= rem;
      rem -= 0.05;
      d.x = rx; d.y = ry; d.z = rz;
      let g = 1, lp = LP_OPEN_LOG2;
      for (let c = 0; c < chain && rem > 0.1; c++) {
        o.x = ox; o.y = oy; o.z = oz;
        const hit = Physics.raycast(o, d, rem, layers);
        this.rays++;
        if (!hit) break;
        const mat = mats.get(hit.collider) ?? 0;
        g *= GAIN_LIN[mat];
        if (LP_LOG2[mat] < lp) lp = LP_LOG2[mat];
        if (k === 0 && c === 0) centerHit = 1;
        const step = hit.distance + 0.02;
        ox += rx * step; oy += ry * step; oz += rz * step; rem -= step;
      }
      gSum += g; lpSum += lp;
    }
    this.tgtGain[i] = gSum / pat.length;
    this.tgtLp[i] = lpSum / pat.length;
    this.centerHit[i] = centerHit;
    this.stamp[i] = frame;
  }

  /** One frame: rank by audibility, tier recast, round-robin the rest, then smooth every source. Returns source-casts done. */
  frame(frame: number, dt: number): number {
    const { S, opt, pos, loud, listener: L } = this;
    // 1. Audibility (loudness over 1 + d^2) and a partial top-`tier` selection by insertion.
    let n = 0;
    const tier = opt.tier, top = this.top, ts = this.topScore;
    if (tier > 0) {
      for (let i = 0; i < S; i++) {
        const dx = pos[i * 3] - L.x, dy = pos[i * 3 + 1] - L.y, dz = pos[i * 3 + 2] - L.z;
        const a = loud[i] / (1 + dx * dx + dy * dy + dz * dz);
        if (n < tier) {
          let j = n++;
          while (j > 0 && ts[j - 1] < a) { ts[j] = ts[j - 1]; top[j] = top[j - 1]; j--; }
          ts[j] = a; top[j] = i;
        } else if (a > ts[n - 1]) {
          let j = n - 1;
          while (j > 0 && ts[j - 1] < a) { ts[j] = ts[j - 1]; top[j] = top[j - 1]; j--; }
          ts[j] = a; top[j] = i;
        }
      }
    }
    // 2. Casts under the budget.
    const t0 = now();
    let casts = 0;
    const byCount = opt.budgetCasts !== undefined;
    const tierCap = byCount ? Math.floor(opt.budgetCasts! * opt.tierShare) : Infinity;
    const tierMs = byCount ? 0 : opt.budgetMs! * opt.tierShare;
    for (let k = 0; k < n; k++) {
      if (byCount ? casts >= tierCap : casts > 0 && now() - t0 >= tierMs) break;
      this.castSource(top[k], frame);
      casts++;
    }
    if (opt.roundRobin) {
      let scanned = 0;
      while (scanned < S && (byCount ? casts < opt.budgetCasts! : casts === 0 || now() - t0 < opt.budgetMs!)) {
        const i = this.cursor; this.cursor = i + 1 === S ? 0 : i + 1; scanned++;
        if (this.stamp[i] === frame) continue;
        this.castSource(i, frame);
        casts++;
      }
    }
    // 3. Smooth every source toward its target (~tau), cutoff in the log domain, and write the per-voice values.
    smooth(this, 1 - Math.exp(-dt / opt.tau));
    return casts;
  }
}

/** The transmission model's per-frame part: one-pole smoothing of gain and log2 cutoff, then the per-voice outputs. */
export function smooth(o: { S: number; gain: Float64Array; lpLog: Float64Array; tgtGain: Float64Array; tgtLp: Float64Array; outGain: Float32Array; outLp: Float32Array }, a: number): void {
  const { S, gain, lpLog, tgtGain, tgtLp, outGain, outLp } = o;
  for (let i = 0; i < S; i++) {
    const g = gain[i] + a * (tgtGain[i] - gain[i]);
    const l = lpLog[i] + a * (tgtLp[i] - lpLog[i]);
    gain[i] = g; lpLog[i] = l;
    outGain[i] = g; outLp[i] = Math.pow(2, l);
  }
}

/** The transmission model's per-cast part, with hit materials already known (no rays): table lookups and aggregation. */
export function aggregateHits(level: Level, hits: object[], mats: Uint8Array, S: number, R: number, tgtGain: Float64Array, tgtLp: Float64Array): number {
  let sink = 0;
  const map = level.materialOf;
  for (let i = 0; i < S; i++) {
    let gSum = 0, lpSum = 0;
    for (let k = 0; k < R; k++) {
      const h = hits[(i * R + k) % hits.length];
      if (mats[i * R + k] === 255) { gSum += 1; lpSum += LP_OPEN_LOG2; continue; }
      const m = map.get(h) ?? 0;
      gSum += GAIN_LIN[m]; lpSum += LP_LOG2[m];
    }
    tgtGain[i] = gSum / R; tgtLp[i] = lpSum / R;
    sink += gSum;
  }
  return sink;
}

export { OCCLUDER };
