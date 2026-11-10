//! The master peak limiter (api-and-models §5 "written here: `limiter`"; §8 "limiter at or below
//! 0 dBFS"). Written for Myco (A2.8), not a port.
//!
//! `audio-core` runs one [`Limiter`] on the final stereo output, after the MASTER gain ramp
//! (`bus::mixdown`). It is a safety stage: it exists so summed voices never leave the core above
//! full scale, where the browser would hard-clip them, not to make the mix louder.
//!
//! **Design choices**
//! - **Ceiling** [`CEILING`]: 0 dBFS sample peak (1.0), the §8 gate exactly. Every signal that is
//!   within full scale (a normalised clip at gain 1, a full-scale tone, the core's DC test clips)
//!   passes untouched; the limiter acts only where the output would otherwise be clipped at the
//!   destination. A ceiling just under full scale (−0.3 dBFS was measured) would leave room for
//!   inter-sample overs in a later resampler, but it also limits a single normalised voice and
//!   changes renders that never clipped; a true-peak (oversampled) detector is a later choice.
//!   After the gain the output is clamped to ±`CEILING`, so float rounding in `CEILING / peak` can't
//!   leave a sample one ulp over.
//! - **Zero latency, instant attack.** The gain a frame needs is computed from that frame
//!   (`CEILING / peak`) and applied to it, so the ceiling holds exactly with no look-ahead. A
//!   look-ahead limiter (1–1.5 ms of delay, the gain ramped down before the peak arrives) distorts
//!   transients less, but its constant delay would shift every sound the core plays: the exact
//!   SHA-256 goldens, the Web Audio parity nulls (aligned at the frame) and every sample-exact
//!   native test would move whether or not anything was limited. Here, **while nothing exceeds the
//!   ceiling the limiter is a bit-exact bypass** (no delay, gain exactly 1, the quantum isn't even
//!   written), so only renders that really go over full scale change. The cost: the first
//!   overshooting half-cycle of a sound is shaped while the gain falls with the rising waveform;
//!   after that the gain is held.
//! - **Stereo link**: one gain for both channels from `max(|L|, |R|)`, so limiting never moves the
//!   stereo image.
//! - **Hold** [`HOLD_S`] (10 ms): after the gain falls it is held before it releases. That spans
//!   the gap between the peaks of anything at 50 Hz or above, so a sustained loud tone gets one
//!   steady gain rather than a gain that sags between peaks and drops again at each one (which
//!   would be distortion at the tone's own frequency).
//! - **Release** [`RELEASE_S`] (60 ms time constant): the gain reduction decays exponentially
//!   toward none. Under [`SNAP`] (gain within 0.0001 dB of 1) it is set to exactly 0, so the
//!   limiter returns to the bit-exact bypass and its state never goes subnormal. From 6 dB of
//!   reduction it is back within 0.1 dB about 10 + 3.8 × 60 ≈ 240 ms after the last peak.
//! - **Tiny overs** (a reduction under [`SNAP`], a peak under about 1.00001) are only clamped:
//!   starting a 10 ms hold for a −100 dB correction would change many samples to fix one.
//! - **Per rate**: hold frames and the release factor are computed from the sample rate in
//!   [`Limiter::configure`] (`libm::expf`, so native and wasm agree). The state is four scalars and
//!   no buffer, so its size doesn't depend on the rate.
//!
//! Contract (`audio-core` relies on it): `#[repr(C)]` and **all-zero valid** (no gain reduction;
//! an unconfigured limiter still holds the ceiling, it just releases at once); nothing allocates;
//! [`Limiter::reset`] returns to bypass and keeps the rate.

/// The ceiling: 0 dBFS sample peak.
pub const CEILING: f32 = 1.0;
/// How long the gain is held after it falls, seconds.
pub const HOLD_S: f32 = 0.010;
/// The release time constant, seconds: the reduction falls to 1/e of itself in this time.
pub const RELEASE_S: f32 = 0.060;
/// A gain reduction (`1 - gain`) under this is none: the release snaps to 0 below it, and a frame
/// that needs less is only clamped.
pub const SNAP: f32 = 1.0e-5;

/// A stereo-linked, zero-latency peak limiter. All-zero is valid (bypass, unconfigured).
#[repr(C)]
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Limiter {
    /// The gain reduction `1 - gain` now; 0 when bypassed.
    pub reduction: f32,
    /// Frames the current reduction is still held.
    pub hold: u32,
    /// [`HOLD_S`] in frames at the configured rate.
    pub hold_frames: u32,
    /// Per-frame release factor on `reduction`, `exp(-1 / (RELEASE_S * rate))`.
    pub release: f32,
}

impl Limiter {
    /// A bypassed limiter for `sample_rate`.
    pub fn new(sample_rate: f32) -> Limiter {
        let mut l = Limiter::default();
        l.configure(sample_rate);
        l
    }

    /// Sets the hold and release for `sample_rate` (48 kHz if it isn't a positive number); keeps
    /// the current reduction.
    pub fn configure(&mut self, sample_rate: f32) {
        let rate = if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        self.hold_frames = libm::roundf(HOLD_S * rate) as u32;
        self.release = libm::expf(-1.0 / (RELEASE_S * rate));
    }

    /// Back to bypass (no reduction, no hold); the rate stays.
    pub fn reset(&mut self) {
        self.reduction = 0.0;
        self.hold = 0;
    }

    /// The current gain, `1 - reduction`.
    pub fn gain(&self) -> f32 {
        1.0 - self.reduction
    }

    /// `true` while no gain reduction is applied (a quantum under the ceiling passes untouched).
    pub fn is_bypassed(&self) -> bool {
        self.reduction == 0.0
    }

    /// Limits `l` and `r` (the same length; the shorter one bounds it) in place. Returns `true`
    /// when any frame was changed (a gain under 1, a clamp, a NaN silenced). When the limiter is
    /// bypassed and no sample exceeds [`CEILING`] the buffers aren't written. Never allocates.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> bool {
        let n = l.len().min(r.len());
        let (l, r) = (&mut l[..n], &mut r[..n]);
        if self.reduction == 0.0 {
            // The bypass check; `!(|x| <= CEILING)` is also true for NaN.
            if l.iter().chain(r.iter()).all(|x| x.abs() <= CEILING) {
                return false;
            }
        }
        let mut changed = false;
        for i in 0..n {
            let (a, b) = (l[i], r[i]);
            // NaN on a channel compares false, so it adds no reduction; the clamp silences it.
            let peak = if a.abs() > b.abs() { a.abs() } else { b.abs() };
            let need = if peak > CEILING { 1.0 - CEILING / peak } else { 0.0 };
            if need >= SNAP && need >= self.reduction {
                self.reduction = need;
                self.hold = self.hold_frames;
            } else if self.hold > 0 {
                self.hold -= 1;
            } else if self.reduction > 0.0 {
                self.reduction *= self.release;
                if self.reduction < SNAP {
                    self.reduction = 0.0;
                }
            }
            // With no reduction `g` is exactly 1 and the clamp is the identity under the ceiling,
            // so a frame that needs nothing comes out bit-exact.
            let g = 1.0 - self.reduction;
            l[i] = clamp(a * g);
            r[i] = clamp(b * g);
            changed |= l[i].to_bits() != a.to_bits() || r[i].to_bits() != b.to_bits();
        }
        changed
    }
}

/// Clamps to ±[`CEILING`]; NaN becomes 0.
fn clamp(x: f32) -> f32 {
    if x.is_nan() {
        0.0
    } else {
        x.clamp(-CEILING, CEILING)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const RATES: [f32; 3] = [44_100.0, 48_000.0, 96_000.0];
    const Q: usize = 128;

    /// Runs `l`, `r` through a fresh limiter at `rate` in 128-frame quanta, as the core does.
    fn run(rate: f32, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>, Limiter) {
        let mut lim = Limiter::new(rate);
        let (mut ol, mut or) = (l.to_vec(), r.to_vec());
        for (cl, cr) in ol.chunks_mut(Q).zip(or.chunks_mut(Q)) {
            lim.process(cl, cr);
        }
        (ol, or, lim)
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0f32, |a, v| a.max(v.abs()))
    }

    fn sine(rate: f32, hz: f32, amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / rate)).collect()
    }

    #[test]
    fn all_zero_is_bypass_and_still_holds_the_ceiling() {
        // SAFETY: all-zero is valid (the contract above).
        let mut z: Limiter = unsafe { core::mem::zeroed() };
        assert!(z.is_bypassed());
        assert_eq!(z.gain(), 1.0);
        let (mut l, mut r) = ([0.5, 3.0, 0.5, 0.5], [0.5; 4]);
        assert!(z.process(&mut l, &mut r));
        assert!(peak(&l) <= CEILING && peak(&r) <= CEILING, "{l:?} {r:?}");
    }

    #[test]
    fn the_ceiling_holds_on_impulses_at_every_rate() {
        for rate in RATES {
            let n = rate as usize / 2;
            let mut l = vec![0.0f32; n];
            let mut r = vec![0.0f32; n];
            // Single-sample impulses of rising height, both polarities, at odd offsets.
            for (k, at) in (101..n).step_by(4_999).enumerate() {
                let h = 1.0 + k as f32 * 0.75;
                l[at] = if k % 2 == 0 { h } else { -h };
                r[at + 1] = -h * 0.5;
            }
            let (ol, or, _) = run(rate, &l, &r);
            assert!(peak(&ol) <= CEILING && peak(&or) <= CEILING, "{rate}: {} {}", peak(&ol), peak(&or));
            // An impulse is reduced exactly to the ceiling.
            assert_eq!(ol[101], CEILING, "{rate}");
        }
    }

    #[test]
    fn the_ceiling_holds_on_square_waves_and_summed_voices_at_every_rate() {
        for rate in RATES {
            let n = rate as usize; // 1 s
            // A +12 dBFS square at 100 Hz.
            let period = (rate / 100.0) as usize;
            let sq: Vec<f32> = (0..n).map(|i| if (i / (period / 2)) % 2 == 0 { 4.0 } else { -4.0 }).collect();
            let (ol, or, _) = run(rate, &sq, &sq);
            assert!(peak(&ol) <= CEILING && peak(&or) <= CEILING, "square at {rate}");
            // After the first edge the held gain makes the square exactly the ceiling.
            assert!(ol[n / 2..].iter().all(|x| x.abs() == CEILING), "square settles at the ceiling at {rate}");
            // Four full-scale tones summed (as four voices on the root): up to +12 dBFS.
            let tones: Vec<Vec<f32>> = [220.0, 331.0, 440.0, 997.0].iter().map(|hz| sine(rate, *hz, 1.0, n)).collect();
            let sum: Vec<f32> = (0..n).map(|i| tones.iter().map(|t| t[i]).sum()).collect();
            let other: Vec<f32> = sum.iter().map(|x| -0.7 * x).collect();
            let (ol, or, _) = run(rate, &sum, &other);
            assert!(peak(&sum) > 3.0, "the sum really goes over: {}", peak(&sum));
            assert!(peak(&ol) <= CEILING && peak(&or) <= CEILING, "summed tones at {rate}");
        }
    }

    #[test]
    fn under_the_ceiling_the_output_is_the_input_bit_for_bit() {
        for rate in RATES {
            let l = sine(rate, 440.0, 1.0, 4_096); // full scale exactly passes too
            let r = sine(rate, 1_000.0, 0.999, 4_096);
            let (ol, or, lim) = run(rate, &l, &r);
            assert_eq!(ol, l, "{rate}");
            assert_eq!(or, r, "{rate}");
            assert!(lim.is_bypassed());
        }
    }

    #[test]
    fn it_returns_to_a_bit_exact_bypass_after_the_release() {
        let rate = 48_000.0;
        let mut l = sine(rate, 440.0, 0.5, 48_000);
        l[1_000] = 2.0; // one 6 dB over
        let (ol, _, lim) = run(rate, &l, &l.clone());
        assert!(lim.is_bypassed());
        // The hold (480 frames) then about ln(0.5 / 1e-5) * 60 ms ≈ 650 ms of release: bit-exact again
        // from there on.
        let back = 1_000 + 480 + (libm::logf(0.5 / SNAP) * RELEASE_S * rate) as usize;
        let first = (0..l.len()).rev().find(|&i| ol[i] != l[i]).map_or(0, |i| i + 1);
        assert!(first.abs_diff(back) <= 8, "bit-exact from frame {first} (expected about {back})");
        assert!(ol[1_200] != l[1_200], "still held a little after the peak");
    }

    #[test]
    fn hold_then_release_at_the_documented_time_constant() {
        for rate in RATES {
            let mut lim = Limiter::new(rate);
            assert_eq!(lim.hold_frames, libm::roundf(HOLD_S * rate) as u32);
            // One frame at 2.0 (6 dB over), then silence: the gain is 0.5 for the hold, then the
            // reduction decays by 1/e per RELEASE_S.
            let (mut l, mut r) = ([2.0f32], [0.0f32]);
            lim.process(&mut l, &mut r);
            assert_eq!(lim.reduction, 0.5);
            let zeros = |lim: &mut Limiter, frames: usize| {
                let mut z = vec![0.0f32; frames];
                let mut z2 = z.clone();
                // Silence never trips the bypass while a reduction is pending.
                lim.process(&mut z, &mut z2);
            };
            let hold = lim.hold_frames as usize;
            zeros(&mut lim, hold);
            assert_eq!(lim.reduction, 0.5, "held at {rate}");
            let tau = (RELEASE_S * rate) as usize;
            zeros(&mut lim, tau);
            let ratio = lim.reduction / 0.5;
            assert!((ratio - (-1.0f32).exp()).abs() < 1e-3, "one time constant at {rate}: {ratio}");
            // Within 0.1 dB of unity about 240 ms after the peak (the module doc's figure).
            zeros(&mut lim, (0.240 * rate) as usize - tau - hold);
            let db = 20.0 * libm::log10f(lim.gain());
            assert!(db > -0.1 && db < -0.08, "{db} dB at 240 ms, {rate}");
        }
    }

    #[test]
    fn the_gain_is_linked_across_channels() {
        let rate = 48_000.0;
        // Left goes 6 dB over; right is quiet. Both get the same gain.
        let mut l = vec![0.25f32; 512];
        let mut r = vec![0.25f32; 512];
        l[100] = 2.0;
        let (ol, or, _) = run(rate, &l, &r);
        assert_eq!(ol[100], CEILING);
        assert_eq!(or[100], 0.125, "right reduced by the same 6 dB");
        for i in 101..512 {
            assert_eq!(ol[i], or[i], "frame {i}: same gain on equal input");
        }
        r[100] = -2.0; // a right-only over the other way
        l[100] = 0.25;
        let (ol, or, _) = run(rate, &l, &r);
        assert_eq!((ol[100], or[100]), (0.125, -CEILING));
    }

    #[test]
    fn the_state_never_goes_subnormal() {
        for rate in RATES {
            let mut lim = Limiter::new(rate);
            let (mut l, mut r) = ([1.0e6f32], [0.0f32]);
            lim.process(&mut l, &mut r);
            for _ in 0..(5.0 * rate) as usize / Q {
                let (mut l, mut r) = ([1.0e-30f32; Q], [0.0f32; Q]);
                lim.process(&mut l, &mut r);
                assert!(lim.reduction == 0.0 || lim.reduction >= SNAP, "{}", lim.reduction);
                assert!(l.iter().all(|x| *x == 0.0 || x.is_normal()) || lim.is_bypassed());
            }
            assert!(lim.is_bypassed(), "released at {rate}");
        }
    }

    #[test]
    fn tiny_overs_are_only_clamped() {
        let mut lim = Limiter::new(48_000.0);
        let (mut l, mut r) = ([0.5, 1.000_001, 0.5], [0.5; 3]);
        assert!(lim.process(&mut l, &mut r));
        assert_eq!(l, [0.5, 1.0, 0.5]);
        assert!(lim.is_bypassed());
    }

    #[test]
    fn nan_and_infinity_are_silenced_and_the_rest_stays_in_range() {
        let mut lim = Limiter::new(48_000.0);
        let mut l = [0.5, f32::NAN, 0.5, f32::INFINITY, 0.5];
        let mut r = [0.5; 5];
        lim.process(&mut l, &mut r);
        assert!(l.iter().chain(&r).all(|x| x.is_finite() && x.abs() <= CEILING), "{l:?} {r:?}");
        assert_eq!(l[1], 0.0);
    }

    #[test]
    fn reset_returns_to_bypass_and_keeps_the_rate() {
        let mut lim = Limiter::new(96_000.0);
        let (mut l, mut r) = ([4.0f32], [0.0f32]);
        lim.process(&mut l, &mut r);
        assert!(!lim.is_bypassed());
        lim.reset();
        assert_eq!(lim, Limiter::new(96_000.0));
    }
}
