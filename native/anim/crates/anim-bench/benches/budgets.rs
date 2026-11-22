//! ADR 0340's budget scenarios end to end, natively (`cargo bench -p anim-bench --bench budgets`).
//! One iteration is one frame of the whole crowd. Tripwires: the character crowd (100 × 80 bones,
//! `locomotion + rig`) ≤ 1.5 ms, 20 matching characters ≤ 0.6 ms, 1,000 tweens ≤ 0.2 ms.

use anim_bench::scenario::*;
use criterion::{criterion_group, criterion_main, Criterion};
use std::hint::black_box;

fn characters(c: &mut Criterion) {
    let mut g = c.benchmark_group("characters_100");
    for bones in [60, 80] {
        let h = humanoid(bones);
        for (label, crowd) in [
            ("one_clip", Crowd::OneClip),
            ("crossfade", Crowd::Crossfade),
            ("locomotion", Crowd::Loco),
            ("locomotion_rig", Crowd::LocoRig),
        ] {
            let mut s = Characters::new(&h, crowd, CROWD);
            g.bench_function(format!("{label}/{bones}_bones"), |b| {
                b.iter(|| {
                    s.frame();
                    black_box(s.core.matrices()[0])
                })
            });
        }
    }
    g.finish();
}

fn matching(c: &mut Criterion) {
    let set = match_set();
    let mut g = c.benchmark_group("matching_20");
    for (label, brute) in [("kd_tree", false), ("brute_force", true)] {
        let mut m = Matchers::new(&set, brute, MATCHERS);
        // Six frames per iteration: every character searches once.
        g.bench_function(format!("{label}/6_frames"), |b| {
            b.iter(|| {
                for _ in 0..SEARCH_INTERVAL {
                    m.frame();
                }
                black_box(m.core.matrices()[0])
            })
        });
    }
    g.finish();
}

fn tweens_1000(c: &mut Criterion) {
    let mut g = c.benchmark_group("tweens_1000");
    for (label, mix) in [
        ("linear", TweenMix::Linear),
        ("eased", TweenMix::Eased),
        ("vec3_quat", TweenMix::VecQuat),
    ] {
        let mut core = tweens(mix);
        g.bench_function(label, |b| {
            b.iter(|| {
                core.write_inputs(0);
                black_box(core.evaluate(0, anim_wire::core::PASS_NORMAL, DT, DT))
            })
        });
    }
    g.finish();
}

criterion_group!(benches, characters, matching, tweens_1000);
criterion_main!(benches);
