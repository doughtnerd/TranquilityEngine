//! The generators' `high` quality band-limiting (D67, owner: "Make it a setting"): a minimum-phase band-limited step
//! (minBLEP) of [`TAPS`] taps read from a table, beside the two-sample PolyBLEP of `standard` (`osc.rs`).
//!
//! **Why this method.** Measured against `standard` (the worst alias bin against the fundamental, 48 kHz, saw at 246 Hz,
//! 1.23 kHz and 3.53 kHz): PolyBLEP leaves −45, −34 and −25 dB. A 2× oversampled oscillator through a half-band filter
//! can't reach −45 dB at 3.5 kHz (a half-band filter is −6 dB at a quarter of its rate, where that saw's 7th harmonic
//! sits). A 16-tap minBLEP from a Kaiser-windowed sinc (cut-off 0.40 of the rate, β 6) reaches about −80, −76 and −70 dB
//! for saw and pulse (the triangle, by its integrated residual, below −85 dB), is flat to 14 kHz (−0.7 dB at 16 kHz,
//! −3 dB at 18 kHz) and costs a table read of 16 taps per discontinuity (four lanes at a time on wasm) and a ring read
//! and write per sample. The table is `minblep_table.rs` (`tools/minblep-table.mjs`).
//!
//! **How it is read.** The kernel's centroid is shifted to a whole number of samples, [`DELAY`]: an oscillator writes its
//! naive waveform into a [`Ring`] `DELAY` samples ahead ([`Ring::push`]) and adds a residual at each discontinuity from
//! the sample after it ([`Ring::edge`] for a jump, [`Ring::corner`] for a change of slope), so the output is the
//! band-limited waveform `DELAY` samples late (2 samples, 42 µs at 48 kHz). Both residuals return to 0 inside the table,
//! and a jump's own step falls on a whole tap, so the result is exact however the phase rounds.

pub use super::minblep_table::{DELAY, PHASES, TAPS};
use super::minblep_table::{RAMP, STEP};

/// The ring's linear span: residuals are written at `pos..pos + TAPS`; when that would pass the end, the live window
/// slides to the front (once every `BUF - TAPS` samples).
const BUF: usize = 48;

/// One oscillator's residuals and delayed naive waveform. All-zero is an empty ring.
#[repr(C)]
#[derive(Clone, Copy, Debug)]
pub struct Ring {
    buf: [f32; BUF],
    pos: u32,
}

impl Default for Ring {
    fn default() -> Ring {
        Ring { buf: [0.0; BUF], pos: 0 }
    }
}

impl Ring {
    /// Empties the ring.
    pub fn clear(&mut self) {
        *self = Ring::default();
    }

    /// Fills the delay with `value` (switching to `high` mid-sound holds the last value for [`DELAY`] samples instead of
    /// dropping to 0).
    pub fn prime(&mut self, value: f32) {
        let p = self.pos as usize;
        for v in &mut self.buf[p..p + DELAY] {
            *v = value;
        }
    }

    /// A jump of `height` `tau` samples before this sample (0 ≤ `tau` < 1): its residual from this sample on.
    #[inline(always)]
    pub fn edge(&mut self, tau: f64, height: f32) {
        self.add(&STEP, tau, height);
    }

    /// A change of slope of `height` per sample `tau` samples before this sample: its residual from this sample on.
    #[inline(always)]
    pub fn corner(&mut self, tau: f64, height: f32) {
        self.add(&RAMP, tau, height);
    }

    #[inline(always)]
    fn add(&mut self, table: &[[f32; TAPS]; PHASES + 1], tau: f64, height: f32) {
        let x = (tau as f32 * PHASES as f32).clamp(0.0, PHASES as f32);
        let j = (x as usize).min(PHASES - 1);
        let f = x - j as f32;
        let (a, b) = (&table[j], &table[j + 1]);
        let p = self.pos as usize;
        let w: &mut [f32; TAPS] = (&mut self.buf[p..p + TAPS]).try_into().unwrap_or_else(|_| unreachable!());
        #[cfg(all(target_arch = "wasm32", target_feature = "simd128"))]
        {
            use core::arch::wasm32::*;
            let (fv, hv) = (f32x4_splat(f), f32x4_splat(height));
            for i in (0..TAPS).step_by(4) {
                // SAFETY: `i + 4 <= TAPS`, the length of `a`, `b` and `w`; wasm's v128 loads and stores take any
                // alignment.
                unsafe {
                    let av = v128_load(a.as_ptr().add(i) as *const v128);
                    let bv = v128_load(b.as_ptr().add(i) as *const v128);
                    let r = f32x4_add(av, f32x4_mul(fv, f32x4_sub(bv, av)));
                    let o = w.as_mut_ptr().add(i) as *mut v128;
                    v128_store(o, f32x4_add(v128_load(o as *const v128), f32x4_mul(hv, r)));
                }
            }
        }
        #[cfg(not(all(target_arch = "wasm32", target_feature = "simd128")))]
        for i in 0..TAPS {
            w[i] += height * (a[i] + f * (b[i] - a[i]));
        }
    }

    /// This sample's naive value in, the band-limited output ([`DELAY`] samples late) out.
    #[inline(always)]
    pub fn push(&mut self, naive: f32) -> f32 {
        let p = self.pos as usize;
        self.buf[p + DELAY] += naive;
        let y = self.buf[p];
        let mut next = p + 1;
        if next + TAPS > BUF {
            core::hint::cold_path();
            // The live window (`next..BUF`) to the front, the rest cleared.
            self.buf.copy_within(next..BUF, 0);
            self.buf[BUF - next..].fill(0.0);
            next = 0;
        }
        self.pos = next as u32;
        y
    }
}
