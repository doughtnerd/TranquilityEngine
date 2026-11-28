//! The measurement loop: scenes x paths x frames x resolutions x stand-in types x rule sets, against the 1080p oracle.
use crate::data::{Scene, N_TYPES};
use crate::oracle::{self, HIDDEN, OUTSIDE, VISIBLE};
use crate::setup::{bounds_distance, projected_min_width, setup_standin, Near, Rule};
use occ::cull::{test_occludees, Config, N_STATS};
use occ::geom::Camera;
use occ::raster::{raster_simd, DepthBuf, Tri};
use std::fmt::Write;

pub const RES: [(usize, usize); 2] = [(256, 128), (320, 180)];

#[derive(Default, Clone)]
pub struct Agg {
    pub frames: u32,
    pub in_frustum: u32,
    pub oracle_hidden: u32,
    pub buf_culled: u32,
    pub false_occ: u32,
    pub frames_false: u32,
    pub false_ge16: u32,
    pub tris: u64,
    pub occluders_used: u64,
    pub false_px: Vec<u32>,
    pub false_ids: Vec<u32>,
    pub samples: Vec<(u32, u32, u32)>,
}

pub fn camera(eye: [f32; 3], target: [f32; 3]) -> Camera {
    Camera::perspective(eye, target, 60.0, 16.0 / 9.0, 0.1, 400.0)
}

/// Does `rule` let this occluder take part for `cam`?
pub fn participates(cam: &Camera, w: usize, h: usize, o: &crate::data::Occluder, rule: &Rule) -> bool {
    let thr = match rule.near {
        Near::None => -1.0,
        Near::Mult(k) => k * cam.near,
        Near::Radius(r) => r,
        Near::TriErr(_) => -1.0,
    };
    if thr >= 0.0 && bounds_distance(cam, o.bmin, o.bmax) <= thr {
        return false;
    }
    if rule.width && projected_min_width(cam, w, h, o.bmin, o.bmax) < 2.0 {
        return false;
    }
    true
}

pub struct Result {
    pub scene: usize,
    pub path: usize,
    pub typ: usize,
    pub res: usize,
    pub rule: usize,
    pub agg: Agg,
}

pub fn run(scenes: &[Scene], rules: &[Rule], frame_step: usize) -> Vec<Result> {
    let mut results = vec![];
    let base_cfg = Config::default(); // dilate 1, eps 1e-3, hierarchical test: the spike's accuracy configuration
    let mut obuf = DepthBuf::new(oracle::W, oracle::H);
    let mut otris: Vec<Tri> = vec![];
    for (si, sc) in scenes.iter().enumerate() {
        for (pi, path) in sc.paths.iter().enumerate() {
            let mut aggs: Vec<Agg> = vec![Agg::default(); N_TYPES * RES.len() * rules.len()];
            for (fi, fr) in path.iter().enumerate() {
                if fi % frame_step != 0 {
                    continue;
                }
                let cam = camera(fr.eye, fr.target);
                let orc = oracle::run(&cam, &sc.occluders, &sc.aabbs, &mut obuf, &mut otris);
                let n = sc.aabbs.len() / 6;
                let mut vis = vec![0u8; n];
                let mut st = [0u32; N_STATS];
                for (ri, &(w, h)) in RES.iter().enumerate() {
                    let mut buf = DepthBuf::new(w, h);
                    let mut tris: Vec<Tri> = vec![];
                    for ty in 0..N_TYPES {
                        for (ru, rule) in rules.iter().enumerate() {
                            buf.clear();
                            tris.clear();
                            let mut used = 0;
                            for o in &sc.occluders {
                                if participates(&cam, w, h, o, rule) {
                                    setup_standin(&cam, w, h, o, &o.types[ty], rule, &mut tris);
                                    used += 1;
                                }
                            }
                            for t in &tris {
                                raster_simd(&mut buf, t);
                            }
                            buf.build_mip(true);
                            let cfg = Config { dilate: rule.dilate, ..base_cfg };
                            test_occludees(&cam, &buf, &sc.aabbs, &mut vis, &cfg, &mut st);
                            let a = &mut aggs[(ty * RES.len() + ri) * rules.len() + ru];
                            a.frames += 1;
                            a.tris += tris.len() as u64;
                            a.occluders_used += used;
                            let mut any_false = false;
                            for i in 0..n {
                                if orc.vis[i] == OUTSIDE || vis[i] == OUTSIDE {
                                    continue;
                                }
                                a.in_frustum += 1;
                                let truth_hidden = orc.vis[i] == HIDDEN;
                                if truth_hidden {
                                    a.oracle_hidden += 1;
                                }
                                if vis[i] == 0 {
                                    a.buf_culled += 1;
                                    if !truth_hidden {
                                        debug_assert!(orc.vis[i] == VISIBLE);
                                        a.false_occ += 1;
                                        any_false = true;
                                        a.false_px.push(orc.px[i]);
                                        if orc.px[i] >= 16 {
                                            a.false_ge16 += 1;
                                        }
                                        a.false_ids.push(i as u32);
                                        if a.samples.len() < 4 {
                                            a.samples.push((fi as u32, i as u32, orc.px[i]));
                                        }
                                    }
                                }
                            }
                            if any_false {
                                a.frames_false += 1;
                            }
                        }
                    }
                }
            }
            for ty in 0..N_TYPES {
                for ri in 0..RES.len() {
                    for ru in 0..rules.len() {
                        let agg = std::mem::take(&mut aggs[(ty * RES.len() + ri) * rules.len() + ru]);
                        results.push(Result { scene: si, path: pi, typ: ty, res: ri, rule: ru, agg });
                    }
                }
            }
        }
    }
    results
}

pub fn to_json(results: &[Result]) -> String {
    let mut s = String::from("[\n");
    for (i, r) in results.iter().enumerate() {
        let a = &r.agg;
        let mut px = a.false_px.clone();
        px.sort();
        let mut ids = a.false_ids.clone();
        ids.sort();
        ids.dedup();
        let pxmin = px.first().copied().unwrap_or(0);
        let pxmed = if px.is_empty() { 0 } else { px[px.len() / 2] };
        let samples: Vec<String> = a.samples.iter().map(|(f, i, p)| format!("[{f},{i},{p}]")).collect();
        let _ = write!(
            s,
            "{{\"scene\":{},\"path\":{},\"type\":{},\"res\":{},\"rule\":{},\"frames\":{},\"inFrustum\":{},\"oracleHidden\":{},\"culled\":{},\"falseOcc\":{},\"framesFalse\":{},\"distinctFalse\":{},\"falseGe16\":{},\"falsePxMin\":{},\"falsePxMed\":{},\"tris\":{},\"occludersUsed\":{},\"samples\":[{}]}}",
            r.scene, r.path, r.typ, r.res, r.rule, a.frames, a.in_frustum, a.oracle_hidden, a.buf_culled, a.false_occ, a.frames_false, ids.len(), a.false_ge16, pxmin, pxmed, a.tris, a.occluders_used, samples.join(",")
        );
        s.push_str(if i + 1 < results.len() { ",\n" } else { "\n" });
    }
    s.push(']');
    s
}
