//! A quick timer, not a benchmark: p50 and p99 of one occlusion view per workload over the walking camera, plus the
//! counters. Run: `cargo run --release -p vis-bench --example smoke`. Smoke-level on a shared machine; `cargo bench -p
//! vis-bench` is the measured one.
use std::time::Instant;
use vis_bench::Workload;
use vis_raster::{Config, Occlusion};

fn main() {
    for (workload, w, h) in [
        (Workload::city(false), 256, 128),
        (Workload::city(false), 320, 180),
        (Workload::city(true), 256, 128),
        (Workload::forest(), 256, 128),
    ] {
        let mut occ = Occlusion::new(w, h, Config::default());
        let mut hidden = vec![0u8; workload.boxes.len() / 6];
        let frames = 40u32;
        let mut ms = vec![];
        let mut last = Default::default();
        let (mut tris, mut culled, mut tested) = (0u64, 0u64, 0u64);
        for run in 0..5 {
            for f in 0..frames {
                let view = workload.view(f * 6);
                let frame = workload.frame(&view);
                let t = Instant::now();
                hidden.fill(0);
                let s = occ
                    .occlude(&view, &frame.occluders(), &workload.boxes, &mut hidden)
                    .unwrap();
                let dt = t.elapsed().as_secs_f64() * 1000.0;
                if run > 0 {
                    ms.push(dt);
                    tris += s.rasterised as u64;
                    culled += s.culled as u64;
                    tested += s.tested as u64 - s.outside as u64;
                }
                last = s;
            }
        }
        ms.sort_by(|a, b| a.total_cmp(b));
        let n = ms.len();
        println!(
            "{:<12} {}x{}  p50 {:.2} ms  p99 {:.2} ms   per view: {} source tris, {} rasterised, {} of {} in-frustum occludees culled ({:.0}%)  [last frame: {:?}]",
            workload.name,
            w,
            h,
            ms[n / 2],
            ms[(n * 99 / 100).min(n - 1)],
            workload.source_triangles(),
            tris / n as u64,
            culled / n as u64,
            tested / n as u64,
            100.0 * culled as f64 / tested.max(1) as f64,
            last
        );
    }
}
