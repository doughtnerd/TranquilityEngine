//! Runs one budget scenario for a number of frames, for a native profiler (callgrind, perf):
//!
//! ```text
//! CARGO_PROFILE_RELEASE_DEBUG=true cargo build --release -p anim-bench --example profile
//! valgrind --tool=callgrind target/release/examples/profile locomotion_rig 80 200
//! ```
//!
//! Scenarios: `one_clip`, `crossfade`, `locomotion`, `locomotion_rig`, `rig_only` (100 instances
//! of 60 or 80 bones), `match_kd`, `match_bf` (20 characters), `tweens`.

use anim_bench::scenario::*;
use std::time::Instant;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let name = args.get(1).map_or("locomotion_rig", |s| s.as_str());
    let bones: usize = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(80);
    let frames: usize = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(300);
    let mut step: Box<dyn FnMut()> = match name {
        "match_kd" | "match_bf" => {
            let set = match_set();
            let mut m = Matchers::new(&set, name == "match_bf", MATCHERS);
            Box::new(move || m.frame())
        }
        "tweens" => {
            let mut core = tweens(TweenMix::Eased);
            Box::new(move || {
                core.write_inputs(0);
                core.evaluate(0, anim_wire::core::PASS_NORMAL, DT, DT);
            })
        }
        crowd => {
            let crowd = match crowd {
                "one_clip" => Crowd::OneClip,
                "crossfade" => Crowd::Crossfade,
                "locomotion" => Crowd::Loco,
                "rig_only" => Crowd::RigOnly,
                _ => Crowd::LocoRig,
            };
            let mut s = Characters::new(&humanoid(bones), crowd, CROWD);
            Box::new(move || s.frame())
        }
    };
    let t = Instant::now();
    for _ in 0..frames {
        step();
    }
    let ms = t.elapsed().as_secs_f64() * 1e3 / frames as f64;
    println!("{name} ({bones} bones): {ms:.3} ms per frame, mean of {frames}");
}
