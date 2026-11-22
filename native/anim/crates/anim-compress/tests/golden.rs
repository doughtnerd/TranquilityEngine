//! Cross-target determinism: a clip built only from deterministic operations (anim-math's
//! polynomial trigonometry, f32/f64 arithmetic) compresses to the same bytes natively and on
//! wasm32 (run through `crates/anim-math/wasm-test-runner.mjs`).

use anim_compress::{compress, RootMotion, Settings, ROOT_ALL};
use anim_format::clip::{Binding, Clip, Track, TrackKind};
use anim_format::skeleton::{Bone, Skeleton, NO_PARENT};
use anim_format::NONE;
use anim_math::trig::sin_cos;

fn fnv1a(bytes: &[u8]) -> u64 {
    bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, &b| {
        (h ^ b as u64).wrapping_mul(0x0000_0100_0000_01b3)
    })
}

fn fixture() -> (Skeleton, Clip) {
    let n = 12usize;
    let bones: Vec<Bone> = (0..n)
        .map(|i| Bone {
            name: i as u32,
            parent: if i == 0 {
                NO_PARENT
            } else {
                ((i - 1) / 2) as u16
            },
            translation: [0.0, if i == 0 { 0.0 } else { 0.2 }, 0.05 * (i % 3) as f32],
            rotation: [0.0, 0.0, 0.0, 1.0],
            scale: [1.0; 3],
            inverse_bind: [1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0, 0.0, 0.0, 0.0, 1.0, 0.0],
        })
        .collect();
    let frames = 50u32;
    let tracks = (0..n)
        .map(|i| {
            let mut raw = Vec::new();
            for f in 0..frames {
                let t = f as f32 / 30.0;
                let (s, c) = sin_cos(t * (1.0 + i as f32 * 0.7) * 0.5);
                let (ys, yc) = sin_cos(t * 0.3);
                let (x, y, z, w) = if i == 0 {
                    (0.0, ys, 0.0, yc)
                } else {
                    (s * 0.3, 0.0, 0.0, c)
                };
                let len = (x * x + y * y + z * z + w * w).sqrt();
                raw.extend_from_slice(&[
                    if i == 0 { t * 1.1 } else { 0.0 },
                    if i == 0 {
                        0.0
                    } else {
                        0.2 + s * 0.01 * (i % 2) as f32
                    },
                    0.05 * (i % 3) as f32,
                    x / len,
                    y / len,
                    z / len,
                    w / len,
                    1.0,
                    1.0,
                    1.0,
                ]);
            }
            Track {
                kind: TrackKind::Bone,
                flags: 0,
                subtype: 0,
                binding: Binding::bone(i as u32),
                raw,
                keys: Vec::new(),
            }
        })
        .collect();
    let skel = Skeleton {
        name: NONE,
        profile: NONE,
        mirror_axis: 0,
        strings: (0..n).map(|i| format!("b{i}")).collect(),
        bones,
        roles: None,
        joint_ranges: None,
        mirror: None,
    };
    let clip = Clip {
        flags: 0,
        name: NONE,
        duration: 49.0 / 30.0,
        sample_rate: 30.0,
        frame_count: frames,
        bone_count: n as u32,
        root_bone: NONE,
        strings: Vec::new(),
        tracks,
        has_raw: true,
        root_curve: None,
        compressed: None,
    };
    (skel, clip)
}

#[test]
fn same_bytes_on_every_target() {
    let (skel, clip) = fixture();
    let settings = Settings {
        root_motion: Some(RootMotion {
            bone: 0,
            axes: ROOT_ALL,
        }),
        ..Settings::default()
    };
    let out = compress(&clip, Some(&skel), &settings).unwrap();
    assert!(out.report.within_bounds);
    assert_eq!(
        fnv1a(&out.bytes),
        GOLDEN,
        "bytes changed: {:#x}",
        fnv1a(&out.bytes)
    );
}

/// The FNV-1a hash of the output. A deliberate change to the compressor updates it (from the
/// failure message); it must stay equal between native and wasm32.
const GOLDEN: u64 = 0x8dc7_0e71_5525_bd3b;
