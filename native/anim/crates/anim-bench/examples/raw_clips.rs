//! Writes the bench's 80-bone humanoid and its idle, walk and run clips as raw keys in JSON, for engines that don't read
//! our files (`tools/anim-bench/babylon.mjs`, the Babylon comparison): the same skeleton and the same seeds as
//! `scenario::humanoid(80)`, before compression (30 Hz, 31 frames a second, every bone's translation, rotation and scale
//! each frame). Generated, never committed. Usage: `cargo run --release -p anim-bench --example raw_clips -- FILE`.
use anim_bench::common::{self, synth, Rng, Shape};
use std::fmt::Write as _;

fn main() {
    let path = std::env::args()
        .nth(1)
        .expect("usage: raw_clips <output file>");
    let (skel, _) = common::skeleton(Shape::Humanoid80, 3);
    let mut out = String::from("{\n  \"bones\": [\n");
    for (i, b) in skel.bones.iter().enumerate() {
        let parent = if b.parent == anim_format::skeleton::NO_PARENT {
            -1
        } else {
            b.parent as i32
        };
        let _ = write!(
            out,
            "    {{ \"parent\": {parent}, \"t\": {:?}, \"r\": {:?}, \"s\": {:?} }}{}\n",
            b.translation,
            b.rotation,
            b.scale,
            if i + 1 < skel.bones.len() { "," } else { "" }
        );
    }
    out.push_str("  ],\n  \"clips\": {\n");
    // The seeds `scenario::humanoid` gives `common::clip` (each starts its own generator, so the keys are the same).
    let clips = [("idle", 33u64), ("walk", 31), ("run", 32)];
    for (n, (name, seed)) in clips.iter().enumerate() {
        let mut rng = Rng::new(*seed);
        let clip = synth::clip(&skel, 1.0, true, &mut rng);
        let _ = write!(
            out,
            "    \"{name}\": {{ \"rate\": {}, \"frames\": {}, \"tracks\": [\n",
            clip.sample_rate, clip.frame_count
        );
        for (k, track) in clip.tracks.iter().enumerate() {
            let _ = write!(
                out,
                "      {:?}{}\n",
                track.raw,
                if k + 1 < clip.tracks.len() { "," } else { "" }
            );
        }
        let _ = write!(
            out,
            "    ] }}{}\n",
            if n + 1 < clips.len() { "," } else { "" }
        );
    }
    out.push_str("  }\n}\n");
    std::fs::write(&path, out).expect("write the clips");
    println!("wrote {path}");
}
