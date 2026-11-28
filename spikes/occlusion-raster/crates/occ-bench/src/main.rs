//! Native bench: runs the job list in a TSV file (written by run.mjs) and prints one JSON array of results.
//! The JS harness (harness.mjs) implements the same protocol over the wasm module, so the numbers line up.
//! usage: occ-bench jobs.tsv
use occ::cull::*;
use occ::Ctx;
use std::collections::HashMap;
use std::time::Instant;

const ACC_FRAMES: [u32; 8] = [0, 30, 60, 90, 120, 150, 180, 210];

struct Job {
    id: String,
    kind: String,
    scene: u32,
    w: usize,
    h: usize,
    cap: u32,
    min_area: f32,
    dilate: i32,
    simd: bool,
    inner: f32,
    frames: u32,
    runs: u32,
    cam2: u32,
}

fn parse(path: &str) -> Vec<Job> {
    let text = std::fs::read_to_string(path).expect("jobs file");
    text.lines()
        .filter(|l| !l.trim().is_empty())
        .map(|l| {
            let f: Vec<&str> = l.split('\t').collect();
            Job {
                id: f[0].to_string(),
                kind: f[1].to_string(),
                scene: f[2].parse().unwrap(),
                w: f[3].parse().unwrap(),
                h: f[4].parse().unwrap(),
                cap: f[5].parse().unwrap(),
                min_area: f[6].parse().unwrap(),
                dilate: f[7].parse().unwrap(),
                simd: f[8] == "1",
                inner: f[9].parse().unwrap(),
                frames: f[10].parse().unwrap(),
                runs: f[11].parse().unwrap(),
                cam2: f[12].parse().unwrap(),
            }
        })
        .collect()
}

fn pct(v: &mut Vec<f64>) -> String {
    v.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = v.len();
    let at = |p: f64| v[(((p * n as f64).ceil() as usize).max(1) - 1).min(n - 1)];
    format!("{{\"p50\":{:.5},\"p99\":{:.5},\"max\":{:.5},\"n\":{}}}", at(0.5), at(0.99), v[n - 1], n)
}

fn ms(t: Instant) -> f64 {
    t.elapsed().as_secs_f64() * 1000.0
}

fn cfg_of(j: &Job, dilate: i32) -> Config {
    Config { cap_tris: j.cap, min_area: j.min_area, dilate, simd: j.simd, hier: true, eps: 1e-3, inner: j.inner }
}

fn path_frame(run: u32, i: u32) -> u32 {
    (i * 3 + run * 17) % 240
}

fn stats_json(s: &[f64; N_STATS]) -> String {
    let names = ["inst_total", "inst_frustum", "inst_selected", "tris_src", "tris_frustum", "tris_back", "tris_clipped", "tris_raster", "occ_total", "occ_outside", "occ_near", "occ_culled", "occ_visible"];
    let parts: Vec<String> = names.iter().enumerate().map(|(i, n)| format!("\"{}\":{:.1}", n, s[i])).collect();
    format!("{{{}}}", parts.join(","))
}

fn acc_json(a: &[u64; 8]) -> String {
    format!("{{\"in_frustum\":{},\"oracle_culled\":{},\"buf_culled\":{},\"lost\":{},\"false_occluded\":{}}}", a[0], a[1], a[2], a[3], a[4])
}

/// Accuracy and stats over ACC_FRAMES for the job's configuration at both dilate 0 and 1.
fn accuracy(c: &mut Ctx, j: &Job, slot: usize, cam_kind: u32) -> (String, [f64; N_STATS], u32) {
    let mut acc = [[0u64; 8]; 2];
    let mut stats = [0f64; N_STATS];
    let mut hash = 0u32;
    for &f in &ACC_FRAMES {
        c.set_cam(slot, cam_kind, f);
        for (di, d) in [0, 1].iter().enumerate() {
            c.cfg = cfg_of(j, *d);
            c.frame(slot);
            if di == 1 {
                for k in 0..N_STATS {
                    stats[k] += c.stats[k] as f64 / ACC_FRAMES.len() as f64;
                }
                hash = hash.rotate_left(5) ^ c.vis_hash(slot);
            }
            c.oracle(slot, if slot == 0 { f as i32 } else { -1 });
            c.compare(slot);
            for k in 0..8 {
                acc[di][k] += c.acc[k] as u64;
            }
        }
    }
    (format!("{{\"d0\":{},\"d1\":{}}}", acc_json(&acc[0]), acc_json(&acc[1])), stats, hash)
}

fn main_job(c: &mut Ctx, j: &Job) -> String {
    c.set_res(j.w, j.h);
    c.cfg = cfg_of(j, j.dilate);
    c.set_cam(0, 0, 0);
    for i in 0..10 {
        c.set_cam(0, 0, i);
        c.frame(0);
    }
    let mut total = vec![];
    let mut st: Vec<Vec<f64>> = vec![vec![]; 6];
    for run in 0..j.runs {
        for i in 0..j.frames {
            c.set_cam(0, 0, path_frame(run, i));
            let t = Instant::now();
            c.frame(0);
            total.push(ms(t));
        }
    }
    for run in 0..j.runs {
        for i in 0..j.frames {
            c.set_cam(0, 0, path_frame(run, i));
            let t = Instant::now();
            c.st_clear();
            st[0].push(ms(t));
            let t = Instant::now();
            c.st_select(0);
            st[1].push(ms(t));
            let t = Instant::now();
            c.st_setup(0);
            st[2].push(ms(t));
            let t = Instant::now();
            c.st_raster();
            st[3].push(ms(t));
            let t = Instant::now();
            c.st_mip();
            st[4].push(ms(t));
            let t = Instant::now();
            c.st_test(0);
            st[5].push(ms(t));
        }
    }
    let names = ["clear", "select", "setup", "raster", "mip", "test"];
    let stages: Vec<String> = names.iter().enumerate().map(|(i, n)| format!("\"{}\":{}", n, pct(&mut st[i]))).collect();
    let (acc, stats, hash) = accuracy(c, j, 0, 0);
    format!("{{\"total\":{},\"stages\":{{{}}},\"stats\":{},\"acc\":{},\"hash\":{}}}", pct(&mut total), stages.join(","), stats_json(&stats), acc, hash)
}

fn twocam_job(c: &mut Ctx, j: &Job) -> String {
    c.set_res(j.w, j.h);
    c.cfg = cfg_of(j, j.dilate);
    let (mut a, mut b, mut both) = (vec![], vec![], vec![]);
    for run in 0..j.runs {
        for i in 0..j.frames {
            let f = path_frame(run, i);
            c.set_cam(0, 0, f);
            c.set_cam(1, j.cam2, f);
            let t = Instant::now();
            c.frame(0);
            a.push(ms(t));
            let t = Instant::now();
            c.frame(1);
            b.push(ms(t));
            let t = Instant::now();
            c.frame(0);
            c.frame(1);
            both.push(ms(t));
        }
    }
    let (acc1, stats1, _) = accuracy(c, j, 1, j.cam2);
    format!("{{\"cam_a\":{},\"cam_b\":{},\"both\":{},\"stats_b\":{},\"acc_b\":{}}}", pct(&mut a), pct(&mut b), pct(&mut both), stats_json(&stats1), acc1)
}

fn temporal_job(c: &mut Ctx, j: &Job) -> String {
    c.set_res(j.w, j.h);
    c.cfg = cfg_of(j, j.dilate);
    // cost: a fresh frame vs "reproject last frame's tiles + test"
    let (mut fresh, mut repro) = (vec![], vec![]);
    for run in 0..j.runs {
        for i in 0..j.frames {
            let f = path_frame(run, i) + 4;
            c.set_cam(0, 0, f - 1);
            c.frame(0);
            c.save_prev(0);
            c.set_cam(0, 0, f);
            let t = Instant::now();
            c.frame(0);
            fresh.push(ms(t));
            let t = Instant::now();
            c.st_reproject(0);
            c.st_test(0);
            repro.push(ms(t));
        }
    }
    // accuracy against the oracle of the current frame, for last-frame data that is `step` path frames old
    let mut rows = vec![];
    for &step in &[1u32, 4, 12] {
        let mut a = [[0u64; 8]; 3]; // stale, reprojected, fresh
        for &f0 in &ACC_FRAMES {
            let f = f0 + 12;
            c.set_cam(0, 0, f - step);
            c.frame(0);
            c.save_prev(0);
            c.set_cam(0, 0, f);
            c.oracle(0, f as i32);
            c.test_stale(0);
            c.compare(0);
            for k in 0..8 {
                a[0][k] += c.acc[k] as u64;
            }
            c.st_reproject(0);
            c.st_test(0);
            c.compare(0);
            for k in 0..8 {
                a[1][k] += c.acc[k] as u64;
            }
            c.frame(0);
            c.compare(0);
            for k in 0..8 {
                a[2][k] += c.acc[k] as u64;
            }
        }
        rows.push(format!("\"step{}\":{{\"stale\":{},\"reprojected\":{},\"fresh\":{}}}", step, acc_json(&a[0]), acc_json(&a[1]), acc_json(&a[2])));
    }
    format!("{{\"fresh\":{},\"reproject\":{},{}}}", pct(&mut fresh), pct(&mut repro), rows.join(","))
}

fn main() {
    let path = std::env::args().nth(1).expect("usage: occ-bench jobs.tsv");
    let jobs = parse(&path);
    let mut ctxs: HashMap<u32, Ctx> = HashMap::new();
    let mut out = vec![];
    for j in &jobs {
        let c = ctxs.entry(j.scene).or_insert_with(|| Ctx::new(j.scene, j.w, j.h));
        let body = match j.kind.as_str() {
            "main" => main_job(c, j),
            "twocam" => twocam_job(c, j),
            "temporal" => temporal_job(c, j),
            k => panic!("unknown job kind {k}"),
        };
        eprintln!("[native] {}", j.id);
        out.push(format!("{{\"id\":\"{}\",\"kind\":\"{}\",\"result\":{}}}", j.id, j.kind, body));
    }
    println!("{{\"backend\":\"{}\",\"jobs\":[{}]}}", occ::f4::BACKEND, out.join(","));
}
