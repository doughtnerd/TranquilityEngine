// Shared by Node and the browser page: takes an initialised RAPIER module, returns result rows.
function rng(seed) { let s = seed >>> 0; return () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296); }
function normQ(a) { return { x: 0, y: Math.sin(a / 2), z: 0, w: Math.cos(a / 2) }; }

function addBoxes(R, world, n, extent, rand) {
  for (let i = 0; i < n; i++) {
    const hx = 0.5 + rand() * 2.5, hy = 1 + rand() * 3, hz = 0.5 + rand() * 2.5;
    world.createCollider(R.ColliderDesc.cuboid(hx, hy, hz).setTranslation((rand() - 0.5) * extent, hy, (rand() - 0.5) * extent));
  }
}
function grid(nx, nz, f) { // regular grid mesh
  const v = new Float32Array(nx * nz * 3), idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
  for (let z = 0, k = 0; z < nz; z++) for (let x = 0; x < nx; x++) { const p = f(x, z); v[k++] = p[0]; v[k++] = p[1]; v[k++] = p[2]; }
  for (let z = 0, k = 0; z < nz - 1; z++) for (let x = 0; x < nx - 1; x++) {
    const a = z * nx + x, b = a + 1, c = a + nx, d = c + 1;
    idx.set([a, c, b, b, c, d], k); k += 6;
  }
  return { v, idx, tris: idx.length / 3 };
}
function addTrimeshes(R, world, rand) { // 2 bumpy terrain tiles + 8 wall meshes, ~98k triangles
  let tris = 0;
  const N = 135, size = 150;
  for (let t = 0; t < 2; t++) {
    const ph = rand() * 10, m = grid(N, N, (x, z) => {
      const wx = (x / (N - 1) - 0.5) * size, wz = (z / (N - 1) - 0.5) * size;
      return [wx, Math.sin(wx * 0.15 + ph) * 2 + Math.cos(wz * 0.11) * 2 + Math.sin(wx * 0.9) * Math.cos(wz * 0.8) * 0.3, wz];
    });
    world.createCollider(R.ColliderDesc.trimesh(m.v, m.idx).setTranslation((t - 0.5) * size, 0, 0)); tris += m.tris;
  }
  for (let w = 0; w < 8; w++) {
    const m = grid(50, 35, (x, y) => [x * 1.2 - 30, y * 0.3, Math.sin(x * 0.3) * 0.2]);
    world.createCollider(R.ColliderDesc.trimesh(m.v, m.idx).setTranslation((rand() - 0.5) * 120, 0, (rand() - 0.5) * 120).setRotation(normQ(rand() * 6.28))); tris += m.tris;
  }
  return tris;
}

export function buildScene(R, kind) {
  const world = new R.World({ x: 0, y: 0, z: 0 }), rand = rng(1234);
  let tris = 0, boxes = 0;
  if (kind === "boxes200") { addBoxes(R, world, 200, 100, rand); boxes = 200; }
  if (kind === "boxes2000") { addBoxes(R, world, 2000, 300, rand); boxes = 2000; }
  if (kind === "trimesh100k") tris = addTrimeshes(R, world, rand);
  if (kind === "mixed") { addBoxes(R, world, 2000, 300, rand); boxes = 2000; tris = addTrimeshes(R, world, rand); }
  const dyn = [];
  for (let i = 0; i < 50; i++) {
    const b = world.createRigidBody(R.RigidBodyDesc.dynamic().setTranslation((rand() - 0.5) * 80, 5 + rand() * 3, (rand() - 0.5) * 80).setGravityScale(0));
    world.createCollider(R.ColliderDesc.ball(0.5), b); dyn.push(b);
  }
  world.step(); // build BVH
  return { world, dyn, boxes, tris, kind };
}

function makeSources(rand, n) {
  const s = [];
  for (let i = 0; i < n; i++) { const a = rand() * 6.283, d = 5 + rand() * 60; s.push([Math.cos(a) * d, 1 + rand() * 6, Math.sin(a) * d]); }
  return s;
}
const stats = (a) => { const s = [...a].sort((x, y) => x - y); return { p50: s[s.length >> 1], p95: s[Math.floor(s.length * 0.95)] }; };

// method: "castRay" | "all" (intersectionsWithRay); rays: rays per source; reuse: mutate one Ray vs new Ray per query
function frameFn(RAPIER, world, sources, rays, method, reuse) {
  const ray = new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
  let hits = 0;
  const cb = () => { hits++; return true; };
  const offs = [[0, 0, 0], [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0]];
  return (frame) => {
    const lx = Math.sin(frame * 0.05) * 3, ly = 1.7, lz = Math.cos(frame * 0.05) * 3;
    for (let i = 0; i < sources.length; i++) {
      for (let r = 0; r < rays; r++) {
        const o = offs[r], dx = sources[i][0] + o[0] - lx, dy = sources[i][1] + o[1] - ly, dz = sources[i][2] + o[2] - lz;
        const len = Math.hypot(dx, dy, dz), inv = 1 / len;
        const rr = reuse ? ray : new RAPIER.Ray({ x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: 1 });
        rr.origin.x = lx; rr.origin.y = ly; rr.origin.z = lz; rr.dir.x = dx * inv; rr.dir.y = dy * inv; rr.dir.z = dz * inv;
        if (method === "castRay") { if (world.castRay(rr, len, true)) hits++; }
        else world.intersectionsWithRay(rr, len, true, cb);
      }
    }
    return hits;
  };
}

export function runAll(RAPIER, now, log = () => {}) {
  const rows = [], upd = [], info = {};
  for (const kind of ["boxes200", "boxes2000", "trimesh100k", "mixed"]) {
    const sc = buildScene(RAPIER, kind);
    info[kind] = { boxes: sc.boxes, tris: sc.tris };
    const rand = rng(99);
    for (const S of [32, 64, 128, 256]) {
      const sources = makeSources(rand, S);
      for (const R of [1, 5]) for (const method of ["castRay", "all"]) {
        const f = frameFn(RAPIER, sc.world, sources, R, method, true);
        const frames = Math.max(30, Math.min(200, Math.floor(40000 / (S * R))));
        for (let i = 0; i < 20; i++) f(i);
        const t = [];
        for (let i = 0; i < frames; i++) { const a = now(); f(i); t.push(now() - a); }
        const st = stats(t);
        rows.push({ scene: kind, S, R, method, p50: st.p50, p95: st.p95, usPerRay: (st.p50 * 1000) / (S * R) });
      }
    }
    { // new Ray per query vs reused, S=64 R=1
      const sources = makeSources(rng(5), 64), out = {};
      for (const reuse of [true, false]) {
        const f = frameFn(RAPIER, sc.world, sources, 1, "castRay", reuse), t = [];
        for (let i = 0; i < 20; i++) f(i);
        for (let i = 0; i < 100; i++) { const a = now(); f(i); t.push(now() - a); }
        out[reuse ? "reuse" : "alloc"] = stats(t).p50;
      }
      rows.push({ scene: kind, alloc: out });
    }
    // query-structure update: move 50 dynamic bodies, then step (the BVH refreshes inside step)
    const measure = (move) => {
      const t = [];
      for (let f = 0; f < 60; f++) {
        const a = now();
        if (move) for (let i = 0; i < sc.dyn.length; i++) { const p = sc.dyn[i].translation(); sc.dyn[i].setTranslation({ x: p.x + 0.05, y: p.y, z: p.z }, true); }
        sc.world.step();
        t.push(now() - a);
      }
      return stats(t);
    };
    measure(true);
    const idle = measure(false), moved = measure(true);
    // staleness: does castRay see a body moved but not stepped?
    const b = sc.dyn[0]; b.setTranslation({ x: 500, y: 50, z: 500 }, true); sc.world.step();
    const probe = new RAPIER.Ray({ x: 500, y: 50, z: 450 }, { x: 0, y: 0, z: 1 });
    const before = !!sc.world.castRay(probe, 30, true);
    b.setTranslation({ x: 500, y: 50, z: 450 + 20 }, true);
    const unstepped = !!sc.world.castRay(probe, 30, true);
    sc.world.step();
    const stepped = !!sc.world.castRay(probe, 30, true);
    upd.push({ scene: kind, idleStep: idle, movedStep: moved, seesMoveBeforeStep: unstepped, seesMoveAfterStep: stepped, before });
    sc.world.free();
    log(kind);
  }
  return { rows, upd, info };
}
