// Main-thread audio bookkeeping per game frame: for L logical voices, compute distance attenuation and
// a cone gain from the listener, a priority score, pick the R highest (O(L) quickselect), and pack the
// R mixed voices' parameters (8 floats each) into one Float32Array for postMessage.
// Two layouts: struct-of-arrays (typed arrays) and an array of objects (one object per voice).

function rng(seed) { return () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296); }

/** Quickselect: partially order `idx[0..n)` so the k highest `score`s come first. */
function selectTop(idx, score, n, k) {
  let lo = 0, hi = n - 1;
  while (lo < hi) {
    const pivot = score[idx[(lo + hi) >> 1]];
    let i = lo, j = hi;
    while (i <= j) {
      while (score[idx[i]] > pivot) i++;
      while (score[idx[j]] < pivot) j--;
      if (i <= j) { const t = idx[i]; idx[i] = idx[j]; idx[j] = t; i++; j--; }
    }
    if (k - 1 <= j) hi = j; else if (k - 1 >= i) lo = i; else break;
  }
}

export function makeSoA(L) {
  const r = rng(1);
  const v = { L, px: new Float32Array(L), py: new Float32Array(L), pz: new Float32Array(L), vol: new Float32Array(L), minD: new Float32Array(L), maxD: new Float32Array(L),
    prio: new Float32Array(L), fx: new Float32Array(L), fz: new Float32Array(L), score: new Float32Array(L), gain: new Float32Array(L), pan: new Float32Array(L), idx: new Uint32Array(L) };
  for (let i = 0; i < L; i++) {
    v.px[i] = (r() - 0.5) * 400; v.py[i] = r() * 20; v.pz[i] = (r() - 0.5) * 400;
    v.vol[i] = 0.2 + r() * 0.8; v.minD[i] = 1 + r() * 4; v.maxD[i] = 50 + r() * 150; v.prio[i] = 1 + Math.floor(r() * 4);
    const a = r() * Math.PI * 2; v.fx[i] = Math.cos(a); v.fz[i] = Math.sin(a);
  }
  return v;
}

export function frameSoA(v, R, out, lx, lz) {
  const { L, px, py, pz, vol, minD, maxD, prio, fx, fz, score, gain, pan, idx } = v;
  for (let i = 0; i < L; i++) {
    const dx = px[i] - lx, dy = py[i], dz = pz[i] - lz;
    const d = Math.sqrt(dx * dx + dy * dy + dz * dz) + 1e-6;
    const att = d <= minD[i] ? 1 : d >= maxD[i] ? 0 : minD[i] / d; // inverse rolloff, cut at max
    const cosA = -(dx * fx[i] + dz * fz[i]) / d;                     // source facing the listener?
    const cone = 0.4 + 0.6 * Math.max(0, cosA);
    const g = vol[i] * att * cone;
    gain[i] = g;
    pan[i] = dx / d;
    score[i] = g * prio[i];
    idx[i] = i;
  }
  const k = Math.min(R, L);
  selectTop(idx, score, L, k);
  for (let j = 0; j < k; j++) {
    const i = idx[j], o = j * 8;
    out[o] = i; out[o + 1] = gain[i]; out[o + 2] = pan[i]; out[o + 3] = 1; // id, gain, pan, pitch
    out[o + 4] = px[i]; out[o + 5] = py[i]; out[o + 6] = pz[i]; out[o + 7] = 0; // position, filter
  }
  return k;
}

export function makeAoS(L) {
  const r = rng(1);
  const voices = [];
  for (let i = 0; i < L; i++) {
    const a = r() * Math.PI * 2;
    voices.push({ id: i, position: { x: (r() - 0.5) * 400, y: r() * 20, z: (r() - 0.5) * 400 }, volume: 0.2 + r() * 0.8, minDistance: 1 + r() * 4,
      maxDistance: 50 + r() * 150, priority: 1 + Math.floor(r() * 4), forward: { x: Math.cos(a), z: Math.sin(a) }, score: 0, gain: 0, pan: 0 });
  }
  return voices;
}

export function frameAoS(voices, R, out, lx, lz) {
  for (const v of voices) {
    const dx = v.position.x - lx, dy = v.position.y, dz = v.position.z - lz;
    const d = Math.hypot(dx, dy, dz) + 1e-6;
    const att = d <= v.minDistance ? 1 : d >= v.maxDistance ? 0 : v.minDistance / d;
    const cone = 0.4 + 0.6 * Math.max(0, -(dx * v.forward.x + dz * v.forward.z) / d);
    v.gain = v.volume * att * cone;
    v.pan = dx / d;
    v.score = v.gain * v.priority;
  }
  // The "obvious" version: copy, sort, slice.
  const top = voices.slice().sort((a, b) => b.score - a.score).slice(0, R);
  top.forEach((v, j) => { const o = j * 8; out[o] = v.id; out[o + 1] = v.gain; out[o + 2] = v.pan; out[o + 3] = 1; out[o + 4] = v.position.x; out[o + 5] = v.position.y; out[o + 6] = v.position.z; out[o + 7] = 0; });
  return top.length;
}

export function runAll(now) {
  const rows = [];
  for (const [L, R] of [[1024, 128], [4096, 256], [8192, 256]]) {
    for (const layout of ["typed arrays + quickselect", "objects + sort"]) {
      const state = layout.startsWith("typed") ? makeSoA(L) : makeAoS(L);
      const frame = layout.startsWith("typed") ? frameSoA : frameAoS;
      const times = [];
      for (let f = 0; f < 700; f++) {
        const out = new Float32Array(R * 8); // a fresh transferable buffer each frame, as postMessage needs
        const t = now();
        frame(state, R, out, Math.sin(f * 0.01) * 50, Math.cos(f * 0.01) * 50);
        if (f >= 100) times.push(now() - t);
      }
      times.sort((a, b) => a - b);
      const p = (q) => +times[Math.floor(times.length * q)].toFixed(3);
      rows.push({ logical: L, mixed: R, layout, p50: p(0.5), p95: p(0.95), p99: p(0.99), max: +times[times.length - 1].toFixed(3) });
    }
  }
  return rows;
}
