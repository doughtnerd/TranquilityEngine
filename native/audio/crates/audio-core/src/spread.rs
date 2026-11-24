//! Per-voice spread (ADR 0347; SET_VOICE_FX `spread`, ABI 4.11): a positioned voice heard as an
//! arc of sound rather than a point. 0° is a point source (the panner alone, M3's path bit for bit),
//! 360° surrounds the listener.
//!
//! **Model.** A source spread over an arc of `s` degrees centred on its direction is two parts whose
//! powers add to the voice's:
//! - the **point** part, weight `√(1 − w)` with `w = s / 360`: the voice's samples go on to its panner
//!   as before (equal-power, HRTF or the bed), so the arc keeps its centre's direction;
//! - the **diffuse** part, weight `√w`: the arc's uncorrelated sources. The voice is decorrelated
//!   (`audio_dsp::decorrelate`: two all-pass cascades, one an ear, same spectrum, unrelated phase)
//!   and added straight into the voice's output (its bus or its submix, where the panner and a
//!   bed's decode put theirs), split between the ears by the arc's mean equal-power gains: with the
//!   equal-power law `gR² = (1 + sin az) / 2` (Blink's, the panner's), the mean over the arc
//!   `θ ± s/2` is `pR = (1 + sin θ · sinc(s/2)) / 2` and `pL = 1 − pR` (a narrow arc pans with its
//!   centre; a full circle splits evenly).
//! - A **mono** voice's diffuse part is `√(w pL) · Dₗ(x)` left and `√(w pR) · Dᵣ(x)` right. A
//!   **stereo** voice keeps its image: its left channel feeds the left ear's decorrelator and its
//!   right the right's, at `√(2 w pL)` and `√(2 w pR)` (at a centred arc, unity: a wide stereo
//!   source plays its own stereo image around the listener, decorrelated).
//!
//! So the interaural correlation of a centred voice falls from 1 (a point) towards 0 (360°) as the
//! spread grows, and its power stays the same. Industry spread (Wwise, FMOD, Unreal) widens a source
//! over the speaker arc the same way; on two ears a pure amplitude spread can't decorrelate a mono
//! source, hence the all-pass pair, as Unreal's and Resonance's diffuse rendering do.
//!
//! **Ramps.** The spread ramps over SET_VOICE_FX's `rampFrames` (a silent voice jumps). The three
//! gains are worked out at the end of each rendered range (from the spread then and the direction
//! the panner holds) and ramp linearly from the ones the last range ended on, so neither a spread
//! change nor a direction change clicks. A voice with its spread settled at 0 and its gains at
//! `[1, 0, 0]` is untouched; when the diffuse gains reach 0 the decorrelator is cleared. A voice
//! without a pool entry (none was free) plays as a point source. Non-spatial and ambisonic voices
//! never get here.

use crate::fxpool::FxEntry;
use crate::panner::PannerState;

/// The point, diffuse-left and diffuse-right gains for a spread of `deg` degrees (clamped to
/// 0..360) at azimuth `az_deg` (the panner's, -180..180, +90 right), for a mono or `stereo` voice.
pub fn gains(deg: f32, az_deg: f32, stereo: bool) -> [f32; 3] {
    let s = if deg.is_finite() { deg.clamp(0.0, 360.0) } else { 0.0 };
    if s <= 0.0 {
        return [1.0, 0.0, 0.0];
    }
    let w = s / 360.0;
    let half = s.to_radians() * 0.5;
    let sinc = libm::sinf(half) / half;
    let p_r = (0.5 + 0.5 * libm::sinf(az_deg.to_radians()) * sinc).clamp(0.0, 1.0);
    let p_l = 1.0 - p_r;
    let k = if stereo { 2.0 } else { 1.0 };
    [libm::sqrtf(1.0 - w), libm::sqrtf(k * w * p_l), libm::sqrtf(k * w * p_r)]
}

/// Spreads one rendered range of a spatial voice (see the module comment): `l`/`r` (the voice's
/// samples, a mono voice's copied into both) are scaled to the point part in place for the panner
/// that follows, and the diffuse part is added into `out_l`/`out_r` (the panner's output, already
/// offset to the range). Nothing happens for a point source.
pub fn apply(entry: &mut FxEntry, panner: &PannerState, l: &mut [f32], r: &mut [f32], out_l: &mut [f32], out_r: &mut [f32]) {
    if panner.spatial == 0 {
        return;
    }
    let n = l.len();
    let [p0, l0, r0] = entry.spread_gains;
    if entry.spread.is_settled() && entry.spread.value == 0.0 && p0 == 1.0 && l0 == 0.0 && r0 == 0.0 {
        return;
    }
    entry.spread.advance(n as u32);
    let stereo = panner.channels >= 2;
    let az = crate::panner::azimuth(panner.dir) as f32;
    let [p1, l1, r1] = gains(entry.spread.value, az, stereo);
    if !entry.decor.is_finite() {
        entry.decor.clear();
    }
    let inv = 1.0 / n.max(1) as f32;
    let (r, out_l, out_r) = (&mut r[..n], &mut out_l[..n], &mut out_r[..n]);
    for i in 0..n {
        let t = (i + 1) as f32 * inv;
        let (gp, gl, gr) = (p0 + (p1 - p0) * t, l0 + (l1 - l0) * t, r0 + (r1 - r0) * t);
        let (x_l, x_r) = (l[i], if stereo { r[i] } else { l[i] });
        out_l[i] += gl * entry.decor.left(x_l);
        out_r[i] += gr * entry.decor.right(x_r);
        l[i] = x_l * gp;
        r[i] *= gp;
    }
    entry.decor.flush_denormals();
    entry.spread_gains = [p1, l1, r1];
    if l1 == 0.0 && r1 == 0.0 {
        // A point source again: the decorrelator starts from silence next time.
        entry.decor.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_point_is_the_panner_alone_and_power_is_kept() {
        assert_eq!(gains(0.0, 30.0, false), [1.0, 0.0, 0.0]);
        assert_eq!(gains(f32::NAN, 30.0, true), [1.0, 0.0, 0.0]);
        for deg in [10.0f32, 90.0, 180.0, 270.0, 360.0, 500.0] {
            for az in [-90.0f32, -30.0, 0.0, 45.0, 120.0] {
                let [p, l, r] = gains(deg, az, false);
                assert!((p * p + l * l + r * r - 1.0).abs() < 1e-5, "mono {deg} {az}");
                let [p, l, r] = gains(deg, az, true);
                // Stereo: each ear carries one channel, so the power of a channel pair is p² + (l² + r²)/2.
                assert!((p * p + 0.5 * (l * l + r * r) - 1.0).abs() < 1e-5, "stereo {deg} {az}");
            }
        }
    }

    #[test]
    fn a_full_circle_is_all_diffuse_and_even_and_a_narrow_arc_pans_with_its_centre() {
        let [p, l, r] = gains(360.0, 90.0, false);
        assert!(p.abs() < 1e-6 && (l - r).abs() < 1e-3, "{p} {l} {r}");
        // 20 degrees to the right: the diffuse part leans right as the panner's gains would.
        let [_, l, r] = gains(20.0, 90.0, false);
        assert!(r > 5.0 * l, "{l} {r}");
    }
}
