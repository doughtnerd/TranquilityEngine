// Linear-blend-skinning pose test: joints rotate about their bind-pose origin by a seeded random rotation.
import { rng } from './gen.mjs';
import { skinInverseBind } from './loaders.mjs';

function inv3(a) { // a: row-major 3x3 as 9 numbers -> inverse
  const [m00, m01, m02, m10, m11, m12, m20, m21, m22] = a;
  const c00 = m11 * m22 - m12 * m21, c01 = m12 * m20 - m10 * m22, c02 = m10 * m21 - m11 * m20;
  const det = m00 * c00 + m01 * c01 + m02 * c02 || 1;
  return [c00, m02 * m21 - m01 * m22, m01 * m12 - m02 * m11, c01, m00 * m22 - m02 * m20, m02 * m10 - m00 * m12, c02, m01 * m20 - m00 * m21, m00 * m11 - m01 * m10].map((x) => x / det);
}

/** Bind-pose joint origins (in mesh space) from the first skin's inverse bind matrices (glTF: column-major 4x4). */
export function jointOrigins(doc) {
  const ibm = skinInverseBind(doc); if (!ibm) return null;
  const n = ibm.length / 16; const out = new Float32Array(n * 3);
  for (let j = 0; j < n; j++) {
    const o = j * 16; // columns: c0=(0..3) c1=(4..7) c2=(8..11) c3=(12..15)
    const R = [ibm[o], ibm[o + 4], ibm[o + 8], ibm[o + 1], ibm[o + 5], ibm[o + 9], ibm[o + 2], ibm[o + 6], ibm[o + 10]];
    const Ri = inv3(R); const t = [ibm[o + 12], ibm[o + 13], ibm[o + 14]];
    for (let k = 0; k < 3; k++) out[j * 3 + k] = -(Ri[k * 3] * t[0] + Ri[k * 3 + 1] * t[1] + Ri[k * 3 + 2] * t[2]);
  }
  return out;
}

function randRot(r, maxDeg) {
  let ax = [r() * 2 - 1, r() * 2 - 1, r() * 2 - 1]; const l = Math.hypot(...ax) || 1; ax = ax.map((x) => x / l);
  const a = (r() * 2 - 1) * maxDeg * Math.PI / 180, c = Math.cos(a), s = Math.sin(a), C = 1 - c;
  return [c + ax[0] * ax[0] * C, ax[0] * ax[1] * C - ax[2] * s, ax[0] * ax[2] * C + ax[1] * s,
    ax[1] * ax[0] * C + ax[2] * s, c + ax[1] * ax[1] * C, ax[1] * ax[2] * C - ax[0] * s,
    ax[2] * ax[0] * C - ax[1] * s, ax[2] * ax[1] * C + ax[0] * s, c + ax[2] * ax[2] * C];
}

/** Returns a function pose(positions, joints, weights) -> Float32Array of skinned positions, for a seeded pose. */
export function makePose(origins, seed, maxDeg = 35) {
  const r = rng(seed); const nj = origins.length / 3; const rots = Array.from({ length: nj }, () => randRot(r, maxDeg));
  return (positions, joints, weights) => {
    const n = positions.length / 3; const out = new Float32Array(positions.length);
    for (let v = 0; v < n; v++) {
      const x = positions[v * 3], y = positions[v * 3 + 1], z = positions[v * 3 + 2];
      let ox = 0, oy = 0, oz = 0, ws = 0;
      for (let k = 0; k < 4; k++) {
        const w = weights[v * 4 + k]; if (w <= 0) continue; const j = joints[v * 4 + k]; if (j >= nj) continue;
        const R = rots[j], px = origins[j * 3], py = origins[j * 3 + 1], pz = origins[j * 3 + 2];
        const dx = x - px, dy = y - py, dz = z - pz;
        ox += w * (R[0] * dx + R[1] * dy + R[2] * dz + px); oy += w * (R[3] * dx + R[4] * dy + R[5] * dz + py); oz += w * (R[6] * dx + R[7] * dy + R[8] * dz + pz); ws += w;
      }
      if (ws === 0) { ox = x; oy = y; oz = z; ws = 1; }
      out[v * 3] = ox / ws; out[v * 3 + 1] = oy / ws; out[v * 3 + 2] = oz / ws;
    }
    return out;
  };
}
