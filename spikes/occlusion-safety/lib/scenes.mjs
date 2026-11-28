// The adversarial scenes: occluders (real geometry), occludees (small boxes placed around the silhouettes), camera paths.
import { MeshBuilder, building, wallSlab, terrain, rng } from './geom.mjs';

export const FRAMES = 30;
const lerp = (a, b, t) => a + (b - a) * t;
const lerp3 = (a, b, t) => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];

function path(name, f) { const frames = []; for (let i = 0; i < FRAMES; i++) { const t = i / (FRAMES - 1); const [eye, target] = f(t, i); frames.push({ eye, target }); } return { name, frames }; }

/** Collects occludee boxes: a candidate is kept when it does not touch a solid (with a margin) and `ok` accepts it. */
class Occludees {
  constructor(solids, seed, ok = () => true) { this.solids = solids; this.r = rng(seed); this.boxes = []; this.ok = ok; }
  free(mn, mx, m = 0.06) {
    for (const s of this.solids) if (mn[0] < s[3] + m && mx[0] > s[0] - m && mn[1] < s[4] + m && mx[1] > s[1] - m && mn[2] < s[5] + m && mx[2] > s[2] - m) return false;
    return true;
  }
  /** n boxes with centre in [lo,hi] (y is the box BOTTOM height range), half extents in [hmin,hmax]. */
  scatter(n, lo, hi, hmin, hmax, ground = null) {
    let tries = 0, added = 0;
    while (added < n && tries++ < n * 60) {
      const r = this.r;
      const h = [lerp(hmin, hmax, r()), lerp(hmin, hmax, r()), lerp(hmin, hmax, r())];
      const c = [lerp(lo[0], hi[0], r()), 0, lerp(lo[2], hi[2], r())];
      let bottom = lerp(lo[1], hi[1], r());
      if (ground) bottom = Math.max(ground(c[0] - h[0], c[2] - h[2]), ground(c[0] + h[0], c[2] - h[2]), ground(c[0] - h[0], c[2] + h[2]), ground(c[0] + h[0], c[2] + h[2]), ground(c[0], c[2])) + 0.03 + bottom;
      const mn = [c[0] - h[0], bottom, c[2] - h[2]], mx = [c[0] + h[0], bottom + 2 * h[1], c[2] + h[2]];
      if (mn[1] < 0 && !ground) continue;
      if (!this.free(mn, mx) || !this.ok(mn, mx)) continue;
      this.boxes.push([...mn, ...mx]); added++;
    }
  }
}

function pack(builder) { const m = builder.finish(); return m; }

export function buildScenes() {
  return [bldgScene(), wallsScene(), hillScene(), besideScene()];
}

// ---------------------------------------------------------------------------------------------------------- bldg
function bldgScene() {
  const specs = [
    { cx: -20, cz: 0, W: 14, D: 8, H: 9, doors: [{ face: 'front', u: 4, w: 1.1, h: 2.2 }, { face: 'left', u: 3.8, w: 1.0, h: 2.1 }] },
    { cx: 0, cz: 0, W: 14, D: 8, H: 12, doors: [{ face: 'front', u: 7, w: 1.1, h: 2.2 }] },
    { cx: 20, cz: 0, W: 14, D: 8, H: 7, doors: [{ face: 'front', u: 10, w: 1.1, h: 2.2 }, { face: 'back', u: 4, w: 1.1, h: 2.2 }] },
  ];
  const occluders = [];
  const bounds = [];
  specs.forEach((s, i) => { const mb = new MeshBuilder(); bounds.push(building(mb, s)); occluders.push({ name: `building-${i}`, kind: 'building', ...pack(mb) }); });
  const solids = occluders.flatMap((o) => o.solids);
  const oc = new Occludees(solids, 0xb1d);
  specs.forEach((s, i) => {
    const b = bounds[i];
    oc.scatter(160, [b.xmin + b.T + 0.3, 0.0, b.zmin + b.T + 0.3], [b.xmax - b.T - 0.3, 3.0, b.zmax - b.T - 0.3], 0.1, 0.45);
    // in line with the front door: a column of boxes straight behind the doorway
    const dx = s.cx - s.W / 2 + s.doors[0].u;
    oc.scatter(40, [dx - 0.9, 0.0, b.zmin + b.T + 0.3], [dx + 0.9, 1.6, b.zmax - b.T - 0.3], 0.08, 0.3);
  });
  oc.scatter(700, [-45, 0, -26], [45, 1.5, -4.8], 0.12, 0.8); // street side
  oc.scatter(600, [-45, 0, 4.8], [45, 1.5, 26], 0.12, 0.8); // behind the row
  oc.scatter(300, [-13, 0, -5], [13, 1.5, 5], 0.1, 0.6); // gaps between buildings
  oc.scatter(150, [27, 0, -8], [42, 1.5, 8], 0.1, 0.6); oc.scatter(150, [-42, 0, -8], [-27, 1.5, 8], 0.1, 0.6); // beyond the ends
  oc.scatter(250, [-30, 7, -8], [30, 11, 22], 0.1, 0.6); // above the lower roofs / behind the taller one
  const doorX = (i) => specs[i].cx - specs[i].W / 2 + specs[i].doors[0].u;
  const paths = [
    path('street', (t) => { const x = lerp(-34, 34, t); return [[x, 1.7, -9], [x + 7, 2, 4]]; }),
    path('door', (t) => { const x = doorX(1) + 0.25 * Math.sin(t * 6); return [[x, 1.7, lerp(-16, -4.7, t)], [doorX(1), 1.3, 4]]; }),
    path('door-oblique', (t) => { const x = lerp(-9, doorX(1) - 0.4, t); return [[x, 1.7, lerp(-14, -4.7, t)], [doorX(1) + 2, 1.3, 4]]; }),
    path('low', (t) => { const x = lerp(-34, 34, t); return [[x, 0.4, -8], [x + 6, 0.8, 4]]; }),
    path('high', (t) => { const x = lerp(-30, 30, t); return [[x, 14, -22], [x + 4, 0, 4]]; }),
    path('far', (t) => { const x = lerp(-30, 30, t); return [[x, 1.7, -75], [x * 0.5, 3, 5]]; }),
  ];
  return { name: 'bldg', occluders, occludees: oc.boxes, paths };
}

// ---------------------------------------------------------------------------------------------------------- walls
function wallsScene() {
  const mkWall = (parts) => { const mb = new MeshBuilder(); for (const p of parts) wallSlab(mb, p); return pack(mb); };
  const thin = { name: 'thin-wall', kind: 'wall', ...mkWall([{ o: [-5, 0, 0], u: [1, 0, 0], n: [0, 0, -1], L: 10, H: 3, T: 0.2, sub: 0.5 }]) };
  const lwall = { name: 'L-wall', kind: 'wall', ...mkWall([
    { o: [20, 0, 0], u: [1, 0, 0], n: [0, 0, -1], L: 8, H: 3, T: 0.2, sub: 0.5 },
    { o: [28, 0, 0.2], u: [0, 0, 1], n: [1, 0, 0], L: 6, H: 3, T: 0.2, sub: 0.5 },
  ]) };
  const low = { name: 'low-wall', kind: 'wall', ...mkWall([{ o: [-40, 0, 0], u: [1, 0, 0], n: [0, 0, -1], L: 8, H: 0.9, T: 0.3, sub: 0.2 }]) };
  const occluders = [thin, lwall, low];
  const solids = occluders.flatMap((o) => o.solids);
  const oc = new Occludees(solids, 0x7a11);
  oc.scatter(500, [-12, 0, 0.5], [12, 2.5, 14], 0.1, 0.5); // behind the thin wall, spilling past both ends
  oc.scatter(150, [-6, 0, -3], [6, 0, -0.3], 0.05, 0.3); // in front (always visible): control
  oc.scatter(400, [17, 0, -3], [31, 2.5, 9], 0.1, 0.5); // around and inside the L
  oc.scatter(500, [-44, 0, 0.6], [-28, 1.8, 12], 0.1, 0.6); // behind the low wall (tops peek over)
  oc.scatter(100, [-44, 0, -4], [-28, 0.7, -0.4], 0.05, 0.3);
  const paths = [
    path('thin-orbit', (t) => { const a = lerp(-1.2, 1.2, t); return [[14 * Math.sin(a), 1.7, -14 * Math.cos(a) + 0.1], [0, 1.2, 4]]; }),
    path('thin-graze', (t) => { const x = lerp(-22, -9, t); return [[x, 1.7, -1.5], [x + 20, 1.5, 0.1]]; }),
    path('thin-high', (t) => { const x = lerp(-8, 8, t); return [[x, 9, -12], [x * 0.5, 0, 6]]; }),
    path('thin-low', (t) => { const x = lerp(-10, 10, t); return [[x, 0.4, -9], [0, 0.8, 6]]; }),
    path('L-orbit', (t) => { const a = lerp(-0.6, 2.0, t); return [[28 + 12 * Math.sin(a), 1.7, 3 - 12 * Math.cos(a)], [24, 1.2, 3]]; }),
    path('L-inside', (t) => { const x = lerp(22, 26, t); return [[x, 1.7, lerp(-6, 4, t)], [28, 1.2, 12]]; }),
    path('low-over', (t) => { const x = lerp(-42, -30, t); return [[x, 1.7, -6], [x + 3, 1.0, 10]]; }),
    path('thin-far', (t) => { const x = lerp(-12, 12, t); return [[x, 1.7, -60], [0, 1.2, 4]]; }),
    path('low-crouch', (t) => { const x = lerp(-42, -30, t); return [[x, 0.5, -3], [x + 3, 0.7, 10]]; }),
  ];
  return { name: 'walls', occluders, occludees: oc.boxes, paths };
}

// ---------------------------------------------------------------------------------------------------------- hill
export const hillHeight = (x, z) => 3.0 * Math.sin(x * 0.09 + 0.6) * Math.cos(z * 0.07) + 5.0 * Math.exp(-((z - 30) * (z - 30)) / 150) + 0.9 * Math.sin(x * 0.31 + z * 0.23);
function hillScene() {
  const mb = new MeshBuilder();
  terrain(mb, { x0: -40, z0: -10, nx: 80, nz: 80, cell: 1, height: hillHeight });
  const occ = { name: 'terrain', kind: 'terrain', ...pack(mb) };
  const oc = new Occludees([], 0x4111);
  oc.scatter(700, [-38, 0, 32], [38, 0.3, 66], 0.1, 0.5, hillHeight); // behind the ridge, boxes sit on the ground
  oc.scatter(500, [-38, 0, 8], [38, 0.3, 29], 0.1, 0.5, hillHeight); // up the near slope
  oc.scatter(300, [-38, 0, 33], [38, 1.5, 66], 0.1, 0.5, hillHeight);
  const g = (x, z, h) => hillHeight(x, z) + h;
  const paths = [
    path('walk-up', (t) => { const z = lerp(-5, 22, t), x = 3 * Math.sin(t * 5); return [[x, g(x, z, 1.7), z], [x + 6, g(x, z + 40, 0), z + 40]]; }),
    path('low', (t) => { const z = lerp(-5, 22, t), x = -8 + 6 * Math.sin(t * 4); return [[x, g(x, z, 0.4), z], [x + 4, g(x, z + 40, 0.5), z + 40]]; }),
    path('high', (t) => { const x = lerp(-20, 20, t); return [[x, g(x, -8, 14), -8], [x, g(x, 40, 0), 40]]; }),
    path('crest', (t) => { const z = lerp(18, 31, t); return [[0, g(0, z, 1.7), z], [4, g(4, z + 30, 0), z + 30]]; }),
  ];
  return { name: 'hill', occluders: [occ], occludees: oc.boxes, paths };
}

// ---------------------------------------------------------------------------------------------------------- beside
function besideScene() {
  const mb = new MeshBuilder();
  const b = building(mb, { cx: 0, cz: 0, W: 14, D: 8, H: 8, doors: [{ face: 'front', u: 4.5, w: 1.1, h: 2.2 }, { face: 'right', u: 3.6, w: 1.0, h: 2.1 }] });
  const occ = { name: 'building', kind: 'building', ...pack(mb) };
  const doorX = -7 + 4.5;
  const oc = new Occludees(occ.solids, 0xbe51);
  oc.scatter(260, [b.xmin + b.T + 0.3, 0, b.zmin + b.T + 0.3], [b.xmax - b.T - 0.3, 3.0, b.zmax - b.T - 0.3], 0.1, 0.45);
  oc.scatter(40, [doorX - 0.8, 0, b.zmin + b.T + 0.3], [doorX + 0.8, 1.6, b.zmax - b.T - 0.3], 0.08, 0.3);
  oc.scatter(500, [-20, 0, -20], [20, 1.5, -4.6], 0.1, 0.7);
  oc.scatter(400, [-20, 0, 4.6], [20, 1.5, 20], 0.1, 0.7);
  oc.scatter(200, [7.6, 0, -4.6], [20, 1.5, 4.6], 0.1, 0.7);
  oc.scatter(200, [-20, 0, -4.6], [-7.6, 1.5, 4.6], 0.1, 0.7);
  oc.scatter(150, [-0.2 - 7.4, 0, -4.6], [7.4, 0.4, -4.05], 0.03, 0.15); // hugging the facade
  const paths = [
    path('beside-graze', (t) => { const x = lerp(-12, 12, t); return [[x, 1.7, -4.3], [x + 10, 1.7, -7.5]]; }),
    path('beside-into', (t) => { const x = lerp(-10, 6, t); return [[x, 1.7, -4.5], [x + 7, 1.7, 1.5]]; }),
    path('beside-close', (t) => { const x = lerp(-9, 9, t); return [[x, 1.7, -4.12], [x + 5, 1.5, -8]]; }),
    path('threshold-in', (t) => [[doorX + 0.2 * Math.sin(t * 5), 1.7, lerp(-6.5, 0.5, t)], [doorX, 1.4, 4]]),
    path('threshold-out', (t) => [[doorX + 0.2 * Math.sin(t * 5), 1.7, lerp(0.5, -6.5, t)], [doorX + 1, 1.4, -14]]),
    path('inside-sweep', (t) => { const a = t * 2 * Math.PI; return [[-1.5, 1.7, 0.5], [-1.5 + 10 * Math.cos(a), 1.5, 0.5 + 10 * Math.sin(a)]]; }),
    path('inside-low', (t) => { const a = t * 2 * Math.PI; return [[2, 0.4, -0.8], [2 + 10 * Math.cos(a), 0.6, -0.8 + 10 * Math.sin(a)]]; }),
  ];
  return { name: 'beside', occluders: [occ], occludees: oc.boxes, paths };
}
