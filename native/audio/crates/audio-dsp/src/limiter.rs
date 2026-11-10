//! The master peak limiter (api-and-models §5 "written here: `limiter`"; §8 "limiter at or below
//! 0 dBFS"). Written for Myco (A2.8, look-ahead A2.9), not a port.
//!
//! `audio-core` runs one [`Limiter`] on the final stereo output, after the MASTER gain ramp
//! (`bus::mixdown`). It is a safety stage: it exists so summed voices never leave the core above
//! full scale, where the browser would hard-clip them, not to make the mix louder.
//!
//! **Design choices**
//! - **Ceiling** [`CEILING`]: 0 dBFS sample peak (1.0), the §8 gate exactly. Every signal that is
//!   within full scale (a normalised clip at gain 1, a full-scale tone, the core's DC test clips)
//!   passes untouched (only delayed); the limiter acts only where the output would otherwise be
//!   clipped at the destination. A ceiling just under full scale would leave room for inter-sample
//!   overs in a later resampler, but it also limits a single normalised voice: tried at −0.3 dBFS
//!   (A2.8), it changed a third golden (`pitch-up`, one voice peaking at 0.997) and 13 more native
//!   tests that play a full-scale clip alone. A true-peak (oversampled) detector is a later choice.
//!   After the gain the output is clamped to ±`CEILING`, so float rounding can't leave a sample one
//!   ulp over.
//! - **Look-ahead** (A2.9, the owner's 2026-11-10 decisions): a fixed delay, set in milliseconds by
//!   the project setting `audio.limiterLookaheadMs` (default [`DEFAULT_LOOKAHEAD_MS`] = 1.5, range
//!   0 to [`MAX_LOOKAHEAD_MS`] = 5) when the core starts, never while it runs. [`latency_frames`]
//!   turns it into whole frames, `round(ms · rate / 1000)`: at 1.5 ms **72 frames at 48 kHz**, 66 at
//!   44.1 kHz, 144 at 96 kHz. The time, not the frame count, stays the same across rates, so the
//!   attack sounds the same. The delay line holds [`MAX_LATENCY_FRAMES`] = 480 frames, 5 ms at
//!   96 kHz (the highest rate the project targets); at a higher context rate the latency is capped
//!   there (2.5 ms at 192 kHz). The delay is **always** in the path, limiting or not: a constant
//!   latency, so the clock map adds one number and nothing moves in time when a sound starts or
//!   stops going over. Under the ceiling the output is the input delayed, bit for bit.
//! - **0 ms is A2.8, bit for bit**: zero latency and an instant attack (each frame gets
//!   `CEILING / peak` itself), with A2.8's bypass that doesn't even write a quantum under the
//!   ceiling. It is kept as its own path ([`Limiter::process`] takes it when the latency is 0
//!   frames) for a project that wants no added latency and accepts that the first overshooting
//!   half-cycle of a sound is shaped while the gain falls with the rising waveform.
//! - **Attack (look-ahead above 0): a sliding-window maximum, then a box filter.** Per input frame `n` the gain
//!   reduction the frame needs is `need = 1 − CEILING / max(|L|, |R|)`. (1) `w[n]` is the maximum
//!   of `need` over the last `D + 1` frames (`D` the latency; a monotonic deque, amortised O(1) per
//!   frame, fixed capacity). (2) The envelope `r[n]` follows `w` up at once and is held and released
//!   as A2.8 did (below), and never falls under `w`. (3) The gain applied to the delayed frame
//!   `x[n − D]` is `1 − mean(r[n − D ..= n])`, a moving average over the same `D + 1` frames. Why
//!   this holds the ceiling exactly: frame `n − D` is inside the max window of every `r[k]` in that
//!   average, so each `r[k] ≥ need[n − D]` and so is their mean; the gain is at most what the frame
//!   needs, and the clamp catches rounding. Why it doesn't distort: a step in `r` comes out of the
//!   box filter as a straight ramp over `D + 1` frames that ends exactly as the peak reaches the
//!   output, so the gain glides down across the 1.5 ms before an over instead of falling with the
//!   waveform's rising edge (A2.8's instant attack clipped the first overshooting half-cycle flat).
//!   Alternatives: an exponential attack smoother never quite reaches its target, so the ceiling
//!   would hold only with an extra margin or a clamp that clips; a min-filter over the window
//!   followed by a second min-filter (or cascaded boxes) is smoother still but costs a second deque
//!   and more delay for the same guarantee. The box needs no division per frame: the mean is a
//!   running sum, kept in **integers** (`r` is an `f32` ≥ `SNAP` > 2⁻¹⁷, so `r · 2⁴⁰` is an exact
//!   `u64` and `(D + 1) · 2⁴⁰` is far under 2⁵³), so it never drifts however long the limiter works, is
//!   exactly 0 once the window is clear, and a held reduction gives exactly A2.8's gain `1 − r`.
//! - **Stereo link**: one gain for both channels from `max(|L|, |R|)`, so limiting never moves the
//!   stereo image.
//! - **Hold** [`HOLD_S`] (10 ms): after the gain falls it is held before it releases. That spans
//!   the gap between the peaks of anything at 50 Hz or above, so a sustained loud tone gets one
//!   steady gain rather than a gain that sags between peaks and drops again at each one (which
//!   would be distortion at the tone's own frequency). The hold restarts while the window maximum
//!   still asks for the held reduction, so it counts from the moment the peak leaves the window,
//!   about when it reaches the output.
//! - **Release** [`RELEASE_S`] (60 ms time constant): the gain reduction decays exponentially
//!   toward none (then the box filter averages it over 1.5 ms more). Under [`SNAP`] (gain within
//!   0.0001 dB of 1) it is set to exactly 0, so the limiter returns to its pass-through and its
//!   state never goes subnormal. From 6 dB of reduction it is back within 0.1 dB about
//!   10 + 3.8 × 60 ≈ 240 ms after the last peak is heard.
//! - **Tiny overs** (a reduction under [`SNAP`], a peak under about 1.00001) are only clamped:
//!   starting a 10 ms hold for a −100 dB correction would change many samples to fix one.
//! - **Per rate**: the latency, hold frames and release factor are computed from the sample rate in
//!   [`Limiter::configure`] (`libm::expf`, so native and wasm agree).
//! - **Cost**: while nothing is limited (no reduction pending and the quantum is under the
//!   ceiling) a quantum only goes through the delay line; the per-frame path runs while limiting.
//!
//! Contract (`audio-core` relies on it): `#[repr(C)]` and **all-zero valid** (no gain reduction,
//! latency 0: an unconfigured limiter still holds the ceiling, with A2.8's instant attack, and
//! releases at once); nothing allocates; the whole state is inline (about 11.6 KB, in `BusArea`);
//! [`Limiter::reset`] clears the delay line and the gain reduction and keeps the rate.

/// The ceiling: 0 dBFS sample peak.
pub const CEILING: f32 = 1.0;
/// How long the gain is held after it falls, seconds.
pub const HOLD_S: f32 = 0.010;
/// The release time constant, seconds: the reduction falls to 1/e of itself in this time.
pub const RELEASE_S: f32 = 0.060;
/// A gain reduction (`1 - gain`) under this is none: the release snaps to 0 below it, and a frame
/// that needs less is only clamped.
pub const SNAP: f32 = 1.0e-5;
/// The look-ahead when the project doesn't set one (`audio.limiterLookaheadMs`), ms.
pub const DEFAULT_LOOKAHEAD_MS: f32 = 1.5;
/// The longest look-ahead, ms (the setting's range is 0 to this).
pub const MAX_LOOKAHEAD_MS: f32 = 5.0;
/// The highest rate the delay line holds [`MAX_LOOKAHEAD_MS`] for.
pub const MAX_RATE: u32 = 96_000;
/// The delay line's capacity: [`MAX_LOOKAHEAD_MS`] at [`MAX_RATE`].
pub const MAX_LATENCY_FRAMES: usize = 480;
/// The sliding windows hold `D + 1` frames.
const WINDOW_CAP: usize = MAX_LATENCY_FRAMES + 1;
/// The fixed-point scale of the box filter's running sum: `r · 2⁴⁰` is an exact integer for every
/// `f32` reduction ≥ 2⁻¹⁷ (24 significant bits), and every non-zero reduction is ≥ [`SNAP`].
const FIXED: f64 = (1u64 << 40) as f64;

const _: () = assert!(SNAP as f64 > 1.0 / (1u64 << 17) as f64);
const _: () = assert!(MAX_LOOKAHEAD_MS as usize * MAX_RATE as usize / 1_000 == MAX_LATENCY_FRAMES);

/// A look-ahead setting made valid: clamped to 0..=[`MAX_LOOKAHEAD_MS`]; NaN is the default.
pub fn clamp_lookahead_ms(ms: f32) -> f32 {
    if ms.is_nan() {
        DEFAULT_LOOKAHEAD_MS
    } else {
        ms.clamp(0.0, MAX_LOOKAHEAD_MS)
    }
}

/// The limiter's fixed latency in frames for a look-ahead of `lookahead_ms` at `sample_rate`:
/// `round(ms · rate / 1000)` in `f64` (half away from zero) with the ms clamped by
/// [`clamp_lookahead_ms`], capped at [`MAX_LATENCY_FRAMES`]. The TypeScript mirror
/// (`limiterLatencyFrames`) computes the same from the same `f32` ms. 1.5 ms: 72 at 48 kHz, 66 at
/// 44.1 kHz, 144 at 96 kHz; 0 ms: 0. A rate that isn't a positive number counts as 48 kHz (as
/// [`Limiter::configure`] does).
pub fn latency_frames(sample_rate: f32, lookahead_ms: f32) -> u32 {
    let rate = if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate } else { 48_000.0 };
    let frames = libm::round(clamp_lookahead_ms(lookahead_ms) as f64 * rate as f64 / 1_000.0);
    (frames as u32).min(MAX_LATENCY_FRAMES as u32)
}

/// A stereo-linked peak limiter with a fixed look-ahead. All-zero is valid (unconfigured: latency
/// 0, instant attack).
#[repr(C)]
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Limiter {
    /// The envelope's gain reduction `1 - gain` now (the newest frame's `r`); 0 when none.
    pub reduction: f32,
    /// Frames the current reduction is still held.
    pub hold: u32,
    /// [`HOLD_S`] in frames at the configured rate.
    pub hold_frames: u32,
    /// Per-frame release factor on `reduction`, `exp(-1 / (RELEASE_S * rate))`.
    pub release: f32,
    /// The look-ahead `D` in frames ([`latency_frames`] of the configured rate and ms); 0 is
    /// A2.8's instant attack.
    pub latency: u32,
    /// The next slot in the delay line (`0..latency`).
    delay_pos: u32,
    /// The next slot in the box filter's ring (`0..=latency`).
    box_pos: u32,
    /// The window-maximum deque: its first entry and length, in `peak_need`/`peak_at`.
    deque_head: u32,
    deque_len: u32,
    /// Frames seen, wrapping (the deque's entries are stamped with it).
    frame: u32,
    /// The box filter's running sum of `r · 2⁴⁰` over its ring.
    box_sum: u64,
    /// The box filter's ring: `r · 2⁴⁰` of the last `latency + 1` frames.
    box_ring: [u64; WINDOW_CAP],
    /// The delay line, left and right.
    delay_l: [f32; MAX_LATENCY_FRAMES],
    delay_r: [f32; MAX_LATENCY_FRAMES],
    /// The window-maximum deque (decreasing `need`, increasing frame stamps).
    peak_need: [f32; WINDOW_CAP],
    peak_at: [u32; WINDOW_CAP],
}

impl Default for Limiter {
    fn default() -> Limiter {
        // SAFETY: every field is an integer, a float or an array of them; all-zero is valid.
        unsafe { core::mem::zeroed() }
    }
}

impl Limiter {
    /// A limiter for `sample_rate` with a look-ahead of `lookahead_ms` (0 for A2.8's instant
    /// attack), passing its input through the delay.
    pub fn new(sample_rate: f32, lookahead_ms: f32) -> Limiter {
        let mut l = Limiter::default();
        l.configure(sample_rate, lookahead_ms);
        l
    }

    /// Sets the latency, hold and release for `sample_rate` (48 kHz if it isn't a positive
    /// number) and `lookahead_ms` ([`latency_frames`]). When the latency changes the delay line
    /// and the windows are cleared (as by [`Limiter::reset`]); otherwise the state is kept.
    pub fn configure(&mut self, sample_rate: f32, lookahead_ms: f32) {
        let rate = if sample_rate.is_finite() && sample_rate > 0.0 { sample_rate } else { 48_000.0 };
        self.hold_frames = libm::roundf(HOLD_S * rate) as u32;
        self.release = libm::expf(-1.0 / (RELEASE_S * rate));
        let latency = latency_frames(rate, lookahead_ms);
        if latency != self.latency {
            self.latency = latency;
            self.reset();
        }
    }

    /// Clears the delay line, the windows and the gain reduction (silence comes out for the next
    /// `latency` frames); the rate stays.
    pub fn reset(&mut self) {
        self.reduction = 0.0;
        self.hold = 0;
        self.delay_pos = 0;
        self.box_pos = 0;
        self.deque_head = 0;
        self.deque_len = 0;
        self.frame = 0;
        self.box_sum = 0;
        self.box_ring = [0; WINDOW_CAP];
        self.delay_l = [0.0; MAX_LATENCY_FRAMES];
        self.delay_r = [0.0; MAX_LATENCY_FRAMES];
        self.peak_need = [0.0; WINDOW_CAP];
        self.peak_at = [0; WINDOW_CAP];
    }

    /// The gain applied to the frame leaving the delay now: `1 - mean(r)` over the box window
    /// (exactly 1 when nothing is pending).
    pub fn gain(&self) -> f32 {
        if self.latency == 0 {
            return 1.0 - self.reduction;
        }
        let n = self.latency.min(MAX_LATENCY_FRAMES as u32) as f64 + 1.0;
        (1.0 - self.box_sum as f64 / (n * FIXED)) as f32
    }

    /// `true` while no gain reduction is applied or pending (the delayed input comes out bit for
    /// bit, bar a tiny over's clamp).
    pub fn is_bypassed(&self) -> bool {
        self.reduction == 0.0 && self.box_sum == 0 && self.deque_len == 0
    }

    /// Delays and limits `l` and `r` (the same length; the shorter one bounds it) in place.
    /// Returns `true` when any frame leaving the delay was changed (a gain under 1, a clamp, a NaN
    /// silenced). Never allocates.
    pub fn process(&mut self, l: &mut [f32], r: &mut [f32]) -> bool {
        let n = l.len().min(r.len());
        let (l, r) = (&mut l[..n], &mut r[..n]);
        let d = (self.latency as usize).min(MAX_LATENCY_FRAMES);
        if d == 0 {
            return self.process_instant(l, r);
        }
        if self.is_bypassed() && l.iter().chain(r.iter()).all(|x| x.abs() <= CEILING) {
            // Nothing pending and nothing new to limit (`!(|x| <= CEILING)` is also true for NaN):
            // the delay line only. A tiny over still in the line is clamped on its way out.
            let mut changed = false;
            for i in 0..n {
                let (a, b) = self.delay(d, l[i], r[i]);
                l[i] = clamp(a);
                r[i] = clamp(b);
                changed |= l[i].to_bits() != a.to_bits() || r[i].to_bits() != b.to_bits();
            }
            self.frame = self.frame.wrapping_add(n as u32);
            return changed;
        }
        let window = d as u32 + 1;
        let scale = window as f64 * FIXED;
        let mut changed = false;
        for i in 0..n {
            let (a, b) = (l[i], r[i]);
            let now = self.frame;
            self.frame = now.wrapping_add(1);
            // (1) The window maximum of `need` over the last D + 1 frames. NaN on a channel
            // compares false, so it adds no reduction; the clamp silences it on the way out.
            let peak = if a.abs() > b.abs() { a.abs() } else { b.abs() };
            let need = if peak > CEILING { 1.0 - CEILING / peak } else { 0.0 };
            while self.deque_len > 0 && now.wrapping_sub(self.peak_at[self.deque_head as usize]) >= window {
                self.deque_head = if self.deque_head as usize + 1 == WINDOW_CAP { 0 } else { self.deque_head + 1 };
                self.deque_len -= 1;
            }
            if need >= SNAP {
                while self.deque_len > 0 {
                    let back = (self.deque_head + self.deque_len - 1) as usize % WINDOW_CAP;
                    if self.peak_need[back] > need {
                        break;
                    }
                    self.deque_len -= 1;
                }
                let at = (self.deque_head + self.deque_len) as usize % WINDOW_CAP;
                self.peak_need[at] = need;
                self.peak_at[at] = now;
                self.deque_len += 1;
            }
            let w = if self.deque_len > 0 { self.peak_need[self.deque_head as usize] } else { 0.0 };
            // (2) The envelope: hold, then release; never under the window maximum.
            if self.hold > 0 {
                self.hold -= 1;
            } else if self.reduction > 0.0 {
                self.reduction *= self.release;
                if self.reduction < SNAP {
                    self.reduction = 0.0;
                }
            }
            if w > 0.0 && w >= self.reduction {
                self.reduction = w;
                self.hold = self.hold_frames;
            }
            // (3) The box filter over the last D + 1 envelope values, in exact integers.
            let q = (self.reduction as f64 * FIXED) as u64;
            let slot = self.box_pos as usize;
            self.box_sum = self.box_sum - self.box_ring[slot] + q;
            self.box_ring[slot] = q;
            self.box_pos = if self.box_pos + 1 >= window { 0 } else { self.box_pos + 1 };
            // With nothing in the window `g` is exactly 1 and the clamp is the identity under the
            // ceiling, so a frame that needs nothing comes out bit-exact.
            let g = (1.0 - self.box_sum as f64 / scale) as f32;
            let (ya, yb) = self.delay(d, a, b);
            l[i] = clamp(ya * g);
            r[i] = clamp(yb * g);
            changed |= l[i].to_bits() != ya.to_bits() || r[i].to_bits() != yb.to_bits();
        }
        changed
    }

    /// A2.8's zero-latency limiter, unchanged (the 0 ms setting): the gain a frame needs is computed
    /// from that frame and applied to it; under the ceiling the buffers aren't written.
    fn process_instant(&mut self, l: &mut [f32], r: &mut [f32]) -> bool {
        let n = l.len().min(r.len());
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

    /// Pushes a frame into the delay line of `d` frames and returns the one leaving it.
    #[inline(always)]
    fn delay(&mut self, d: usize, a: f32, b: f32) -> (f32, f32) {
        if d == 0 {
            return (a, b);
        }
        let p = self.delay_pos as usize;
        let out = (self.delay_l[p], self.delay_r[p]);
        self.delay_l[p] = a;
        self.delay_r[p] = b;
        self.delay_pos = if p + 1 >= d { 0 } else { p as u32 + 1 };
        out
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
    /// Off (A2.8), the default and the longest.
    const LOOKAHEADS: [f32; 3] = [0.0, DEFAULT_LOOKAHEAD_MS, MAX_LOOKAHEAD_MS];
    const Q: usize = 128;

    /// Runs `l`, `r` through a fresh limiter at `rate` and `ms` in 128-frame quanta, as the core
    /// does.
    fn run(rate: f32, ms: f32, l: &[f32], r: &[f32]) -> (Vec<f32>, Vec<f32>, Limiter) {
        let mut lim = Limiter::new(rate, ms);
        let (mut ol, mut or) = (l.to_vec(), r.to_vec());
        for (cl, cr) in ol.chunks_mut(Q).zip(or.chunks_mut(Q)) {
            lim.process(cl, cr);
        }
        (ol, or, lim)
    }

    /// `x` delayed by `d` frames (zeros first), the same length.
    fn delayed(x: &[f32], d: usize) -> Vec<f32> {
        let mut y = vec![0.0f32; x.len()];
        y[d..].copy_from_slice(&x[..x.len() - d]);
        y
    }

    fn peak(x: &[f32]) -> f32 {
        x.iter().fold(0.0f32, |a, v| a.max(v.abs()))
    }

    fn sine(rate: f32, hz: f32, amp: f32, n: usize) -> Vec<f32> {
        (0..n).map(|i| amp * libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / rate)).collect()
    }

    #[test]
    fn the_latency_is_the_lookahead_in_whole_frames() {
        assert_eq!(latency_frames(48_000.0, 1.5), 72);
        assert_eq!(latency_frames(44_100.0, 1.5), 66); // 66.15
        assert_eq!(latency_frames(96_000.0, 1.5), 144);
        assert_eq!(latency_frames(48_000.0, 0.0), 0);
        assert_eq!(latency_frames(96_000.0, 5.0), MAX_LATENCY_FRAMES as u32);
        assert_eq!(latency_frames(192_000.0, 5.0), MAX_LATENCY_FRAMES as u32, "capped above 96 kHz");
        assert_eq!(latency_frames(192_000.0, 1.5), 288);
        assert_eq!(latency_frames(48_000.0, 9.0), 240, "clamped to 5 ms");
        assert_eq!(latency_frames(48_000.0, -1.0), 0);
        assert_eq!(latency_frames(48_000.0, f32::NAN), 72, "NaN is the default");
        assert_eq!(latency_frames(f32::NAN, 1.5), 72, "a bad rate counts as 48 kHz");
        assert_eq!(latency_frames(44_100.0, 0.01), 0); // 0.441
        assert_eq!(latency_frames(22_050.0, 1.0), 22); // 22.05
        assert_eq!(Limiter::new(48_000.0, 1.5).latency, 72);
    }

    #[test]
    fn all_zero_is_the_instant_limiter_and_still_holds_the_ceiling() {
        // SAFETY: all-zero is valid (the contract above).
        let mut z: Limiter = unsafe { core::mem::zeroed() };
        assert_eq!(z, Limiter::default());
        assert!(z.is_bypassed());
        assert_eq!(z.gain(), 1.0);
        assert_eq!(z.latency, 0);
        let (mut l, mut r) = ([0.5, 3.0, 0.5, 0.5], [0.5; 4]);
        assert!(z.process(&mut l, &mut r));
        assert!(peak(&l) <= CEILING && peak(&r) <= CEILING, "{l:?} {r:?}");
        assert_eq!(l[1], CEILING, "no delay");
    }

    #[test]
    fn the_ceiling_holds_on_impulses_at_every_rate_and_lookahead() {
        for rate in RATES {
            for ms in LOOKAHEADS {
                let n = rate as usize / 2;
                let d = latency_frames(rate, ms) as usize;
                let mut l = vec![0.0f32; n];
                let mut r = vec![0.0f32; n];
                // Single-sample impulses of rising height, both polarities, at odd offsets.
                for (k, at) in (101..n - d - 2).step_by(4_999).enumerate() {
                    let h = 1.0 + k as f32 * 0.75;
                    l[at] = if k % 2 == 0 { h } else { -h };
                    r[at + 1] = -h * 0.5;
                }
                let (ol, or, _) = run(rate, ms, &l, &r);
                assert!(peak(&ol) <= CEILING && peak(&or) <= CEILING, "{rate} {ms}: {} {}", peak(&ol), peak(&or));
                // The first impulse is exactly full scale and passes; the second (1.75) comes out at
                // the ceiling to within the gain's rounding.
                assert_eq!(ol[101 + d], CEILING, "{rate} {ms}");
                assert!((ol[101 + 4_999 + d].abs() - CEILING).abs() < 1e-6, "{rate} {ms}: {}", ol[101 + 4_999 + d]);
            }
        }
    }

    #[test]
    fn the_ceiling_holds_on_square_waves_and_summed_voices_at_every_rate_and_lookahead() {
        for rate in RATES {
            for ms in LOOKAHEADS {
                let n = rate as usize; // 1 s
                // A +12 dBFS square at 100 Hz.
                let period = (rate / 100.0) as usize;
                let sq: Vec<f32> = (0..n).map(|i| if (i / (period / 2)) % 2 == 0 { 4.0 } else { -4.0 }).collect();
                let (ol, or, _) = run(rate, ms, &sq, &sq);
                assert!(peak(&ol) <= CEILING && peak(&or) <= CEILING, "square at {rate} {ms}");
                // After the first edge the held gain makes the square exactly the ceiling.
                assert!(ol[n / 2..].iter().all(|x| x.abs() == CEILING), "square settles at the ceiling at {rate} {ms}");
                // Four full-scale tones summed (as four voices on the root): up to +12 dBFS.
                let tones: Vec<Vec<f32>> = [220.0, 331.0, 440.0, 997.0].iter().map(|hz| sine(rate, *hz, 1.0, n)).collect();
                let sum: Vec<f32> = (0..n).map(|i| tones.iter().map(|t| t[i]).sum()).collect();
                let other: Vec<f32> = sum.iter().map(|x| -0.7 * x).collect();
                let (ol, or, _) = run(rate, ms, &sum, &other);
                assert!(peak(&sum) > 3.0, "the sum really goes over: {}", peak(&sum));
                assert!(peak(&ol) <= CEILING && peak(&or) <= CEILING, "summed tones at {rate} {ms}");
                assert!(peak(&ol) > 0.99, "and reaches it: {} at {rate} {ms}", peak(&ol));
            }
        }
    }

    #[test]
    fn under_the_ceiling_the_output_is_the_input_delayed_bit_for_bit() {
        for rate in RATES {
            for ms in LOOKAHEADS {
                let d = latency_frames(rate, ms) as usize;
                let l = sine(rate, 440.0, 1.0, 4_096); // full scale exactly passes too
                let r = sine(rate, 1_000.0, 0.999, 4_096);
                let (ol, or, lim) = run(rate, ms, &l, &r);
                assert_eq!(ol, delayed(&l, d), "{rate} {ms}");
                assert_eq!(or, delayed(&r, d), "{rate} {ms}");
                assert!(lim.is_bypassed());
            }
        }
    }

    #[test]
    fn the_delay_is_there_whether_or_not_it_limits() {
        // The same 0.5 click comes out D frames late before, during and after a loud passage.
        let rate = 48_000.0;
        let d = latency_frames(rate, 1.5) as usize;
        let mut l = vec![0.0f32; 60_000];
        l[500] = 0.5;
        for x in &mut l[10_000..10_200] {
            *x = 3.0;
        }
        l[58_000] = 0.5;
        let (ol, _, lim) = run(rate, 1.5, &l, &l.clone());
        assert_eq!(ol[500 + d], 0.5);
        assert!(ol[..500 + d].iter().all(|x| *x == 0.0));
        assert_eq!(ol[10_000 + d], CEILING);
        assert_eq!(ol[58_000 + d], 0.5, "after the release, still D frames late and bit-exact");
        assert!(lim.is_bypassed());
    }

    #[test]
    fn it_returns_to_a_bit_exact_pass_through_after_the_release() {
        let rate = 48_000.0;
        for ms in [0.0, DEFAULT_LOOKAHEAD_MS] {
            let d = latency_frames(rate, ms) as usize;
            let mut l = sine(rate, 440.0, 0.5, 48_000);
            l[1_000] = 2.0; // one 6 dB over
            let (ol, _, lim) = run(rate, ms, &l, &l.clone());
            assert!(lim.is_bypassed());
            let want = delayed(&l, d);
            // The hold (480 frames) then about ln(0.5 / 1e-5) * 60 ms ≈ 650 ms of release: bit-exact
            // again from there on.
            let back = 1_000 + d + 480 + (libm::logf(0.5 / SNAP) * RELEASE_S * rate) as usize;
            let first = (0..l.len()).rev().find(|&i| ol[i] != want[i]).map_or(0, |i| i + 1);
            assert!(first.abs_diff(back) <= 8 + d, "{ms}: bit-exact from frame {first} (expected about {back})");
            assert!(ol[1_200 + d] != want[1_200 + d], "still held a little after the peak");
        }
    }

    #[test]
    fn hold_then_release_at_the_documented_time_constant() {
        for rate in RATES {
            for ms in [0.0, DEFAULT_LOOKAHEAD_MS] {
                let mut lim = Limiter::new(rate, ms);
                let d = lim.latency as usize;
                assert_eq!(lim.hold_frames, libm::roundf(HOLD_S * rate) as u32);
                let zeros = |lim: &mut Limiter, frames: usize| {
                    let mut z = vec![0.0f32; frames];
                    let mut z2 = z.clone();
                    // Silence never trips the bypass while a reduction is pending.
                    lim.process(&mut z, &mut z2);
                };
                // One frame at 2.0 (6 dB over), then silence: the gain reaches 0.5 when the frame
                // leaves the delay, is held, then the reduction decays by 1/e per RELEASE_S.
                let (mut l, mut r) = ([2.0f32], [0.0f32]);
                lim.process(&mut l, &mut r);
                assert_eq!(lim.reduction, 0.5);
                zeros(&mut lim, d);
                assert_eq!(lim.gain(), 0.5, "the full reduction as the peak comes out ({rate} {ms})");
                let hold = lim.hold_frames as usize;
                zeros(&mut lim, hold);
                assert_eq!(lim.reduction, 0.5, "held at {rate} {ms}");
                let tau = (RELEASE_S * rate) as usize;
                zeros(&mut lim, tau);
                let ratio = lim.reduction / 0.5;
                assert!((ratio - (-1.0f32).exp()).abs() < 1e-3, "one time constant at {rate} {ms}: {ratio}");
                // Within 0.1 dB of unity about 240 ms after the peak is heard (the module doc's figure).
                zeros(&mut lim, (0.240 * rate) as usize - tau - hold);
                let db = 20.0 * libm::log10f(lim.gain());
                assert!(db > -0.105 && db < -0.08, "{db} dB at 240 ms, {rate} {ms}");
            }
        }
    }

    #[test]
    fn the_gain_is_linked_across_channels() {
        let rate = 48_000.0;
        for ms in [0.0, DEFAULT_LOOKAHEAD_MS] {
            let d = latency_frames(rate, ms) as usize;
            // Left goes 6 dB over; right is quiet. Both get the same gain.
            let mut l = vec![0.25f32; 1_024];
            let mut r = vec![0.25f32; 1_024];
            l[400] = 2.0;
            let (ol, or, _) = run(rate, ms, &l, &r);
            assert_eq!(ol[400 + d], CEILING);
            assert_eq!(or[400 + d], 0.125, "right reduced by the same 6 dB");
            for i in d..1_024 {
                if i != 400 + d {
                    assert_eq!(ol[i], or[i], "frame {i}: same gain on equal input");
                }
            }
            r[400] = -2.0; // a right-only over the other way
            l[400] = 0.25;
            let (ol, or, _) = run(rate, ms, &l, &r);
            assert_eq!((ol[400 + d], or[400 + d]), (0.125, -CEILING));
        }
    }

    #[test]
    fn the_state_never_goes_subnormal() {
        for rate in RATES {
            for ms in [0.0, DEFAULT_LOOKAHEAD_MS] {
                let mut lim = Limiter::new(rate, ms);
                let (mut l, mut r) = ([1.0e6f32], [0.0f32]);
                lim.process(&mut l, &mut r);
                for _ in 0..(5.0 * rate) as usize / Q {
                    let (mut l, mut r) = ([1.0e-30f32; Q], [0.0f32; Q]);
                    lim.process(&mut l, &mut r);
                    assert!(lim.reduction == 0.0 || lim.reduction >= SNAP, "{}", lim.reduction);
                    assert!(l.iter().all(|x| *x == 0.0 || x.is_normal()) || lim.is_bypassed());
                }
                assert!(lim.is_bypassed(), "released at {rate} {ms}");
            }
        }
    }

    #[test]
    fn tiny_overs_are_only_clamped() {
        for ms in [0.0, DEFAULT_LOOKAHEAD_MS] {
            let mut lim = Limiter::new(48_000.0, ms);
            let d = lim.latency as usize;
            let mut l = vec![0.5f32; Q];
            let mut r = vec![0.5f32; Q];
            l[1] = 1.000_001;
            assert!(lim.process(&mut l, &mut r), "the clamp changed a frame (D < 128 frames: in this quantum)");
            let (mut l2, mut r2) = (vec![0.5f32; Q], vec![0.5f32; Q]);
            lim.process(&mut l2, &mut r2);
            let out: Vec<f32> = l.iter().chain(&l2).copied().collect();
            assert_eq!(out[1 + d], 1.0);
            assert!(out[d..].iter().enumerate().all(|(i, x)| i == 1 || *x == 0.5), "nothing else changes");
            assert!(lim.is_bypassed());
        }
    }

    #[test]
    fn nan_and_infinity_are_silenced_and_the_rest_stays_in_range() {
        for ms in [0.0, DEFAULT_LOOKAHEAD_MS] {
            let mut lim = Limiter::new(48_000.0, ms);
            let d = lim.latency as usize;
            let mut l = vec![0.5f32; 4 * Q];
            let mut r = vec![0.5f32; 4 * Q];
            l[1] = f32::NAN;
            l[3] = f32::INFINITY;
            r[200] = f32::NEG_INFINITY;
            for (cl, cr) in l.chunks_mut(Q).zip(r.chunks_mut(Q)) {
                lim.process(cl, cr);
            }
            assert!(l.iter().chain(&r).all(|x| x.is_finite() && x.abs() <= CEILING), "{ms}");
            assert_eq!(l[1 + d], 0.0);
            assert_eq!(l[3 + d], 0.0);
        }
    }

    #[test]
    fn reset_clears_the_delay_and_the_reduction_and_keeps_the_rate() {
        for ms in [0.0, DEFAULT_LOOKAHEAD_MS] {
            let mut lim = Limiter::new(96_000.0, ms);
            let (mut l, mut r) = ([4.0f32; 8], [0.0f32; 8]);
            lim.process(&mut l, &mut r);
            assert!(!lim.is_bypassed());
            lim.reset();
            assert_eq!(lim, Limiter::new(96_000.0, ms));
        }
    }

    #[test]
    fn configure_clears_the_line_only_when_the_latency_changes() {
        let mut lim = Limiter::new(48_000.0, 1.5);
        let (mut l, mut r) = ([0.5f32; Q], [0.5f32; Q]);
        lim.process(&mut l, &mut r);
        let before = lim;
        lim.configure(48_000.0, 1.5);
        assert_eq!(lim, before, "same latency: nothing cleared");
        lim.configure(48_000.0, 0.0);
        assert_eq!(lim, Limiter::new(48_000.0, 0.0));
    }

    /// A2.8's limiter as merged (#105), kept here to show the 0 ms path is it, bit for bit.
    fn a28(rate: f32, l: &mut [f32], r: &mut [f32]) {
        let hold_frames = libm::roundf(HOLD_S * rate) as u32;
        let release = libm::expf(-1.0 / (RELEASE_S * rate));
        let (mut reduction, mut hold) = (0.0f32, 0u32);
        for (ql, qr) in l.chunks_mut(Q).zip(r.chunks_mut(Q)) {
            if reduction == 0.0 && ql.iter().chain(qr.iter()).all(|x| x.abs() <= CEILING) {
                continue;
            }
            for i in 0..ql.len() {
                let (a, b) = (ql[i], qr[i]);
                let peak = if a.abs() > b.abs() { a.abs() } else { b.abs() };
                let need = if peak > CEILING { 1.0 - CEILING / peak } else { 0.0 };
                if need >= SNAP && need >= reduction {
                    reduction = need;
                    hold = hold_frames;
                } else if hold > 0 {
                    hold -= 1;
                } else if reduction > 0.0 {
                    reduction *= release;
                    if reduction < SNAP {
                        reduction = 0.0;
                    }
                }
                let g = 1.0 - reduction;
                ql[i] = clamp(a * g);
                qr[i] = clamp(b * g);
            }
        }
    }

    #[test]
    fn zero_ms_is_a28_bit_for_bit() {
        for rate in RATES {
            let n = rate as usize;
            // Bursts of summed tones at changing levels, with quiet gaps and a NaN.
            let mut l: Vec<f32> = (0..n)
                .map(|i| {
                    let t = i as f32 / rate;
                    let level = [0.3, 1.7, 0.9, 3.5, 0.0, 1.05][(i * 6 / n) % 6];
                    level * (libm::sinf(2.0 * core::f32::consts::PI * 220.0 * t) + 0.5 * libm::sinf(2.0 * core::f32::consts::PI * 1_337.0 * t))
                })
                .collect();
            let mut r: Vec<f32> = l.iter().enumerate().map(|(i, x)| x * if i % 3 == 0 { -0.8 } else { 0.6 }).collect();
            l[n / 3] = f32::NAN;
            let (ol, or, _) = run(rate, 0.0, &l, &r);
            a28(rate, &mut l, &mut r);
            assert!(ol.iter().zip(&l).all(|(a, b)| a.to_bits() == b.to_bits()), "left at {rate}");
            assert!(or.iter().zip(&r).all(|(a, b)| a.to_bits() == b.to_bits()), "right at {rate}");
        }
    }

    #[test]
    fn the_attack_ramps_linearly_over_the_lookahead_and_lands_on_the_peak() {
        let rate = 48_000.0;
        let d = latency_frames(rate, 1.5) as usize;
        // 0.5 DC, then a jump to 2.0 (needs 6 dB) at frame 1000.
        let x: Vec<f32> = (0..2_048).map(|i| if i < 1_000 { 0.5 } else { 2.0 }).collect();
        let (ol, _, _) = run(rate, 1.5, &x, &x.clone());
        // Untouched until D frames before the step leaves the delay.
        assert!(ol[d..1_000].iter().all(|v| *v == 0.5));
        // Then the gain falls in D equal steps of 0.5 / (D + 1) …
        for k in 0..d {
            let g = 1.0 - 0.5 * (k + 1) as f32 / (d + 1) as f32;
            let got = ol[1_000 + k] / 0.5;
            assert!((got - g).abs() < 1e-6, "frame {k} of the ramp: {got} vs {g}");
        }
        // … and is exactly 0.5 when the step arrives: the output sits on the ceiling from there.
        assert!(ol[1_000 + d..].iter().all(|v| *v == CEILING));
    }

    /// The point of the look-ahead: an over on a sine comes out as the sine scaled down, not
    /// clipped. The output is compared with the input scaled by the gain the limiter settles on;
    /// the instant attack (0 ms, A2.8) flattens the first overshooting half-cycle.
    #[test]
    fn the_lookahead_attack_does_not_reshape_the_waveform() {
        let rate = 48_000.0;
        for hz in [100.0f32, 440.0, 1_000.0] {
            let n = 9_600; // 200 ms
            let mut x = vec![0.0f32; n];
            // Silence, then a sine 6 dB over full scale from a zero crossing at frame 2400.
            let onset = 2_400;
            for (i, v) in x[onset..].iter_mut().enumerate() {
                *v = 2.0 * libm::sinf(2.0 * core::f32::consts::PI * hz * i as f32 / rate);
            }
            let measure = |ms: f32| {
                let d = latency_frames(rate, ms) as usize;
                let (ol, _, _) = run(rate, ms, &x, &x.clone());
                let g = 0.5; // the settled gain: 1 / peak
                // Over the first 20 ms of the tone (the attack), as heard.
                let (mut err, mut sig, mut max) = (0.0f64, 0.0f64, 0.0f32);
                for i in onset..onset + 960 {
                    let want = g * x[i];
                    let e = ol[i + d] - want;
                    err += (e as f64).powi(2);
                    sig += (want as f64).powi(2);
                    max = max.max(e.abs());
                }
                (10.0 * (err / sig).log10(), max)
            };
            let (instant_db, instant_max) = measure(0.0);
            let (ahead_db, ahead_max) = measure(DEFAULT_LOOKAHEAD_MS);
            println!("{hz} Hz, 6 dB over: error vs the scaled sine over the first 20 ms: instant {instant_db:.1} dB (max {instant_max:.3}), look-ahead {ahead_db:.1} dB (max {ahead_max:.3})");
            assert!(ahead_db < instant_db - 6.0, "{hz} Hz: {ahead_db} dB vs {instant_db} dB");
            assert!(ahead_max < instant_max / 3.0, "{hz} Hz: {ahead_max} vs {instant_max}");
        }
    }
}
