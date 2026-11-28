// Shared bench harness: runs the job protocol (same as crates/occ-bench) over the wasm module. Imported by
// node-runner.mjs (Node) and page.html (headless Chromium), so both environments execute identical code.
// Timing uses performance.now(); in Chromium the page must be cross-origin isolated (5 us resolution, see run.mjs).

const ACC_FRAMES = [0, 30, 60, 90, 120, 150, 180, 210];
const STAT_NAMES = ["inst_total", "inst_frustum", "inst_selected", "tris_src", "tris_frustum", "tris_back", "tris_clipped", "tris_raster", "occ_total", "occ_outside", "occ_near", "occ_culled", "occ_visible"];
const now = () => performance.now();

export function pct(v) {
  const a = Float64Array.from(v).sort();
  const n = a.length;
  const at = (p) => a[Math.min(n - 1, Math.max(1, Math.ceil(p * n)) - 1)];
  return { p50: at(0.5), p99: at(0.99), max: a[n - 1], n };
}

const pathFrame = (run, i) => (i * 3 + run * 17) % 240;

export async function instantiate(bytes) {
  const { instance } = await WebAssembly.instantiate(bytes, {});
  return instance.exports;
}

class Runner {
  constructor(x) {
    this.x = x;
    this.scene = -1;
  }
  setScene(scene, w, h) {
    this.x.init(scene, w, h);
    this.scene = scene;
  }
  u32(ptr, n) {
    return new Uint32Array(this.x.memory.buffer, ptr, n);
  }
  cfg(j, dilate) {
    this.x.set_config(j.cap, j.minArea, dilate, j.simd, 1, 1e-3, j.inner);
  }
  stats() {
    return Array.from(this.u32(this.x.stats_ptr(), this.x.n_stats()));
  }
  accRow() {
    return Array.from(this.u32(this.x.acc_ptr(), 8));
  }
}

const accJson = (a) => ({ in_frustum: a[0], oracle_culled: a[1], buf_culled: a[2], lost: a[3], false_occluded: a[4] });

function accuracy(r, j, slot, camKind) {
  const x = r.x;
  const acc = [new Array(8).fill(0), new Array(8).fill(0)];
  const stats = new Array(16).fill(0);
  let hash = 0;
  for (const f of ACC_FRAMES) {
    x.set_cam(slot, camKind, f);
    for (let di = 0; di < 2; di++) {
      r.cfg(j, di);
      x.frame(slot);
      if (di === 1) {
        const s = r.stats();
        for (let k = 0; k < 16; k++) stats[k] += s[k] / ACC_FRAMES.length;
        hash = (((hash << 5) | (hash >>> 27)) ^ x.vis_hash(slot)) >>> 0;
      }
      x.oracle(slot, slot === 0 ? f : -1);
      x.compare(slot);
      const a = r.accRow();
      for (let k = 0; k < 8; k++) acc[di][k] += a[k];
    }
  }
  const st = {};
  STAT_NAMES.forEach((n, i) => (st[n] = Math.round(stats[i] * 10) / 10));
  return { acc: { d0: accJson(acc[0]), d1: accJson(acc[1]) }, stats: st, hash };
}

function mainJob(r, j) {
  const x = r.x;
  x.set_res(j.w, j.h);
  r.cfg(j, j.dilate);
  for (let i = 0; i < 10; i++) {
    x.set_cam(0, 0, i);
    x.frame(0);
  }
  const total = [];
  const st = [[], [], [], [], [], []];
  for (let run = 0; run < j.runs; run++)
    for (let i = 0; i < j.frames; i++) {
      x.set_cam(0, 0, pathFrame(run, i));
      const t = now();
      x.frame(0);
      total.push(now() - t);
    }
  for (let run = 0; run < j.runs; run++)
    for (let i = 0; i < j.frames; i++) {
      x.set_cam(0, 0, pathFrame(run, i));
      let t = now(), u;
      x.st_clear(); u = now(); st[0].push(u - t); t = u;
      x.st_select(0); u = now(); st[1].push(u - t); t = u;
      x.st_setup(0); u = now(); st[2].push(u - t); t = u;
      x.st_raster(); u = now(); st[3].push(u - t); t = u;
      x.st_mip(); u = now(); st[4].push(u - t); t = u;
      x.st_test(0); u = now(); st[5].push(u - t);
    }
  const names = ["clear", "select", "setup", "raster", "mip", "test"];
  const stages = {};
  names.forEach((n, i) => (stages[n] = pct(st[i])));
  const a = accuracy(r, j, 0, 0);
  return { total: pct(total), stages, stats: a.stats, acc: a.acc, hash: a.hash };
}

function twocamJob(r, j) {
  const x = r.x;
  x.set_res(j.w, j.h);
  r.cfg(j, j.dilate);
  const A = [], B = [], both = [];
  for (let run = 0; run < j.runs; run++)
    for (let i = 0; i < j.frames; i++) {
      const f = pathFrame(run, i);
      x.set_cam(0, 0, f);
      x.set_cam(1, j.cam2, f);
      let t = now();
      x.frame(0);
      A.push(now() - t);
      t = now();
      x.frame(1);
      B.push(now() - t);
      t = now();
      x.frame(0);
      x.frame(1);
      both.push(now() - t);
    }
  const a = accuracy(r, j, 1, j.cam2);
  return { cam_a: pct(A), cam_b: pct(B), both: pct(both), stats_b: a.stats, acc_b: a.acc };
}

function temporalJob(r, j) {
  const x = r.x;
  x.set_res(j.w, j.h);
  r.cfg(j, j.dilate);
  const fresh = [], repro = [];
  for (let run = 0; run < j.runs; run++)
    for (let i = 0; i < j.frames; i++) {
      const f = pathFrame(run, i) + 4;
      x.set_cam(0, 0, f - 1);
      x.frame(0);
      x.save_prev(0);
      x.set_cam(0, 0, f);
      let t = now();
      x.frame(0);
      fresh.push(now() - t);
      t = now();
      x.st_reproject(0);
      x.st_test(0);
      repro.push(now() - t);
    }
  const out = { fresh: pct(fresh), reproject: pct(repro) };
  for (const step of [1, 4, 12]) {
    const a = [new Array(8).fill(0), new Array(8).fill(0), new Array(8).fill(0)];
    const add = (k) => { const v = r.accRow(); for (let q = 0; q < 8; q++) a[k][q] += v[q]; };
    for (const f0 of ACC_FRAMES) {
      const f = f0 + 12;
      x.set_cam(0, 0, f - step);
      x.frame(0);
      x.save_prev(0);
      x.set_cam(0, 0, f);
      x.oracle(0, f);
      x.test_stale(0); x.compare(0); add(0);
      x.st_reproject(0); x.st_test(0); x.compare(0); add(1);
      x.frame(0); x.compare(0); add(2);
    }
    out["step" + step] = { stale: accJson(a[0]), reprojected: accJson(a[1]), fresh: accJson(a[2]) };
  }
  return out;
}

// JS<->wasm boundary: what a frame pays to move data in and out of linear memory (typed-array views, no per-call
// marshalling). Occluder matrices (12 f32 per instance) and occludee AABBs (6 f32 each) are written, visibility read.
function boundaryJob(r, j) {
  const x = r.x;
  const nI = x.n_inst(), nO = x.n_occludees();
  const mem = x.memory.buffer;
  const inst = new Float32Array(mem, x.inst_ptr(), nI * 12);
  const aabb = new Float32Array(mem, x.aabb_ptr(), nO * 6);
  const vis = new Uint8Array(mem, x.vis_ptr(0), nO);
  const srcI = new Float32Array(inst), srcO = new Float32Array(aabb);
  // scene-object state kept as JS objects: the per-object loop reads fields and writes 12 / 6 floats
  const objI = Array.from({ length: nI }, (_, i) => ({ m: srcI.subarray(i * 12, i * 12 + 12) }));
  const objO = Array.from({ length: nO }, (_, i) => ({ b: srcO.subarray(i * 6, i * 6 + 6) }));
  const K = 20, reps = 40;
  const time = (fn) => {
    const s = [];
    for (let r2 = 0; r2 < reps; r2++) {
      const t = now();
      for (let k = 0; k < K; k++) fn();
      s.push((now() - t) / K);
    }
    return pct(s);
  };
  let sink = 0;
  const res = {
    n_inst: nI, n_occludees: nO,
    bytes_in: nI * 48 + nO * 24, bytes_out: nO,
    set_instances_bulk: time(() => inst.set(srcI)),
    set_aabbs_bulk: time(() => aabb.set(srcO)),
    write_instances_loop: time(() => { for (let i = 0; i < nI; i++) { const m = objI[i].m, o = i * 12; for (let k = 0; k < 12; k++) inst[o + k] = m[k]; } }),
    write_aabbs_loop: time(() => { for (let i = 0; i < nO; i++) { const b = objO[i].b, o = i * 6; for (let k = 0; k < 6; k++) aabb[o + k] = b[k]; } }),
    read_vis_copy: time(() => { sink += vis.slice()[0]; }),
    read_vis_scan: time(() => { let c = 0; for (let i = 0; i < nO; i++) c += vis[i] === 1 ? 1 : 0; sink += c; }),
    call_overhead_empty: time(() => { for (let i = 0; i < 1000; i++) x.n_inst(); }),
    sink,
  };
  res.call_overhead_empty = { note: "1000 trivial wasm calls per sample, divide by 1000", ...res.call_overhead_empty };
  return res;
}

export async function runJobs(bytes, jobs, log = () => {}) {
  const x = await instantiate(bytes);
  const r = new Runner(x);
  const out = [];
  for (const j of jobs) {
    if (r.scene !== j.scene) r.setScene(j.scene, j.w, j.h);
    let result;
    switch (j.kind) {
      case "main": result = mainJob(r, j); break;
      case "twocam": result = twocamJob(r, j); break;
      case "temporal": result = temporalJob(r, j); break;
      case "boundary": result = boundaryJob(r, j); break;
      default: throw new Error("job kind " + j.kind);
    }
    log(j.id);
    out.push({ id: j.id, kind: j.kind, result });
  }
  return { jobs: out };
}
