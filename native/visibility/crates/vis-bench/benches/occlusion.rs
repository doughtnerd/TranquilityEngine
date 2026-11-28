//! Criterion benches of one occlusion view over the spike's workloads (ADR 0460 section 0's cost figures). The frame's
//! inputs are built once per camera position (outside the timing), as the engine's selection step hands them over.
use criterion::{criterion_group, criterion_main, Criterion};
use vis_bench::Workload;
use vis_raster::{Config, Occlusion};

fn views(c: &mut Criterion) {
    for (workload, w, h) in [
        (Workload::city(false), 256, 128),
        (Workload::city(false), 320, 180),
        (Workload::city(true), 256, 128),
        (Workload::forest(), 256, 128),
    ] {
        for simd in [true, false] {
            let mut occ = Occlusion::new(w, h, Config { simd });
            let mut hidden = vec![0u8; workload.boxes.len() / 6];
            let inputs: Vec<_> = (0..8)
                .map(|k| {
                    (
                        workload.view(k * 30),
                        workload.frame(&workload.view(k * 30)),
                    )
                })
                .collect();
            let name = format!(
                "{} {}x{} {}",
                workload.name,
                w,
                h,
                if simd { "simd" } else { "scalar" }
            );
            c.bench_function(&name, |b| {
                let mut k = 0;
                b.iter(|| {
                    let (view, frame) = &inputs[k % inputs.len()];
                    k += 1;
                    hidden.fill(0);
                    occ.occlude(view, &frame.occluders(), &workload.boxes, &mut hidden)
                        .unwrap()
                })
            });
        }
    }
}

criterion_group!(benches, views);
criterion_main!(benches);
