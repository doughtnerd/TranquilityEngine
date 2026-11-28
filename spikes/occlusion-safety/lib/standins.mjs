// Stand-in generation (meshoptimizer 1.3.0) and the import-time error measurement ADR 0447 §3 asks for.
import { MeshoptSimplifier as S } from 'meshoptimizer';
import { Bvh, sampleSurface, oneSided } from '../../lod-simplify/lib/metrics.mjs';
import { bboxOf } from '../../lod-simplify/lib/mesh.mjs';

export const TYPES = ['orig', 'simp12', 'simp5', 'sloppy5'];
export const EXEMPT_TRIS = 512; // 0447: a mesh with at most 512 triangles occludes with itself

export async function ready() { await S.ready; if (!S.supported) throw new Error('meshoptimizer simplifier unsupported'); }

const now = () => Number(process.hrtime.bigint()) / 1e6;

function simplify(positions, indices, ratioOfOrig, nOrig) {
  const target = Math.max(3, Math.round(nOrig * ratioOfOrig)) * 3;
  const [out] = S.simplify(indices, positions, 3, target, 1.0, ['Permissive']);
  return out;
}

/** Two-way Hausdorff over samples, as ADR 0446 §1 specifies: the max of the two one-sided maxima, in world units. */
function measure(O, bvhO, Sm, nSamples) {
  const t0 = now();
  const bvhS = new Bvh(Sm.positions, Sm.indices);
  const f = oneSided(Sm, bvhO, nSamples, nSamples);
  const r = oneSided(O, bvhS, nSamples, nSamples);
  return { fwd: f.max, rev: r.max, err: Math.max(f.max, r.max), ms: now() - t0 };
}

/**
 * Per-triangle forward error (stand-in -> original): max over a lattice of each triangle whose spacing is `spacing` world units
 * (so a hole wider than ~2x the spacing cannot hide between samples), at least 5 divisions, at most 400 per edge.
 */
function triErrors(Sm, bvhO, spacing) {
  const nt = Sm.indices.length / 3; const out = new Float32Array(nt); const P = Sm.positions, I = Sm.indices; let samples = 0;
  for (let t = 0; t < nt; t++) {
    const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3; let m = 0;
    const edge = Math.max(Math.hypot(P[b] - P[a], P[b + 1] - P[a + 1], P[b + 2] - P[a + 2]), Math.hypot(P[c] - P[a], P[c + 1] - P[a + 1], P[c + 2] - P[a + 2]), Math.hypot(P[c] - P[b], P[c + 1] - P[b + 1], P[c + 2] - P[b + 2]));
    const n = Math.min(400, Math.max(5, Math.ceil(edge / spacing)));
    for (let i = 0; i <= n; i++) for (let j = 0; j <= n - i; j++) {
      const u = i / n, v = j / n, w = 1 - u - v; samples++;
      const d = Math.sqrt(bvhO.query(P[a] * w + P[b] * u + P[c] * v, P[a + 1] * w + P[b + 1] * u + P[c + 1] * v, P[a + 2] * w + P[b + 2] * u + P[c + 2] * v));
      if (d > m) m = d;
    }
    out[t] = m;
  }
  return { errs: out, samples };
}

export function makeStandins(occ, nSamples = 15000) {
  const O = { positions: occ.positions, indices: occ.indices };
  const nOrig = O.indices.length / 3;
  const diag = bboxOf(O.positions, O.indices).diag;
  const bvhO = new Bvh(O.positions, O.indices);
  const tSimp = now();
  const l12 = simplify(O.positions, O.indices, 0.125, nOrig);
  const l5 = simplify(O.positions, l12, 0.05, nOrig);
  const [sl] = S.simplifySloppy(O.indices, O.positions, 3, null, Math.max(3, Math.round(nOrig * 0.05)) * 3, 1.0);
  const simpMs = now() - tSimp;
  const sets = { orig: O.indices, simp12: l12, simp5: l5, sloppy5: sl };
  const res = { diag, nOrig, exempt: nOrig <= EXEMPT_TRIS, simplifyMs: simpMs, types: {} };
  for (const k of TYPES) {
    const Sm = { positions: O.positions, indices: sets[k] };
    const nt = Sm.indices.length / 3;
    if (k === 'orig') { res.types[k] = { indices: Sm.indices, tris: nt, err: 0, errFrac: 0, fwdFrac: 0, revFrac: 0, hausMs: 0, triErr: new Float32Array(nt), triErrMs: 0 }; continue; }
    const m = measure(O, bvhO, Sm, nSamples);
    const t0 = now(); const te = triErrors(Sm, bvhO, diag * 0.005); const triErrMs = now() - t0;
    const dense = measure(O, bvhO, Sm, 100000);
    res.types[k] = { indices: Sm.indices, tris: nt, err: m.err, errFrac: m.err / diag, fwdFrac: m.fwd / diag, revFrac: m.rev / diag, hausMs: m.ms, triErr: te.errs, triErrMs, triSamples: te.samples, denseFrac: dense.err / diag, denseMs: dense.ms };
  }
  return res;
}
