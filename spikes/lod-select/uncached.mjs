// LOD selection cost per view in plain JS: world sphere from a 4x4 matrix + local centre/radius, frustum test, screen height, level pick.
const N = +process.argv[2] || 10000;
const m = new Float32Array(N * 16), c = new Float32Array(N * 4), out = new Uint8Array(N);
let s = 1; const r = () => (s = (s * 1664525 + 1013904223) >>> 0) / 4294967296;
for (let i = 0; i < N; i++) { m.set([1,0,0,0, 0,1,0,0, 0,0,1,0, r()*400-200, 0, r()*400-200, 1], i*16); c.set([0,1,0,1.5], i*4); }
const heights = new Float32Array([0.15, 0.09, 0.056, 0.01]);
const planes = new Float32Array(24); // a 60° frustum looking down -z from origin
const fy = Math.tan(Math.PI/6), proj = 1 / (2 * fy);
[[0,0,-1,-0.1],[0,0,1,1000],[Math.cos(0.52),0,-Math.sin(0.52),0],[-Math.cos(0.52),0,-Math.sin(0.52),0],[0,Math.cos(0.52),-Math.sin(0.52),0],[0,-Math.cos(0.52),-Math.sin(0.52),0]].forEach((p,i)=>planes.set(p,i*4));
function select(cx, cy, cz, bias) {
  for (let i = 0; i < N; i++) {
    const o = i * 16, k = i * 4;
    const lx = c[k], ly = c[k+1], lz = c[k+2];
    const x = m[o]*lx + m[o+4]*ly + m[o+8]*lz + m[o+12], y = m[o+1]*lx + m[o+5]*ly + m[o+9]*lz + m[o+13], z = m[o+2]*lx + m[o+6]*ly + m[o+10]*lz + m[o+14];
    const sc = Math.max(Math.hypot(m[o], m[o+1], m[o+2]), Math.hypot(m[o+4], m[o+5], m[o+6]), Math.hypot(m[o+8], m[o+9], m[o+10]));
    const rad = c[k+3] * sc;
    let vis = true;
    for (let p = 0; p < 24; p += 4) if (planes[p]*x + planes[p+1]*y + planes[p+2]*z + planes[p+3] < -rad) { vis = false; break; }
    if (!vis) { out[i] = 255; continue; }
    const d = Math.hypot(x - cx, y - cy, z - cz);
    const h = (2 * rad * proj / Math.max(d, 1e-3)) * bias;
    let lvl = 255;
    for (let l = 0; l < 4; l++) if (h >= heights[l]) { lvl = l; break; }
    out[i] = lvl;
  }
}
for (let w = 0; w < 200; w++) select(0, 1.7, 0, 1);
const t = [];
for (let run = 0; run < 7; run++) { const a = performance.now(); for (let f = 0; f < 100; f++) select(f * 0.1, 1.7, 0, 1); t.push((performance.now() - a) / 100); }
t.sort((a, b) => a - b);
console.log(`N=${N} ms/view p50=${t[3].toFixed(3)} max=${t[6].toFixed(3)}`);
