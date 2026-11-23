//! T70: source value curves sampled for a clip's raw form (`compile_curve_samples`, the
//! `curve_sample` call) by the shared `myco-curve` evaluator. Values are binary fractions, so they
//! compare exactly.

use anim_editor_wasm::{compile_curve_samples, MAX_CURVE_FRAMES};

/// Keys `(x, y, interp, [inDx, inDy, outDx, outDy])` as the call takes them.
fn floats(keys: &[(f32, f32, u8, [f32; 4])]) -> Vec<f32> {
    keys.iter()
        .flat_map(|&(x, y, i, h)| [x, y, i as f32, h[0], h[1], h[2], h[3]])
        .collect()
}

#[test]
fn a_curve_is_sampled_at_the_clip_rate_and_clamped_to_its_end() {
    // Smooth from 0 to 4 over a second, then easeIn to 8 at 2.
    let keys = floats(&[
        (0.0, 0.0, 2, [0.0; 4]),
        (1.0, 4.0, 3, [0.0; 4]),
        (2.0, 8.0, 0, [0.0; 4]),
    ]);
    let out = compile_curve_samples(&keys, 4.0, 1.5, 8).unwrap();
    // smooth(u) = u²(3 − 2u) at 0, 0.25, 0.5, 0.75: 0, 0.15625, 0.5, 0.84375 (× 4); then easeIn
    // u² at 0, 0.25, 0.5 (× 4, + 4), and 1.5 again for the clamped frame.
    assert_eq!(out, [0.0, 0.625, 2.0, 3.375, 4.0, 4.25, 5.0, 5.0]);
}

#[test]
fn a_bezier_curve_samples_as_the_runtime_reads_it() {
    let keys = floats(&[
        (0.0, 0.0, 5, [0.0, 0.0, 0.25, 1.0]),
        (1.0, 1.0, 5, [-0.25, 0.0, 0.0, 0.0]),
    ]);
    let baked = anim_sample::curve::parse_keys(&keys).unwrap();
    let out = compile_curve_samples(&keys, 8.0, 1.0, 9).unwrap();
    for (i, v) in out.iter().enumerate() {
        assert_eq!(
            *v,
            anim_sample::curve::eval(&baked[..], i as f32 / 8.0),
            "frame {i}"
        );
    }
    assert_eq!((out[0], out[8]), (0.0, 1.0), "the keys' own values");
}

#[test]
fn bad_keys_and_too_many_frames_are_refused() {
    let one = floats(&[(0.0, 0.0, 0, [0.0; 4]), (1.0, 1.0, 0, [0.0; 4])]);
    assert!(
        compile_curve_samples(&one[..8], 30.0, 1.0, 2).is_err(),
        "not whole keys"
    );
    let unsorted = floats(&[(1.0, 0.0, 0, [0.0; 4]), (0.0, 1.0, 0, [0.0; 4])]);
    assert!(
        compile_curve_samples(&unsorted, 30.0, 1.0, 2).is_err(),
        "out of order"
    );
    assert!(compile_curve_samples(&one, 30.0, 1.0, MAX_CURVE_FRAMES + 1).is_err());
    assert_eq!(
        compile_curve_samples(&[], 30.0, 1.0, 2).unwrap(),
        [0.0, 0.0],
        "an empty curve is 0"
    );
}
