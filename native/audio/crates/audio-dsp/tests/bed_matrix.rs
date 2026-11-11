//! ADR 0162 A3 (leaf L-A3b): the baked 16 → 2 bed matrix (`audio_dsp::bed_matrix`) against
//! `EqualPowerPanner` (api-and-models §9): within 2 dB except within 10° of the ±90° fold.

use audio_dsp::bed_matrix::{decode_add, gains, BED_CHANNELS, BED_MATRIX};
use audio_dsp::pan::EqualPowerPanner;

const LIMIT_DB: f64 = 2.0;
const FOLD_GUARD_DEG: f64 = 10.0;
const FRAMES: usize = 128;

/// AmbiX SN3D encoding of the horizontal direction for engine azimuth `theta_deg` (positive to the
/// right): `(cos θ, −sin θ, 0)`. Written out here in f64, independent of `audio_dsp::ambisonic`.
fn encode(theta_deg: f64) -> [f64; BED_CHANNELS] {
    let t = theta_deg.to_radians();
    let (x, y, z) = (t.cos(), -t.sin(), 0.0f64);
    let s3 = 3f64.sqrt();
    let s15 = 15f64.sqrt();
    [
        1.0,
        y,
        z,
        x,
        s3 * x * y,
        s3 * y * z,
        0.5 * (3.0 * z * z - 1.0),
        s3 * x * z,
        (s3 / 2.0) * (x * x - y * y),
        (5.0f64 / 8.0).sqrt() * y * (3.0 * x * x - y * y),
        s15 * x * y * z,
        (3.0f64 / 8.0).sqrt() * y * (5.0 * z * z - 1.0),
        0.5 * z * (5.0 * z * z - 3.0),
        (3.0f64 / 8.0).sqrt() * x * (5.0 * z * z - 1.0),
        (s15 / 2.0) * z * (x * x - y * y),
        (5.0f64 / 8.0).sqrt() * x * (x * x - 3.0 * y * y),
    ]
}

fn encode_f32(theta_deg: f64) -> [f32; BED_CHANNELS] {
    let e = encode(theta_deg);
    let mut out = [0.0f32; BED_CHANNELS];
    for (o, v) in out.iter_mut().zip(e.iter()) {
        *o = *v as f32;
    }
    out
}

/// The bed's `(left, right)` gains for engine azimuth `theta_deg`.
fn bed_gains(theta_deg: f64) -> (f32, f32) {
    gains(&encode_f32(theta_deg))
}

/// `EqualPowerPanner`'s mono `(left, right)` gains for engine azimuth `theta_deg`.
fn panner_gains(theta_deg: f64) -> (f64, f64) {
    let mut panner = EqualPowerPanner::new();
    panner.update_desired_gain(theta_deg, 1);
    panner.desired_gains()
}

/// `20·log10(|bed| / |panner|)`.
fn error_db(bed: f32, panner: f64) -> f64 {
    20.0 * ((bed as f64).abs() / panner.abs()).log10()
}

/// Azimuths in 0.5° steps from −180° to +180°, as integers over 2 to stay exact.
fn grid() -> impl Iterator<Item = f64> {
    (-360i32..=360).map(|k| k as f64 * 0.5)
}

#[test]
fn horizontal_plane_within_2_db_of_equal_power_panner_away_from_the_fold() {
    let mut worst = (0.0f64, 0.0f64);
    for theta in grid() {
        if ((theta.abs() - 90.0).abs()) < FOLD_GUARD_DEG {
            continue;
        }
        let (bl, br) = bed_gains(theta);
        let (pl, pr) = panner_gains(theta);
        for err in [error_db(bl, pl), error_db(br, pr)] {
            if err.abs() > worst.0.abs() {
                worst = (err, theta);
            }
        }
    }
    eprintln!("worst error away from the fold: {:.3} dB at theta {:.1}", worst.0, worst.1);
    assert!(
        worst.0.abs() <= LIMIT_DB,
        "worst error {:.3} dB at theta {:.1} exceeds {LIMIT_DB} dB",
        worst.0,
        worst.1
    );
}

#[test]
fn louder_ear_within_2_db_everywhere_on_the_horizontal_plane() {
    let mut worst = (0.0f64, 0.0f64);
    for theta in grid() {
        let (bl, br) = bed_gains(theta);
        let (pl, pr) = panner_gains(theta);
        let err = if pl >= pr { error_db(bl, pl) } else { error_db(br, pr) };
        if err.abs() > worst.0.abs() {
            worst = (err, theta);
        }
    }
    eprintln!("worst error on the louder ear: {:.3} dB at theta {:.1}", worst.0, worst.1);
    assert!(
        worst.0.abs() <= LIMIT_DB,
        "louder-ear error {:.3} dB at theta {:.1} exceeds {LIMIT_DB} dB",
        worst.0,
        worst.1
    );
}

#[test]
fn far_ear_at_the_fold_is_at_least_15_db_below_the_near_ear() {
    let (bl, br) = bed_gains(90.0);
    let drop_at_plus_90 = -20.0 * ((bl as f64).abs() / (br as f64).abs()).log10();
    assert!(
        drop_at_plus_90 >= 15.0,
        "at +90 the left gain ({bl}) is only {drop_at_plus_90:.2} dB below the right ({br})"
    );

    let (bl, br) = bed_gains(-90.0);
    let drop_at_minus_90 = -20.0 * ((br as f64).abs() / (bl as f64).abs()).log10();
    assert!(
        drop_at_minus_90 >= 15.0,
        "at -90 the right gain ({br}) is only {drop_at_minus_90:.2} dB below the left ({bl})"
    );
}

#[test]
fn matrix_is_mirror_symmetric_left_to_right() {
    // Channels odd in y (ACN 1, 4, 5, 9, 10, 11) flip sign between the ears; the rest match.
    const ODD_IN_Y: [usize; 6] = [1, 4, 5, 9, 10, 11];
    for c in 0..BED_CHANNELS {
        let s = if ODD_IN_Y.contains(&c) { -1.0f32 } else { 1.0f32 };
        assert_eq!(
            BED_MATRIX[1][c],
            s * BED_MATRIX[0][c],
            "channel {c}: right {} is not {s} times left {}",
            BED_MATRIX[1][c],
            BED_MATRIX[0][c]
        );
    }

    for theta in grid() {
        let (l, r) = bed_gains(theta);
        let (ml, mr) = bed_gains(-theta);
        assert!(
            (l - mr).abs() <= 1e-6 && (r - ml).abs() <= 1e-6,
            "theta {theta}: gains ({l}, {r}) are not the swap of ({ml}, {mr}) at -theta"
        );
    }
}

#[test]
fn decode_add_adds_the_matrix_decode_of_a_planar_bed() {
    let theta = 30.0;
    let encoded = encode_f32(theta);
    let (gain_l, gain_r) = gains(&encoded);

    let x: Vec<f32> = (0..FRAMES).map(|i| ((i as f32) * 0.37).sin() * 0.5).collect();
    let mut bed = vec![0.0f32; BED_CHANNELS * FRAMES];
    for c in 0..BED_CHANNELS {
        for i in 0..FRAMES {
            bed[c * FRAMES + i] = x[i] * encoded[c];
        }
    }

    let prefill_l: Vec<f32> = (0..FRAMES).map(|i| 0.3 * ((i as f32) * 0.01).cos() + 0.1).collect();
    let prefill_r: Vec<f32> = (0..FRAMES).map(|i| -0.2 + 0.002 * i as f32).collect();
    let mut l = prefill_l.clone();
    let mut r = prefill_r.clone();
    decode_add(&bed, FRAMES, &mut l, &mut r);

    for i in 0..FRAMES {
        let expected_l = prefill_l[i] + gain_l * x[i];
        let expected_r = prefill_r[i] + gain_r * x[i];
        assert!((l[i] - expected_l).abs() <= 1e-6, "left frame {i}: got {}, expected {expected_l}", l[i]);
        assert!((r[i] - expected_r).abs() <= 1e-6, "right frame {i}: got {}, expected {expected_r}", r[i]);
    }

    // A bed shorter than 16 · frames decodes nothing: l and r are unchanged.
    let short = vec![0.5f32; BED_CHANNELS * FRAMES - 1];
    let mut l = prefill_l.clone();
    let mut r = prefill_r.clone();
    decode_add(&short, FRAMES, &mut l, &mut r);
    assert_eq!(l, prefill_l, "left changed for a short bed");
    assert_eq!(r, prefill_r, "right changed for a short bed");
}
