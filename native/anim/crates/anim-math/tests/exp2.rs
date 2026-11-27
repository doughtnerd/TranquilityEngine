//! `trig::exp2` against f64 (moved from the former `tests/ease.rs` with the easings, ADR 0424 spike).

use anim_math::trig::exp2;

#[test]
fn exp2_matches_f64() {
    let mut x = -30.0f32;
    while x <= 10.0 {
        let want = 2f64.powf(x as f64);
        let got = exp2(x) as f64;
        assert!(((got - want) / want).abs() < 2e-7, "2^{x}: {got} vs {want}");
        x += 0.037;
    }
    assert_eq!(exp2(0.0), 1.0);
    assert_eq!(exp2(3.0), 8.0);
    assert_eq!(exp2(-2.0), 0.25);
}
