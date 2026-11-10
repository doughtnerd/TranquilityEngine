// SPDX-License-Identifier: Apache-2.0 OR MIT
//! The HRTF panner: a port of Blink's `HRTFPanner`, `HRTFKernel`, `HRTFElevation` and
//! `HRTFDatabase` (api-and-models §5, the `hrtf` port row; task H1, data H2).
//!
//! Kept from Chromium: the azimuth/elevation index and interpolation (`elevation_index`), the
//! kernel interpolation between the 15° raw azimuths in the frequency domain (`kernel`), the
//! interaural delay (`delay`, a port of `Delay::ProcessKRate`) and the two-kernel crossfade over
//! about 45 ms (`panner`).
//!
//! Re-done here:
//! - **Convolution** (`convolver`): uniform 128-frame partitions on a 256-point real FFT (`fft`, on the reverb's transform, H3),
//!   with one frequency-domain delay line per ear shared by both kernel sets, instead of Chromium's
//!   `FFTConvolver` (512-point FFT, 256-frame blocks). Two consequences, both deliberate:
//!   the port has no convolver latency (Chromium's adds `fft_size / 2` frames, 256 at 44.1 and
//!   48 kHz), and a kernel set that resumes after sitting idle convolves the true input history
//!   (Chromium's idle `FFTConvolver` resumes with stale state). On a fixed direction the output
//!   equals Chromium's advanced by `fft_size / 2` frames, to float rounding.
//! - **Kernels on demand** (`kernel`): Chromium precomputes 10 elevations x 192 azimuths x 2 ears
//!   of 512-point spectra at load (about 8 MB). The port computes a kernel set's two spectra when
//!   its direction index changes, so at most 4 kernel computations per quantum (2 sets x 2 ears).
//! - **Data** (`database`): the HRIRs come as one `format = 2` clip (api-and-models §4.1), int16 at
//!   the context rate with the leading delay already removed and stored in the ear-delay table.
//!   Resampling and delay extraction happen before upload (H2); `kernel::extract_average_group_delay`
//!   is the port of the extraction for that tool.
//!
//! Nothing in the process path allocates: the panner is a fixed-size value sized by its partition
//! count (`HrtfPannerN<P>`: `HrtfPanner`, 4 partitions, for every rate below 176.4 kHz;
//! `HrtfPannerN<2>` below 88.2 kHz), kernel-computation buffers live in a shared `HrtfScratch`,
//! and the database is a borrowed byte slice. Transcendentals go through `libm`.

pub mod convolver;
pub mod database;
pub mod delay;
pub mod elevation_index;
pub mod fft;
pub mod kernel;
pub mod panner;

pub use database::{HrirDatabase, HrirError, HrirHeader};
pub use kernel::HrtfScratch;
pub use panner::{partitions_for_sample_rate, HrtfPanner, HrtfPannerN, UnsupportedSampleRate};

/// Frames per render quantum, which is also the partition length.
pub const QUANTUM_FRAMES: usize = 128;
/// The partition FFT size: two partitions' worth of frames (overlap-save).
pub const PARTITION_FFT_SIZE: usize = 256;
/// Packed bins of a 256-point real FFT (microfft's layout: DC in `re` and Nyquist in `im` of bin 0).
pub const PARTITION_BINS: usize = PARTITION_FFT_SIZE / 2;
/// The most partitions a kernel can have: 512 taps, the kernel length below 176.4 kHz.
pub const MAX_PARTITIONS: usize = 4;
/// The longest kernel, in frames (`fft_size / 2` at the largest supported `fft_size`).
pub const MAX_KERNEL_FRAMES: usize = MAX_PARTITIONS * QUANTUM_FRAMES;
/// The largest kernel FFT size (`HRTFPanner::FftSizeForSampleRate`) the port supports.
pub const MAX_FFT_SIZE: usize = 2 * MAX_KERNEL_FRAMES;

/// Which ear a kernel, delay or impulse response belongs to. The value is the channel index in
/// the `format = 2` data (0 left, 1 right).
#[repr(u8)]
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Ear {
    Left = 0,
    Right = 1,
}

/// `std::lerp(a, b, t)` for `double`, as libc++ implements it (Chromium builds with libc++):
/// exact at `t == 0` and `t == 1`, and monotonic.
#[inline]
pub fn lerp_f64(a: f64, b: f64, t: f64) -> f64 {
    if (a <= 0.0 && b >= 0.0) || (a >= 0.0 && b <= 0.0) {
        return t * b + (1.0 - t) * a;
    }
    if t == 1.0 {
        return b;
    }
    let x = a + t * (b - a);
    if (t > 1.0) == (b > a) {
        if b < x { x } else { b }
    } else if x < b {
        x
    } else {
        b
    }
}

/// `std::lerp(a, b, t)` for `float` (see [`lerp_f64`]).
#[inline]
pub fn lerp_f32(a: f32, b: f32, t: f32) -> f32 {
    if (a <= 0.0 && b >= 0.0) || (a >= 0.0 && b <= 0.0) {
        return t * b + (1.0 - t) * a;
    }
    if t == 1.0 {
        return b;
    }
    let x = a + t * (b - a);
    if (t > 1.0) == (b > a) {
        if b < x { x } else { b }
    } else if x < b {
        x
    } else {
        b
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn lerp_is_exact_at_the_ends() {
        assert_eq!(lerp_f64(0.3, 7.1, 0.0), 0.3);
        assert_eq!(lerp_f64(0.3, 7.1, 1.0), 7.1);
        assert_eq!(lerp_f32(-2.5, 3.0, 1.0), 3.0);
        assert_eq!(lerp_f32(1.0, 3.0, 0.5), 2.0);
    }
}
